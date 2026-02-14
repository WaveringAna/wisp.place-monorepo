/**
 * Cache invalidation publisher
 *
 * Publishes invalidation messages to Redis pub/sub so the hosting-service
 * can clear its local caches (tiered storage, redirect rules) when a site
 * is updated or deleted via the firehose.
 */

import Redis from 'ioredis';
import { config } from '../config';

const CHANNEL = 'wisp:cache-invalidate';

let publisher: Redis | null = null;
let loggedMissingRedis = false;

function getPublisher(): Redis | null {
  if (!config.redisUrl) {
    if (!loggedMissingRedis) {
      console.warn('[CacheInvalidation] REDIS_URL not set; cache invalidation publishing disabled');
      loggedMissingRedis = true;
    }
    return null;
  }

  if (!publisher) {
    publisher = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });

    publisher.on('error', (err) => {
      console.error('[CacheInvalidation] Redis error:', err);
    });
  }

  return publisher;
}

export async function publishCacheInvalidation(
  did: string,
  rkey: string,
  action: 'update' | 'delete' | 'settings'
): Promise<void> {
  const redis = getPublisher();
  if (!redis) return;

  try {
    const message = JSON.stringify({ did, rkey, action });
    await redis.publish(CHANNEL, message);
  } catch (err) {
    console.error('[CacheInvalidation] Failed to publish:', err);
  }
}

export async function closeCacheInvalidationPublisher(): Promise<void> {
  if (publisher) {
    const toClose = publisher;
    publisher = null;
    await toClose.quit();
  }
}
