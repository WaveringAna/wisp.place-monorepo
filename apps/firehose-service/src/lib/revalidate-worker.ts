import Redis from 'ioredis';
import os from 'os';
import { config } from '../config';
import { fetchSiteRecord, handleSiteCreateOrUpdate } from './cache-writer';

const consumerName = process.env.WISP_REVALIDATE_CONSUMER || `${os.hostname()}:${process.pid}`;
const batchSize = Number.parseInt(process.env.WISP_REVALIDATE_BATCH_SIZE || '10', 10);
const claimIdleMs = Number.parseInt(process.env.WISP_REVALIDATE_CLAIM_IDLE_MS || '60000', 10);
const blockMs = Number.parseInt(process.env.WISP_REVALIDATE_BLOCK_MS || '5000', 10);

let redis: Redis | null = null;
let running = false;
let loopPromise: Promise<void> | null = null;

function parseFields(raw: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i];
    const value = raw[i + 1];
    if (key) {
      fields[key] = value ?? '';
    }
  }
  return fields;
}

async function processMessage(id: string, rawFields: string[]): Promise<void> {
  if (!redis) return;

  const fields = parseFields(rawFields);
  const did = fields.did;
  const rkey = fields.rkey;
  const reason = fields.reason || 'storage-miss';

  if (!did || !rkey) {
    console.warn('[Revalidate] Missing did/rkey in message', { id, fields });
    await redis.xack(config.revalidateStream, config.revalidateGroup, id);
    return;
  }

  console.log(`[Revalidate] Received message ${id}: ${did}/${rkey} (${reason})`);

  const record = await fetchSiteRecord(did, rkey);
  if (!record) {
    console.warn(`[Revalidate] Site record not found on PDS: ${did}/${rkey}`);
    await redis.xack(config.revalidateStream, config.revalidateGroup, id);
    return;
  }

  await handleSiteCreateOrUpdate(did, rkey, record.record, record.cid);

  console.log(`[Revalidate] Completed ${id}: ${did}/${rkey}`);
  await redis.xack(config.revalidateStream, config.revalidateGroup, id);
}

async function processMessages(messages: Array<[string, string[]]>): Promise<void> {
  for (const [id, rawFields] of messages) {
    try {
      await processMessage(id, rawFields);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[Revalidate] Failed to process message', { id, error: error.message, stack: error.stack });
    }
  }
}

async function ensureGroup(): Promise<void> {
  if (!redis) return;
  try {
    await redis.xgroup('CREATE', config.revalidateStream, config.revalidateGroup, '0', 'MKSTREAM');
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!error.message.includes('BUSYGROUP')) {
      throw error;
    }
  }
}

async function claimStaleMessages(): Promise<void> {
  if (!redis) return;

  let startId = '0-0';

  while (running) {
    const response = (await redis.xautoclaim(
      config.revalidateStream,
      config.revalidateGroup,
      consumerName,
      claimIdleMs,
      startId,
      'COUNT',
      batchSize
    )) as unknown as [string, Array<[string, string[]]>];

    const nextId = response[0];
    const messages = response[1] || [];

    if (messages.length === 0) {
      break;
    }

    await processMessages(messages);

    if (nextId === startId) {
      break;
    }
    startId = nextId;
  }
}

async function readNewMessages(): Promise<void> {
  if (!redis) return;

  const response = await redis.xreadgroup(
    'GROUP',
    config.revalidateGroup,
    consumerName,
    'COUNT',
    batchSize,
    'BLOCK',
    blockMs,
    'STREAMS',
    config.revalidateStream,
    '>'
  ) as [string, Array<[string, string[]]>][] | null;

  if (!response) return;

  for (const [, messages] of response) {
    await processMessages(messages);
  }
}

async function runLoop(): Promise<void> {
  if (!redis) return;

  await ensureGroup();

  while (running) {
    try {
      await claimStaleMessages();
      await readNewMessages();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[Revalidate] Loop error', { error: error.message, stack: error.stack });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export async function startRevalidateWorker(): Promise<void> {
  if (!config.redisUrl) {
    console.warn('[Revalidate] REDIS_URL not set; revalidate worker disabled');
    return;
  }

  if (running) return;

  console.log(`[Revalidate] Connecting to Redis: ${config.redisUrl}`);
  redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
  });

  redis.on('error', (err) => {
    console.error('[Revalidate] Redis error:', err);
  });

  redis.on('ready', () => {
    console.log(`[Revalidate] Redis connected, stream: ${config.revalidateStream}, group: ${config.revalidateGroup}`);
  });

  running = true;
  loopPromise = runLoop();
}

export async function stopRevalidateWorker(): Promise<void> {
  running = false;
  await loopPromise;
  loopPromise = null;

  if (redis) {
    const toClose = redis;
    redis = null;
    await toClose.quit();
  }
}
