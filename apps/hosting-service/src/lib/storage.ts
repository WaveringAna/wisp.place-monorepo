/**
 * Tiered storage configuration for wisp-hosting-service
 *
 * Implements a three-tier caching strategy:
 * - Hot (Memory): Instant access for frequently used files (index.html, CSS, JS)
 * - Warm (Disk): Local cache with eviction policy
 * - Cold (S3/R2): Object storage as source of truth (optional)
 *
 * When S3 is not configured, falls back to disk-only mode (warm tier acts as source of truth).
 * Hosting service is read-only: S3 writes are always skipped.
 */

import {
	TieredStorage,
	MemoryStorageTier,
	DiskStorageTier,
	S3StorageTier,
	type StorageTier,
	type StorageMetadata,
} from '@wispplace/tiered-storage';

const CACHE_DIR = process.env.CACHE_DIR || './cache/sites';
const HOT_CACHE_SIZE = parseInt(process.env.HOT_CACHE_SIZE || '104857600', 10); // 100MB default
const HOT_CACHE_COUNT = parseInt(process.env.HOT_CACHE_COUNT || '500', 10);
const WARM_CACHE_SIZE = parseInt(process.env.WARM_CACHE_SIZE || '10737418240', 10); // 10GB default
const WARM_EVICTION_POLICY = (process.env.WARM_EVICTION_POLICY || 'lru') as 'lru' | 'fifo' | 'size';

// S3/Cold tier configuration (optional)
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_METADATA_BUCKET = process.env.S3_METADATA_BUCKET;
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== 'false';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const S3_PREFIX = process.env.S3_PREFIX || 'sites/';

// Identity serializers for raw binary data (no JSON transformation)
// Files are stored as-is without any encoding/decoding
const identitySerialize = async (data: unknown): Promise<Uint8Array> => {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (Buffer.isBuffer(data)) return new Uint8Array(data);
	// For other types, fall back to JSON (shouldn't happen with file storage)
	return new TextEncoder().encode(JSON.stringify(data));
};

const identityDeserialize = async (data: Uint8Array): Promise<unknown> => {
	// Return as-is for binary file storage
	return data;
};

/**
 * Read-only wrapper for S3 tier.
 * Allows reads from S3 but skips all writes (hosting-service is read-only).
 */
class ReadOnlyS3Tier implements StorageTier {
	private static hasLoggedWriteSkip = false;

	constructor(private tier: StorageTier) {}

	// Read operations - pass through to underlying tier, catch errors as cache misses
	async get(key: string) {
		try {
			return await this.tier.get(key);
		} catch (err) {
			this.logReadError('get', key, err);
			return null;
		}
	}

	async getWithMetadata(key: string) {
		try {
			return await this.tier.getWithMetadata?.(key) ?? null;
		} catch (err) {
			this.logReadError('getWithMetadata', key, err);
			return null;
		}
	}

	async getStream(key: string) {
		try {
			return await this.tier.getStream?.(key) ?? null;
		} catch (err) {
			this.logReadError('getStream', key, err);
			return null;
		}
	}

	async exists(key: string) {
		try {
			return await this.tier.exists(key);
		} catch (err) {
			this.logReadError('exists', key, err);
			return false;
		}
	}

	async getMetadata(key: string) {
		try {
			return await this.tier.getMetadata(key);
		} catch (err) {
			this.logReadError('getMetadata', key, err);
			return null;
		}
	}

	async *listKeys(prefix?: string) {
		yield* this.tier.listKeys(prefix);
	}

	async getStats() {
		return this.tier.getStats();
	}

	// Write operations - no-op in read-only mode
	async set(key: string, _data: Uint8Array, _metadata: StorageMetadata) {
		this.logWriteSkip('set', key);
	}

	async setStream(key: string, _stream: NodeJS.ReadableStream, _metadata: StorageMetadata) {
		this.logWriteSkip('setStream', key);
	}

	async setMetadata(key: string, _metadata: StorageMetadata) {
		this.logWriteSkip('setMetadata', key);
	}

	async delete(key: string) {
		this.logWriteSkip('delete', key);
	}

	async deleteMany(keys: string[]) {
		this.logWriteSkip('deleteMany', `${keys.length} keys`);
	}

	async clear() {
		this.logWriteSkip('clear', 'all keys');
	}

