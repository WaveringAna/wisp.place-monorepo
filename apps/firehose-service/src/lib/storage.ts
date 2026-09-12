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

// Source verification imports this module but must never initialize or evict a cache.
let coldTier: S3StorageTier | DiskStorageTier | undefined

function getColdTier(): S3StorageTier | DiskStorageTier {
	if (coldTier) return coldTier
	if (config.s3Bucket) {
		coldTier = new S3StorageTier({
			bucket: config.s3Bucket,
			region: config.s3Region,
			endpoint: config.s3Endpoint,
			credentials:
				config.awsAccessKeyId && config.awsSecretAccessKey
					? { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey }
					: undefined,
			prefix: config.s3Prefix,
			forcePathStyle: config.s3ForcePathStyle,
		})
		logger.info('[Storage] Using S3 cold tier', { endpointConfigured: Boolean(config.s3Endpoint), mode: 's3' })
	} else {
		if (!config.allowDiskStorage) throw new Error('Disk storage fallback is not enabled')
		coldTier = new DiskStorageTier({
			directory: process.env.CACHE_DIR || './cache/sites',
			maxSizeBytes: 10 * 1024 * 1024 * 1024,
			evictionPolicy: 'lru',
			encodeColons: false,
		})
		logger.info('[Storage] Using disk fallback', { mode: 'disk' })
	}
	return coldTier
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

let storage: TieredStorage<Uint8Array> | undefined

export function getStorage(): TieredStorage<Uint8Array> {
	storage ??= new TieredStorage<Uint8Array>({
		tiers: { cold: getColdTier() },
		compression: false,
		serialization: { serialize: identitySerialize, deserialize: identityDeserialize },
	})
	return storage
}

/**
 * S3 statistics require a full paginated ListObjects scan. The cache is started
 * explicitly by the service lifecycle, never by a health request or module import.
 */
const storageStatsCache = new StorageStatsCache(() => getStorage().getStats())

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
	await getStorage().set(key, data, {
		onlyTiers: ['cold'],
		metadata,
	})
}

/**
 * Read object metadata from the cold source without buffering its body.
 */
export async function getFileMetadata(key: string) {
	return await getColdTier().getMetadata(key)
}

/**
 * Delete a file from S3
 */
export async function deleteFile(key: string): Promise<void> {
	await getStorage().delete(key)
}

/**
 * List all files with a given prefix
 */
export async function listFiles(prefix: string): Promise<string[]> {
	const keys: string[] = []
	for await (const key of getStorage().listKeys(prefix)) {
		keys.push(key)
	}
	return keys
}
