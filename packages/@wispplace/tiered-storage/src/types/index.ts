/**
 * Metadata associated with stored data in a tier.
 *
 * @remarks
 * This metadata is stored alongside the actual data and is used for:
 * - TTL management and expiration
 * - Access tracking for LRU/eviction policies
 * - Data integrity verification via checksum
 * - Content type information for HTTP serving
 */
export interface StorageMetadata {
	/** Original key used to store the data (human-readable) */
	key: string

	/** Size of the data in bytes (uncompressed size) */
	size: number

	/** Timestamp when the data was first created */
	createdAt: Date

	/** Timestamp when the data was last accessed */
	lastAccessed: Date

	/** Number of times this data has been accessed */
	accessCount: number

	/** Optional expiration timestamp. Data expires when current time > ttl */
	ttl?: Date

	/** Whether the data is compressed (e.g., with gzip) */
	compressed: boolean

	/** SHA256 checksum of the data for integrity verification */
	checksum: string

	/** Optional MIME type (e.g., 'text/html', 'application/json') */
	mimeType?: string

	/** Optional encoding (e.g., 'gzip', 'base64') */
	encoding?: string

	/** User-defined metadata fields */
	customMetadata?: Record<string, string>
}

/**
 * Statistics for a single storage tier.
 *
 * @remarks
 * Used for monitoring cache performance and capacity planning.
 */
export interface TierStats {
	/** Total bytes stored in this tier */
	bytes: number

	/** Total number of items stored in this tier */
	items: number

	/** Number of cache hits (only tracked if tier implements hit tracking) */
	hits?: number

	/** Number of cache misses (only tracked if tier implements miss tracking) */
	misses?: number

	/** Number of evictions due to size/count limits (only tracked if tier implements eviction) */
	evictions?: number
}

/**
 * Aggregated statistics across all configured tiers.
 *
 * @remarks
 * Provides a complete view of cache performance across the entire storage hierarchy.
 */
export interface AllTierStats {
	/** Statistics for hot tier (if configured) */
	hot?: TierStats

	/** Statistics for warm tier (if configured) */
	warm?: TierStats

	/** Statistics for cold tier (always present) */
	cold: TierStats

	/** Total hits across all tiers */
	totalHits: number

	/** Total misses across all tiers */
	totalMisses: number

	/** Hit rate as a percentage (0-1) */
	hitRate: number
}

/**
 * Interface that all storage tier implementations must satisfy.
 *
 * @remarks
 * This is the core abstraction that allows pluggable backends.
 * Implementations can be memory-based (Map, Redis), disk-based (filesystem, SQLite),
 * or cloud-based (S3, R2, etc.).
 *
 * @example
 * ```typescript
 * class RedisStorageTier implements StorageTier {
 *	 constructor(private client: RedisClient) {}
 *
 *	 async get(key: string): Promise<Uint8Array | null> {
 *		 const buffer = await this.client.getBuffer(key);
 *		 return buffer ? new Uint8Array(buffer) : null;
 *	 }
 *
 *	 // ... implement other methods
 * }
 * ```
 */
/**
 * Result from a combined get+metadata operation on a tier.
 */
export interface TierGetResult {
	/** The retrieved data */
	data: Uint8Array
	/** Metadata associated with the data */
	metadata: StorageMetadata
}

/**
 * Result from a streaming get operation on a tier.
 */
export interface TierStreamResult {
	/** Readable stream of the data */
	stream: NodeJS.ReadableStream
	/** Metadata associated with the data */
	metadata: StorageMetadata
}

/**
 * Result from a streaming get operation on TieredStorage.
 *
 * @remarks
 * Includes the source tier for observability.
 */
export interface StreamResult {
	/** Readable stream of the data */
	stream: NodeJS.ReadableStream
	/** Metadata associated with the data */
	metadata: StorageMetadata
	/** Which tier the data was served from */
	source: 'hot' | 'warm' | 'cold'
}

/**
 * Options for streaming set operations.
 */
