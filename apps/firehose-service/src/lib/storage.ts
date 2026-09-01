/**
 * S3-only storage for firehose-service
 * Writes directly to cold tier (S3) - hosting-service pulls to warm/hot as needed
 */

import { createLogger } from '@wispplace/observability'
import { DiskStorageTier, S3StorageTier, TieredStorage } from '@wispplace/tiered-storage'
import { config } from '../config'
import { StorageStatsCache, type StorageStatsSnapshot } from './storage-stats-cache'

export {
	STORAGE_STATS_REFRESH_INTERVAL_MS,
	STORAGE_STATS_STALE_AFTER_MS,
	StorageStatsCache,
	type StorageStatsErrorKind,
	type StorageStatsFetcher,
	type StorageStatsSnapshot,
} from './storage-stats-cache'

const logger = createLogger('firehose-service')

// Create S3 tier (or fallback to disk for local dev)
let coldTier: S3StorageTier | DiskStorageTier

if (config.s3Bucket) {
	coldTier = new S3StorageTier({
		bucket: config.s3Bucket,
		region: config.s3Region,
		endpoint: config.s3Endpoint,
		credentials:
			config.awsAccessKeyId && config.awsSecretAccessKey
				? {
						accessKeyId: config.awsAccessKeyId,
						secretAccessKey: config.awsSecretAccessKey,
					}
				: undefined,
		prefix: config.s3Prefix,
		forcePathStyle: config.s3ForcePathStyle,
	})
	logger.info('[Storage] Using S3 cold tier', { endpointConfigured: Boolean(config.s3Endpoint), mode: 's3' })
} else {
	// Configuration only permits this explicit fallback in development/test.
	if (!config.allowDiskStorage) throw new Error('Disk storage fallback is not enabled')
	const cacheDir = process.env.CACHE_DIR || './cache/sites'
	coldTier = new DiskStorageTier({
		directory: cacheDir,
		maxSizeBytes: 10 * 1024 * 1024 * 1024, // 10GB
		evictionPolicy: 'lru',
		encodeColons: false,
	})
	logger.info('[Storage] Using disk fallback', { mode: 'disk' })
}

// Identity serializers for raw binary data (no JSON transformation)
const identitySerialize = async (data: unknown): Promise<Uint8Array> => {
	if (data instanceof Uint8Array) return data
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	if (Buffer.isBuffer(data)) return new Uint8Array(data)
	// Fallback for other types
	return new TextEncoder().encode(JSON.stringify(data))
}

const identityDeserialize = async (data: Uint8Array): Promise<unknown> => {
	return data
}

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
})

/**
 * S3 statistics require a full paginated ListObjects scan. The cache is started
 * explicitly by the service lifecycle, never by a health request or module import.
 */
const storageStatsCache = new StorageStatsCache(() => storage.getStats())

/** Returns an in-memory snapshot and never starts or awaits a storage scan. */
export function getStorageStatsSnapshot(): StorageStatsSnapshot {
	return storageStatsCache.getSnapshot()
}

/** Start the single background S3 statistics scan schedule. */
export function startStorageStatsRefresh(): void {
	storageStatsCache.start()
}

/** Stop future background scans without waiting for an in-flight provider call. */
export function stopStorageStatsRefresh(): void {
	storageStatsCache.stop()
}

/**
 * Write a file to S3 (cold tier only)
 */
export async function writeFile(key: string, data: Uint8Array, metadata?: Record<string, string>): Promise<void> {
	await storage.set(key, data, {
		onlyTiers: ['cold'],
		metadata,
	})
}

/**
 * Read object metadata from the cold source without buffering its body.
 */
export async function getFileMetadata(key: string) {
	return await coldTier.getMetadata(key)
}

/**
 * Delete a file from S3
 */
export async function deleteFile(key: string): Promise<void> {
	await storage.delete(key)
}

/**
 * List all files with a given prefix
 */
export async function listFiles(prefix: string): Promise<string[]> {
	const keys: string[] = []
	for await (const key of storage.listKeys(prefix)) {
		keys.push(key)
	}
	return keys
}
