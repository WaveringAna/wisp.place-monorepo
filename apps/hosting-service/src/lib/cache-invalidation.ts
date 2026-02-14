/**
 * Cache invalidation subscriber
 *
 * Listens to Redis pub/sub for cache invalidation messages from the firehose-service.
 * When a site is updated/deleted, clears the hosting-service's local caches
 * (tiered storage hot+warm tiers, redirect rules) so stale data isn't served.
 */

import Redis from 'ioredis';
import { storage } from './storage';
import { clearRedirectRulesCache } from './site-cache';

const CHANNEL = 'wisp:cache-invalidate';

let subscriber: Redis | null = null;

export function startCacheInvalidationSubscriber(): void {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('[CacheInvalidation] REDIS_URL not set; cache invalidation disabled');
    return;
  }

  subscriber = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });

  subscriber.on('error', (err) => {
    console.error('[CacheInvalidation] Redis error:', err);
  });

  subscriber.subscribe(CHANNEL, (err) => {
    if (err) {
      console.error('[CacheInvalidation] Failed to subscribe:', err);
    } else {
      console.log('[CacheInvalidation] Subscribed to', CHANNEL);
    }
  });

  subscriber.on('message', async (_channel: string, message: string) => {
    try {
      const { did, rkey, action } = JSON.parse(message) as {
        did: string;
        rkey: string;
        action: 'update' | 'delete' | 'settings';
      };

      if (!did || !rkey) {
        console.warn('[CacheInvalidation] Invalid message:', message);
        return;
      }

      console.log(`[CacheInvalidation] Invalidating ${did}/${rkey} (${action})`);

      // Clear tiered storage (hot + warm) for this site
      const prefix = `${did}/${rkey}/`;
      const deleted = await storage.invalidate(prefix);
      console.log(`[CacheInvalidation] Cleared ${deleted} keys from tiered storage for ${did}/${rkey}`);

      // Clear redirect rules cache
      clearRedirectRulesCache(did, rkey);
    } catch (err) {
      console.error('[CacheInvalidation] Error processing message:', err);
    }
  });
}

export async function stopCacheInvalidationSubscriber(): Promise<void> {
  if (subscriber) {
    const toClose = subscriber;
    subscriber = null;
    await toClose.quit();
  }
}