export interface StreamSetOptions extends SetOptions {
	/**
	 * Size of the data being streamed in bytes.
	 *
	 * @remarks
	 * Required for streaming writes because the size cannot be determined
	 * until the stream is fully consumed. This is used for:
	 * - Metadata creation before streaming starts
	 * - Capacity checks and eviction in tiers with size limits
	 */
	size: number

	/**
	 * Pre-computed checksum of the data.
	 *
	 * @remarks
	 * If not provided, checksum will be computed during streaming.
	 * Providing it upfront is useful when the checksum is already known
	 * (e.g., from a previous upload or external source).
	 */
	checksum?: string

	/**
	 * MIME type of the content.
	 */
	mimeType?: string
}

export interface StorageTier {
	/**
	 * Retrieve data for a key.
	 *
	 * @param key - The key to retrieve
	 * @returns The data as a Uint8Array, or null if not found
	 */
	get(key: string): Promise<Uint8Array | null>

	/**
	 * Retrieve data and metadata together in a single operation.
	 *
	 * @param key - The key to retrieve
	 * @returns The data and metadata, or null if not found
	 *
	 * @remarks
	 * This is more efficient than calling get() and getMetadata() separately,
	 * especially for disk and network-based tiers.
	 */
	getWithMetadata?(key: string): Promise<TierGetResult | null>

	/**
	 * Retrieve data as a readable stream with metadata.
	 *
	 * @param key - The key to retrieve
	 * @returns A readable stream and metadata, or null if not found
	 *
	 * @remarks
	 * Use this for large files to avoid loading entire content into memory.
	 * The stream must be consumed or destroyed by the caller.
	 */
	getStream?(key: string): Promise<TierStreamResult | null>

	/**
	 * Store data from a readable stream.
	 *
	 * @param key - The key to store under
	 * @param stream - Readable stream of data to store
	 * @param metadata - Metadata to store alongside the data
	 *
	 * @remarks
	 * Use this for large files to avoid loading entire content into memory.
	 * The stream will be fully consumed by this operation.
	 */
	setStream?(key: string, stream: NodeJS.ReadableStream, metadata: StorageMetadata): Promise<void>

	/**
	 * Store data with associated metadata.
	 *
	 * @param key - The key to store under
	 * @param data - The data to store (as Uint8Array)
	 * @param metadata - Metadata to store alongside the data
	 *
	 * @remarks
	 * If the key already exists, it should be overwritten.
	 */
	set(key: string, data: Uint8Array, metadata: StorageMetadata): Promise<void>

	/**
	 * Delete data for a key.
	 *
	 * @param key - The key to delete
	 *
	 * @remarks
	 * Should not throw if the key doesn't exist.
	 */
	delete(key: string): Promise<void>

	/**
	 * Check if a key exists in this tier.
	 *
	 * @param key - The key to check
	 * @returns true if the key exists, false otherwise
	 */
	exists(key: string): Promise<boolean>

	/**
	 * List all keys in this tier, optionally filtered by prefix.
	 *
	 * @param prefix - Optional prefix to filter keys (e.g., 'user:' matches 'user:123', 'user:456')
	 * @returns An async iterator of keys
	 *
	 * @remarks
	 * This should be memory-efficient and stream keys rather than loading all into memory.
	 * Useful for prefix-based invalidation and cache warming.
	 *
	 * @example
	 * ```typescript
	 * for await (const key of tier.listKeys('site:')) {
	 *	 console.log(key); // 'site:abc', 'site:xyz', etc.
	 * }
	 * ```
	 */
	listKeys(prefix?: string): AsyncIterableIterator<string>

	/**
	 * Delete multiple keys in a single operation.
	 *
	 * @param keys - Array of keys to delete
	 *
	 * @remarks
	 * This is more efficient than calling delete() in a loop.
	 * Implementations should batch deletions where possible.
	 */
	deleteMany(keys: string[]): Promise<void>

	/**
	 * Retrieve metadata for a key without fetching the data.
	 *
	 * @param key - The key to get metadata for
	 * @returns The metadata, or null if not found
	 *
	 * @remarks
	 * This is useful for checking TTL, access counts, etc. without loading large data.
	 */
	getMetadata(key: string): Promise<StorageMetadata | null>

