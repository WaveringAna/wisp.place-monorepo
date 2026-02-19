/**
 * Cache invalidation subscriber
 *
 * Listens to Redis pub/sub for cache invalidation messages from the firehose-service.
 * When a site is updated/deleted, clears the hosting-service's local caches
 * (tiered storage hot+warm tiers, redirect rules) so stale data isn't served.
 */

import Redis from 'ioredis';
import type { StorageTier } from '@wispplace/tiered-storage';
import { hotTier, warmTier } from './storage';
import { cache } from './cache-manager';

const CHANNEL = 'wisp:cache-invalidate';

let subscriber: Redis | null = null;

/**
 * Directly invalidate a tier by listing and deleting all keys with the given prefix.
 * Each tier is invalidated independently so a failure in one doesn't block the others.
 */
async function invalidateTier(
  tier: StorageTier,
  tierName: string,
  prefix: string,
): Promise<number> {
  try {
    const keys: string[] = [];
    for await (const key of tier.listKeys(prefix)) {
      keys.push(key);
    }
    if (keys.length > 0) {
      await tier.deleteMany(keys);
    }
    return keys.length;
  } catch (err) {
    console.error(`[CacheInvalidation] Failed to invalidate ${tierName} tier for prefix ${prefix}:`, err);
    return 0;
  }
}

export function startCacheInvalidationSubscriber(): void {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('[CacheInvalidation] REDIS_URL not set; cache invalidation disabled');
    return;
  }

  console.log(`[CacheInvalidation] Connecting to Redis for subscribing: ${redisUrl}`);
  subscriber = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });

  subscriber.on('error', (err) => {
    console.error('[CacheInvalidation] Redis error:', err);
  });

  subscriber.on('ready', () => {
    console.log('[CacheInvalidation] Redis subscriber connected');
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

      const prefix = `${did}/${rkey}/`;

      // Invalidate each tier independently - a failure in one tier
      // (e.g. S3 listKeys timeout) must NOT prevent hot/warm from being cleared
      const hotDeleted = await invalidateTier(hotTier, 'hot', prefix);
      const warmDeleted = warmTier
        ? await invalidateTier(warmTier, 'warm', prefix)
        : 0;

      console.log(
        `[CacheInvalidation] Cleared ${hotDeleted} hot + ${warmDeleted} warm keys for ${did}/${rkey}`,
      );

      // Clear in-memory caches for this site
      cache.delete('redirectRules', `${did}:${rkey}`);
      cache.delete('settings', `${did}:${rkey}`);
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
