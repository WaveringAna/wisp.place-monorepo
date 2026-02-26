import Redis from 'ioredis';
import { recordRevalidateResult } from './revalidate-metrics';

const redisUrl = process.env.REDIS_URL;
const streamName = process.env.WISP_REVALIDATE_STREAM || 'wisp:revalidate';
const dedupeTtlSeconds = parsePositiveInt(process.env.WISP_REVALIDATE_DEDUPE_TTL_SECONDS, 60);
const storageMissDedupeTtlSeconds = parsePositiveInt(
  process.env.WISP_REVALIDATE_STORAGE_MISS_DEDUPE_TTL_SECONDS,
  Math.max(dedupeTtlSeconds, 600)
);

let client: Redis | null = null;
let loggedMissingRedis = false;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDedupeTtlSeconds(reasonCategory: 'storage-miss' | 'rewrite-miss' | 'other'): number {
  if (reasonCategory === 'storage-miss') {
    return storageMissDedupeTtlSeconds;
  }
  return dedupeTtlSeconds;
}

function getRedisClient(): Redis | null {
  if (!redisUrl) {
    if (!loggedMissingRedis) {
      console.warn('[Revalidate] REDIS_URL not set; skipping queue enqueue');
      loggedMissingRedis = true;
    }
    return null;
  }

  if (!client) {
    console.log(`[Revalidate] Connecting to Redis: ${redisUrl}`);
    client = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });

    client.on('error', (err) => {
      console.error('[Revalidate] Redis error:', err);
    });

    client.on('ready', () => {
      console.log(`[Revalidate] Redis connected, stream: ${streamName}`);
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
    // Separate dedup keys per reason category so a storage-miss is never
    // silenced by a pending rewrite-miss (which runs with forceDownload=false)
    const reasonCategory = reason.startsWith('storage-miss') ? 'storage-miss'
      : reason.startsWith('rewrite-miss') ? 'rewrite-miss'
      : 'other';
    const dedupeKey = `revalidate:site:${reasonCategory}:${did}:${rkey}`;
    const dedupeTtl = getDedupeTtlSeconds(reasonCategory);
    const set = await redis.set(dedupeKey, '1', 'EX', dedupeTtl, 'NX');
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

    console.log(`[Revalidate] Enqueued ${did}/${rkey} (${reason}) to ${streamName}`);
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