	/**
	 * Update metadata for a key without modifying the data.
	 *
	 * @param key - The key to update metadata for
	 * @param metadata - The new metadata
	 *
	 * @remarks
	 * Useful for updating TTL (via touch()) or access counts.
	 */
	setMetadata(key: string, metadata: StorageMetadata): Promise<void>

	/**
	 * Get statistics about this tier.
	 *
	 * @returns Statistics including size, item count, hits, misses, etc.
	 */
	getStats(): Promise<TierStats>

	/**
	 * Clear all data from this tier.
	 *
	 * @remarks
	 * Use with caution! This will delete all data in the tier.
	 */
	clear(): Promise<void>
}

/**
 * Rule for automatic tier placement based on key patterns.
 *
 * @remarks
 * Rules are evaluated in order. First matching rule wins.
 * Use this to define which keys go to which tiers without
 * specifying skipTiers on every set() call.
 *
 * @example
 * ```typescript
 * placementRules: [
 *	 { pattern: 'index.html', tiers: ['hot', 'warm', 'cold'] },
 *	 { pattern: '*.html', tiers: ['warm', 'cold'] },
 *	 { pattern: 'assets/**', tiers: ['warm', 'cold'] },
 *	 { pattern: '**', tiers: ['warm', 'cold'] },	// default
 * ]
 * ```
 */
export interface PlacementRule {
	/**
	 * Glob pattern to match against keys.
	 *
	 * @remarks
	 * Supports basic globs:
	 * - `*` matches any characters except `/`
	 * - `**` matches any characters including `/`
	 * - Exact matches work too: `index.html`
	 */
	pattern: string

	/**
	 * Which tiers to write to for matching keys.
	 *
	 * @remarks
	 * Cold is always included (source of truth).
	 * Use `['hot', 'warm', 'cold']` for critical files.
	 * Use `['warm', 'cold']` for large files.
	 * Use `['cold']` for archival only.
	 */
	tiers: ('hot' | 'warm' | 'cold')[]
}

/**
 * Configuration for the TieredStorage system.
 *
 * @typeParam T - The type of data being stored (for serialization)
 *
 * @remarks
 * The tiered storage system uses a cascading containment model:
 * - Hot tier (optional): Fastest, smallest capacity (memory/Redis)
 * - Warm tier (optional): Medium speed, medium capacity (disk/database)
 * - Cold tier (required): Slowest, unlimited capacity (S3/object storage)
 *
 * Data flows down on writes (hot → warm → cold) and bubbles up on reads (cold → warm → hot).
 */
export interface TieredStorageConfig {
	/** Storage tier configuration */
	tiers: {
		/** Optional hot tier - fastest, smallest capacity (e.g., in-memory, Redis) */
		hot?: StorageTier

		/** Optional warm tier - medium speed, medium capacity (e.g., disk, SQLite, Postgres) */
		warm?: StorageTier

		/** Required cold tier - slowest, largest capacity (e.g., S3, R2, object storage) */
		cold: StorageTier
	}

	/** Rules for automatic tier placement based on key patterns. First match wins. */
	placementRules?: PlacementRule[]

	/**
	 * Whether to automatically compress data before storing.
	 *
	 * @defaultValue false
	 *
	 * @remarks
	 * Uses gzip compression. Compression is transparent - data is automatically
	 * decompressed on retrieval. The `compressed` flag in metadata indicates compression state.
	 */
	compression?: boolean

	/**
	 * Default TTL (time-to-live) in milliseconds.
	 *
	 * @remarks
	 * Data will expire after this duration. Can be overridden per-key via SetOptions.
	 * If not set, data never expires.
	 */
	defaultTTL?: number

	/**
	 * Strategy for promoting data to upper tiers on cache miss.
	 *
	 * @defaultValue 'lazy'
	 *
	 * @remarks
	 * - 'eager': Immediately promote data to all upper tiers on read
	 * - 'lazy': Don't automatically promote; rely on explicit promotion or next write
	 *
	 * Eager promotion increases hot tier hit rate but adds write overhead.
	 * Lazy promotion reduces writes but may serve from lower tiers more often.
	 */
	promotionStrategy?: 'eager' | 'lazy'

