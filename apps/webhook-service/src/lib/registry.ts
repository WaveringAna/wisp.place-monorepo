import { LRUCache } from 'lru-cache';
import type { WebhookEntry } from './db';

/**
 * LRU cache of DB query results, keyed by scope DID or `'__backlinks__'`.
 * Avoids hitting the DB on every firehose event for DIDs with no webhooks.
 * Invalidated when a place.wisp.v2.wh record changes for a given DID.
 */
const cache = new LRUCache<string, WebhookEntry[]>({
  max: parseInt(process.env.WEBHOOK_CACHE_MAX || '1000', 10),
  ttl: parseInt(process.env.WEBHOOK_CACHE_TTL_MS || '60000', 10),
});

export function getCached(scopeDid: string): WebhookEntry[] | undefined {
  return cache.get(scopeDid);
}

export function setCached(scopeDid: string, entries: WebhookEntry[]): void {
  cache.set(scopeDid, entries);
}

export function invalidate(scopeDid: string): void {
  cache.delete(scopeDid);
}
