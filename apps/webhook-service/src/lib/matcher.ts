import type { WebhookEntry } from './db';

export type EventKind = 'create' | 'update' | 'delete';

interface ParsedAtUri {
  did: string;
  collection?: string;
  rkey?: string;
}

function parseAtUri(aturi: string): ParsedAtUri | null {
  const withoutScheme = aturi.replace(/^at:\/\//, '');
  const parts = withoutScheme.split('/');
  const did = parts[0];
  if (!did) return null;
  return {
    did,
    collection: parts[1] || undefined,
    rkey: parts[2] || undefined,
  };
}

/** Matches a collection segment against a glob pattern */
function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(value);
}

/**
 * Checks whether a serialised record body contains a reference to the given DID/collection.
 * When collection contains a glob, scans for any `at://did/<collection>` URI that matches.
 */
function containsReference(record: unknown, did: string, collection?: string): boolean {
  const json = JSON.stringify(record);

  if (!collection) {
    return json.includes(`at://${did}`) || json.includes(`"${did}"`);
  }

  if (!collection.includes('*')) {
    return json.includes(`at://${did}/${collection}`);
  }

  // Glob collection: scan for all at://did/... URIs and match the collection segment
  const prefix = `at://${did}/`;
  let idx = json.indexOf(prefix);
  while (idx !== -1) {
    const rest = json.slice(idx + prefix.length);
    const end = rest.search(/[/"\\]/);
    const col = end === -1 ? rest : rest.slice(0, end);
    if (col && matchesGlob(collection, col)) return true;
    idx = json.indexOf(prefix, idx + prefix.length);
  }
  return false;
}

/**
 * Filters a set of webhook candidates against a firehose event.
 *
 * A webhook matches if:
 * - It is enabled
 * - The event kind is in its `events` filter (or no filter is set)
 * - **Direct match**: the event DID/collection/rkey falls within the webhook's scope AT-URI
 *   (collection supports glob patterns, e.g. `app.bsky.*`)
 * - **Backlink match**: `scope.backlinks` is true and the serialised record body contains
 *   a reference to the scope DID/collection
 */
export function matchWebhooks(
  webhooks: WebhookEntry[],
  eventDid: string,
  eventCollection: string,
  eventRkey: string,
  eventKind: EventKind,
  eventRecord: unknown,
): WebhookEntry[] {
  const matched: WebhookEntry[] = [];

  for (const entry of webhooks) {
    const { record } = entry;

    if (record.enabled === false) continue;

    if (record.events && record.events.length > 0) {
      if (!record.events.includes(eventKind)) continue;
    }

    const scope = parseAtUri(record.scope.aturi);
    if (!scope) continue;

    const backlinks = record.scope.backlinks === true;

    let directMatch = false;
    if (scope.did === eventDid) {
      if (!scope.collection) {
        directMatch = true;
      } else if (matchesGlob(scope.collection, eventCollection)) {
        if (!scope.rkey || scope.rkey === eventRkey) {
          directMatch = true;
        }
      }
    }

    if (directMatch) {
      matched.push(entry);
      continue;
    }

    if (backlinks && eventDid !== scope.did && eventRecord != null) {
      if (containsReference(eventRecord, scope.did, scope.collection)) {
        matched.push(entry);
      }
    }
  }

  return matched;
}
