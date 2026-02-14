import Redis from 'ioredis';
import { recordRevalidateResult } from './revalidate-metrics';

const redisUrl = process.env.REDIS_URL;
const streamName = process.env.WISP_REVALIDATE_STREAM || 'wisp:revalidate';
const dedupeTtlSeconds = Number.parseInt(process.env.WISP_REVALIDATE_DEDUPE_TTL_SECONDS || '60', 10);

let client: Redis | null = null;
let loggedMissingRedis = false;

function getRedisClient(): Redis | null {
  if (!redisUrl) {
    if (!loggedMissingRedis) {
      console.warn('[Revalidate] REDIS_URL not set; skipping queue enqueue');
      loggedMissingRedis = true;
    }
    return null;
  }

  if (!client) {
    client = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });

    client.on('error', (err) => {
      console.error('[Revalidate] Redis error:', err);
    });
  }

  return client;
}

export type EnqueueResult = 'enqueued' | 'deduped' | 'disabled' | 'error';

export async function enqueueRevalidate(
  did: string,
  rkey: string,
  reason: string
): Promise<{ enqueued: boolean; result: EnqueueResult }> {
  const redis = getRedisClient();
  if (!redis) {
    recordRevalidateResult('disabled');
    return { enqueued: false, result: 'disabled' };
  }

  try {
    const dedupeKey = `revalidate:site:${did}:${rkey}`;
    const set = await redis.set(dedupeKey, '1', 'EX', dedupeTtlSeconds, 'NX');
    if (!set) {
      recordRevalidateResult('deduped');
      return { enqueued: false, result: 'deduped' };
    }

    await redis.xadd(
      streamName,
      '*',
      'did',
      did,
      'rkey',
      rkey,
      'reason',
      reason,
      'ts',
      Date.now().toString()
    );

    recordRevalidateResult('enqueued');
    return { enqueued: true, result: 'enqueued' };
  } catch (err) {
    recordRevalidateResult('error');
    console.error('[Revalidate] Failed to enqueue', { did, rkey, reason, error: err });
    return { enqueued: false, result: 'error' };
  }
}

export async function closeRevalidateQueue(): Promise<void> {
  if (client) {
    const toClose = client;
    client = null;
    await toClose.quit();
  }
}
