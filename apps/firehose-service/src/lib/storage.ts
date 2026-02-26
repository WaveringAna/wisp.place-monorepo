/**
 * S3-only storage for firehose-service
 * Writes directly to cold tier (S3) - hosting-service pulls to warm/hot as needed
 */

import {
  TieredStorage,
  S3StorageTier,
  DiskStorageTier,
} from '@wispplace/tiered-storage';
import { createLogger } from '@wispplace/observability';
import { config } from '../config';

const logger = createLogger('firehose-service');

// Create S3 tier (or fallback to disk for local dev)
let coldTier: S3StorageTier | DiskStorageTier;

if (config.s3Bucket) {
  coldTier = new S3StorageTier({
    bucket: config.s3Bucket,
    region: config.s3Region,
    endpoint: config.s3Endpoint,
    credentials: config.awsAccessKeyId && config.awsSecretAccessKey
      ? {
          accessKeyId: config.awsAccessKeyId,
          secretAccessKey: config.awsSecretAccessKey,
        }
      : undefined,
    prefix: config.s3Prefix,
    forcePathStyle: config.s3ForcePathStyle,
  });
  logger.info('[Storage] Using S3 cold tier:', { bucket: config.s3Bucket });
} else {
  // Fallback to disk for local development
  const cacheDir = process.env.CACHE_DIR || './cache/sites';
  coldTier = new DiskStorageTier({
    directory: cacheDir,
    maxSizeBytes: 10 * 1024 * 1024 * 1024, // 10GB
    evictionPolicy: 'lru',
    encodeColons: false,
  });
  logger.info('[Storage] Using disk fallback (no S3_BUCKET configured):', { cacheDir });
}

// Identity serializers for raw binary data (no JSON transformation)
const identitySerialize = async (data: unknown): Promise<Uint8Array> => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  // Fallback for other types
  return new TextEncoder().encode(JSON.stringify(data));
};

const identityDeserialize = async (data: Uint8Array): Promise<unknown> => {
  return data;
};

// TieredStorage with only cold tier configured
// We use onlyTiers: ['cold'] on every write anyway, but this setup
// means we don't need hot/warm tiers at all
export const storage = new TieredStorage<Uint8Array>({
  tiers: {
    cold: coldTier,
  },
  compression: false, // Files may already be compressed
  serialization: {
    serialize: identitySerialize,
    deserialize: identityDeserialize,
  },
});

/**
 * Write a file to S3 (cold tier only)
 */
export async function writeFile(
  key: string,
  data: Uint8Array,
  metadata?: Record<string, string>
): Promise<void> {
  await storage.set(key, data, {
    onlyTiers: ['cold'],
    metadata,
  });
}

/**
 * Delete a file from S3
 */
export async function deleteFile(key: string): Promise<void> {
  await storage.delete(key);
}

/**
 * Delete multiple files from S3
 */
export async function deleteFiles(keys: string[]): Promise<void> {
  await Promise.all(keys.map(key => storage.delete(key)));
}

/**
 * Check if a file exists in S3
 */
export async function fileExists(key: string): Promise<boolean> {
  return await storage.exists(key);
}

/**
 * List all files with a given prefix
 */
export async function listFiles(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of storage.listKeys(prefix)) {
    keys.push(key);
  }
  return keys;
}