	/**
	 * Custom serialization/deserialization functions.
	 *
	 * @remarks
	 * By default, JSON serialization is used. Provide custom functions for:
	 * - Non-JSON types (e.g., Buffer, custom classes)
	 * - Performance optimization (e.g., msgpack, protobuf)
	 * - Encryption (serialize includes encryption, deserialize includes decryption)
	 */
	serialization?: {
		/** Convert data to Uint8Array for storage */
		serialize: (data: unknown) => Promise<Uint8Array>

		/** Convert Uint8Array back to original data */
		deserialize: (data: Uint8Array) => Promise<unknown>
	}
}

/**
 * Options for setting data in the cache.
 *
 * @remarks
 * These options allow fine-grained control over where and how data is stored.
 */
export interface SetOptions {
	/**
	 * Custom TTL in milliseconds for this specific key.
	 *
	 * @remarks
	 * Overrides the default TTL from TieredStorageConfig.
	 * Data will expire after this duration from the current time.
	 */
	ttl?: number

	/**
	 * Custom metadata to attach to this key.
	 *
	 * @remarks
	 * Merged with system-generated metadata (size, checksum, timestamps).
	 * Useful for storing application-specific information like content-type, encoding, etc.
	 */
	metadata?: Record<string, string>

	/**
	 * Skip writing to specific tiers.
	 *
	 * @remarks
	 * Useful for controlling which tiers receive data. For example:
	 * - Large files: `skipTiers: ['hot']` to avoid filling memory
	 * - Small critical files: Write to hot only for fastest access
	 *
	 * Note: Cold tier can never be skipped (it's the source of truth).
	 * Mutually exclusive with `onlyTiers`.
	 *
	 * @example
	 * ```typescript
	 * // Store large file only in warm and cold (skip memory)
	 * await storage.set('large-video.mp4', videoData, { skipTiers: ['hot'] });
	 *
	 * // Store index.html in all tiers for fast access
	 * await storage.set('index.html', htmlData); // No skipping
	 * ```
	 */
	skipTiers?: ('hot' | 'warm')[]

	/**
	 * Write only to specific tiers.
	 *
	 * @remarks
	 * Unlike `skipTiers`, this explicitly specifies which tiers to write to.
	 * Useful for write-only services that should only populate cold storage.
	 * Mutually exclusive with `skipTiers`.
	 *
	 * @example
	 * ```typescript
	 * // Write only to cold tier (S3) - useful for firehose/ingestion services
	 * await storage.set('site/index.html', htmlData, { onlyTiers: ['cold'] });
	 *
	 * // Write to warm and cold, skip hot
	 * await storage.set('large-file.mp4', videoData, { onlyTiers: ['warm', 'cold'] });
	 * ```
	 */
	onlyTiers?: ('hot' | 'warm' | 'cold')[]
}

/**
 * Result from retrieving data with metadata.
 *
 * @typeParam T - The type of data being retrieved
 *
 * @remarks
 * Includes both the data and information about where it was served from.
 */
export interface StorageResult<T> {
	/** The retrieved data */
	data: T

	/** Metadata associated with the data */
	metadata: StorageMetadata

	/** Which tier the data was served from */
	source: 'hot' | 'warm' | 'cold'
}

/**
 * Result from setting data in the cache.
 *
 * @remarks
 * Indicates which tiers successfully received the data.
 */
export interface SetResult {
	/** The key that was set */
	key: string

	/** Metadata that was stored with the data */
	metadata: StorageMetadata

	/** Which tiers received the data */
	tiersWritten: ('hot' | 'warm' | 'cold')[]
}

/**
 * Snapshot of the entire storage state.
 *
 * @remarks
 * Used for export/import, backup, and migration scenarios.
 * The snapshot includes metadata but not the actual data (data remains in tiers).
 */
export interface StorageSnapshot {
	/** Snapshot format version (for compatibility) */
	version: number

	/** When this snapshot was created */
	exportedAt: Date

	/** All keys present in cold tier (source of truth) */
	keys: string[]

	/** Metadata for each key */
	metadata: Record<string, StorageMetadata>

	/** Statistics at time of export */
	stats: AllTierStats
}
