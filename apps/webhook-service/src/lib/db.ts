import { SQL } from 'bun';
import { createLogger } from '@wispplace/observability';
import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh';

/** A webhook entry as returned from the DB, with ownership info split out from the KV key. */
export interface WebhookEntry {
  ownerDid: string;
  rkey: string;
  record: WhRecord;
}

const logger = createLogger('webhook-service:db');

export const db = new SQL(
  process.env.DATABASE_URL ||
    (process.env.NODE_ENV === 'production'
      ? (() => { throw new Error('DATABASE_URL is required in production'); })()
      : 'postgres://postgres:postgres@localhost:5432/wisp')
);

// Create tables on startup
await db`
  CREATE TABLE IF NOT EXISTS webhooks (
    did       TEXT NOT NULL,
    rkey      TEXT NOT NULL,
    url       TEXT NOT NULL,
    scope_aturi TEXT NOT NULL,
    enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
    updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
    PRIMARY KEY (did, rkey)
  )
`;

await db`
  CREATE TABLE IF NOT EXISTS webhook_records (
    k          TEXT PRIMARY KEY,
    v          JSONB NOT NULL,
    updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())
  )
`;

/**
 * Find all webhook records whose scope AT-URI targets the given DID.
 * Matches exact DID scope (`at://did`) and collection/rkey sub-scopes (`at://did/...`).
 * Used as the primary lookup when a firehose event arrives from a DID.
 */
export async function findWebhooksForDid(scopeDid: string): Promise<WebhookEntry[]> {
  const exact = `at://${scopeDid}`;
  const prefix = `at://${scopeDid}/`;
  const rows = await db<Array<{ k: string; v: WhRecord }>>`
    SELECT k, v FROM webhook_records
    WHERE v->'scope'->>'aturi' = ${exact}
       OR starts_with(v->'scope'->>'aturi', ${prefix})
  `;
  return rows.map(row => {
    const slash = row.k.indexOf('/');
    return {
      ownerDid: row.k.slice(0, slash),
      rkey: row.k.slice(slash + 1),
      record: row.v,
    };
  });
}

/**
 * Find all webhook records that have backlinks enabled.
 * These are checked against every firehose event to see if the record body
 * references the webhook's scoped DID/collection.
 */
export async function findBacklinkWebhooks(): Promise<WebhookEntry[]> {
  const rows = await db<Array<{ k: string; v: WhRecord }>>`
    SELECT k, v FROM webhook_records
    WHERE (v->'scope'->>'backlinks')::boolean = true
  `;
  return rows.map(row => {
    const slash = row.k.indexOf('/');
    return {
      ownerDid: row.k.slice(0, slash),
      rkey: row.k.slice(slash + 1),
      record: row.v,
    };
  });
}

/** Load all webhook records. Used for diagnostics/admin views. */
export async function loadAllWebhooks(): Promise<Array<{ did: string; rkey: string; record: WhRecord }>> {
  const rows = await db<Array<{ k: string; v: WhRecord }>>`
    SELECT k, v FROM webhook_records
  `;
  return rows.map(row => {
    const [did, rkey] = row.k.split('/') as [string, string];
    return { did, rkey, record: row.v };
  });
}

/**
 * Insert or update a webhook record in both tables.
 * `webhooks` holds structured columns for quick filtering; `webhook_records` holds the full JSONB record.
 * Key is `did/rkey`.
 */
export async function upsertWebhookRecord(did: string, rkey: string, record: WhRecord): Promise<void> {
  const k = `${did}/${rkey}`;
  try {
    await db`
      INSERT INTO webhooks (did, rkey, url, scope_aturi, enabled, created_at, updated_at)
      VALUES (${did}, ${rkey}, ${record.url}, ${record.scope.aturi}, ${record.enabled ?? true},
              EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
      ON CONFLICT (did, rkey) DO UPDATE SET
        url        = EXCLUDED.url,
        scope_aturi = EXCLUDED.scope_aturi,
        enabled    = EXCLUDED.enabled,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `;
    await db`
      INSERT INTO webhook_records (k, v, updated_at)
      VALUES (${k}, ${record}, EXTRACT(EPOCH FROM NOW()))
      ON CONFLICT (k) DO UPDATE SET
        v          = EXCLUDED.v,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `;
  } catch (err) {
    logger.error(`[DB] upsertWebhookRecord error for ${k}`, err);
    throw err;
  }
}

/** Remove a webhook record from both tables. Called when a place.wisp.v2.wh delete event arrives. */
export async function deleteWebhookRecord(did: string, rkey: string): Promise<void> {
  const k = `${did}/${rkey}`;
  try {
    await db`DELETE FROM webhooks WHERE did = ${did} AND rkey = ${rkey}`;
    await db`DELETE FROM webhook_records WHERE k = ${k}`;
  } catch (err) {
    logger.error(`[DB] deleteWebhookRecord error for ${k}`, err);
    throw err;
  }
}

/** Close all database connections gracefully. */
export async function closeDatabase(): Promise<void> {
  await db.close();
  logger.info('[DB] Database connections closed');
}