	private logReadError(operation: string, key: string, err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[Storage] S3 read error (${operation}) for ${key}: ${msg}`);
	}

	private logWriteSkip(operation: string, key: string) {
		// Only log once to avoid spam
		if (!ReadOnlyS3Tier.hasLoggedWriteSkip) {
			console.log(`[Storage] Read-only mode: skipping S3 writes (operation: ${operation})`);
			ReadOnlyS3Tier.hasLoggedWriteSkip = true;
		}
	}
}

/**
 * Initialize tiered storage
 * Must be called before serving requests
 */
function initializeStorage(): TieredStorage<Uint8Array> {
	// Determine cold tier: S3 if configured, otherwise disk acts as cold
	let coldTier: StorageTier;
	let warmTier: StorageTier | undefined;

	const diskTier = new DiskStorageTier({
		directory: CACHE_DIR,
		maxSizeBytes: WARM_CACHE_SIZE,
		evictionPolicy: WARM_EVICTION_POLICY,
		encodeColons: false, // Preserve colons for readable DID paths on Unix/macOS
	});

	if (S3_BUCKET) {
		// Full three-tier setup with S3 as cold storage
		const s3Tier = new S3StorageTier({
			bucket: S3_BUCKET,
			metadataBucket: S3_METADATA_BUCKET,
			region: S3_REGION,
			endpoint: S3_ENDPOINT,
			forcePathStyle: S3_FORCE_PATH_STYLE,
			credentials:
				AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
					? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
					: undefined,
			prefix: S3_PREFIX,
		});

		// Hosting service is read-only: always wrap S3 tier to make it read-only
		coldTier = new ReadOnlyS3Tier(s3Tier);
		warmTier = diskTier;

		console.log('[Storage] Read-only mode: S3 as cold tier (no writes), disk as warm tier');
	} else {
		// Disk-only mode: disk tier acts as source of truth (cold)
		coldTier = diskTier;
		warmTier = undefined;
		console.log('[Storage] S3 not configured - using disk-only mode (disk as cold tier)');
	}

	const storage = new TieredStorage<Uint8Array>({
		tiers: {
			// Hot tier: In-memory LRU for instant serving
			hot: new MemoryStorageTier({
				maxSizeBytes: HOT_CACHE_SIZE,
				maxItems: HOT_CACHE_COUNT,
			}),

			// Warm tier: Disk-based cache (only when S3 is configured)
			warm: warmTier,

			// Cold tier: S3/R2 as source of truth, or disk in disk-only mode
			cold: coldTier,
		},

		// Placement rules: determine which tiers each file goes to
		placementRules: [
			// Rewritten HTML: keep hot for fast serving
			{
				pattern: '**/.rewritten/**/*.html',
				tiers: ['hot', 'warm', 'cold'],
			},

			// index.html is critical: write to all tiers for instant serving
			{
				pattern: '**/index.html',
				tiers: ['hot', 'warm', 'cold'],
			},
			{
				pattern: 'index.html',
				tiers: ['hot', 'warm', 'cold'],
			},

			// CSS and JS: eligible for hot tier if accessed frequently
			{
				pattern: '**/*.{css,js}',
				tiers: ['hot', 'warm', 'cold'],
			},

			// Media files: never needed in memory, skip hot tier
			{
				pattern: '**/*.{jpg,jpeg,png,gif,webp,svg,ico,mp4,webm,mp3,woff,woff2,ttf,eot}',
				tiers: ['warm', 'cold'],
			},

			// Default: everything else goes to warm and cold
			{
				pattern: '**',
				tiers: ['warm', 'cold'],
			},
		],

		// IMPORTANT: Compression is disabled at the tiered-storage level
		// Text files (HTML, CSS, JS, JSON) are pre-compressed with gzip at the app level
		// Binary files (images, video) are stored uncompressed as they're already compressed
		// The file's compression state is tracked in customMetadata.encoding
		compression: false,

		// TTL for cache entries (14 days)
		defaultTTL: 14 * 24 * 60 * 60 * 1000,

		// Eager promotion: promote data to upper tiers on read
		// This ensures frequently accessed files end up in hot tier
		promotionStrategy: 'eager',

		// Identity serialization: store raw binary without JSON transformation
		serialization: {
			serialize: identitySerialize,
			deserialize: identityDeserialize,
		},
	});

	return storage;
}

// Export singleton instance
export const storage = initializeStorage();

/**
 * Get storage configuration summary for logging
 */
export function getStorageConfig() {
	return {
		cacheDir: CACHE_DIR,
		hotCacheSize: `${(HOT_CACHE_SIZE / 1024 / 1024).toFixed(0)}MB`,
		hotCacheCount: HOT_CACHE_COUNT,
		warmCacheSize: `${(WARM_CACHE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB`,
		warmEvictionPolicy: WARM_EVICTION_POLICY,
		s3Bucket: S3_BUCKET,
		s3Region: S3_REGION,
		s3Endpoint: S3_ENDPOINT || '(default AWS S3)',
		s3Prefix: S3_PREFIX,
		metadataBucket: S3_METADATA_BUCKET || '(embedded in data bucket)',
	};
}
