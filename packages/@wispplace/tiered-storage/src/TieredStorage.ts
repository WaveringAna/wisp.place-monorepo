import type {
	TieredStorageConfig,
	SetOptions,
	StorageResult,
	SetResult,
	StorageMetadata,
	StorageTier,
	AllTierStats,
	StorageSnapshot,
	StreamResult,
	StreamSetOptions,
} from './types/index';
import {
	compress,
	decompress,
	createCompressStream,
	createDecompressStream,
} from './utils/compression.js';
import { defaultSerialize, defaultDeserialize } from './utils/serialization.js';
import { calculateChecksum } from './utils/checksum.js';
import { matchGlob } from './utils/glob.js';
import { PassThrough, type Readable } from 'node:stream';
import { createHash } from 'node:crypto';

/**
 * Main orchestrator for tiered storage system.
 *
 * @typeParam T - The type of data being stored
 *
 * @remarks
 * Implements a cascading containment model:
 * - **Write Strategy (Cascading Down):** Write to hot → also writes to warm and cold
 * - **Read Strategy (Bubbling Up):** Check hot first → if miss, check warm → if miss, check cold
 * - **Bootstrap Strategy:** Hot can bootstrap from warm, warm can bootstrap from cold
 *
 * The cold tier is the source of truth and is required.
 * Hot and warm tiers are optional performance optimizations.
 *
 * @example
 * ```typescript
 * const storage = new TieredStorage({
 *	 tiers: {
 *		 hot: new MemoryStorageTier({ maxSizeBytes: 100 * 1024 * 1024 }), // 100MB
 *		 warm: new DiskStorageTier({ directory: './cache' }),
 *		 cold: new S3StorageTier({ bucket: 'my-bucket', region: 'us-east-1' }),
 *	 },
 *	 compression: true,
 *	 defaultTTL: 14 * 24 * 60 * 60 * 1000, // 14 days
 *	 promotionStrategy: 'lazy',
 * });
 *
 * // Store data (cascades to all tiers)
 * await storage.set('user:123', { name: 'Alice' });
 *
 * // Retrieve data (bubbles up from cold → warm → hot)
 * const user = await storage.get('user:123');
 *
 * // Invalidate all keys with prefix
 * await storage.invalidate('user:');
 * ```
 */
export class TieredStorage<T = unknown> {
	private serialize: (data: unknown) => Promise<Uint8Array>;
	private deserialize: (data: Uint8Array) => Promise<unknown>;

	constructor(private config: TieredStorageConfig) {
		if (!config.tiers.cold) {
			throw new Error('Cold tier is required');
		}

		this.serialize = config.serialization?.serialize ?? defaultSerialize;
		this.deserialize = config.serialization?.deserialize ?? defaultDeserialize;
	}

	/**
	 * Retrieve data for a key.
	 *
	 * @param key - The key to retrieve
	 * @returns The data, or null if not found or expired
	 *
	 * @remarks
	 * Checks tiers in order: hot → warm → cold.
	 * On cache miss, promotes data to upper tiers based on promotionStrategy.
	 * Automatically handles decompression and deserialization.
	 * Returns null if key doesn't exist or has expired (TTL).
	 */
	async get(key: string): Promise<T | null> {
		const result = await this.getWithMetadata(key);
		return result ? result.data : null;
	}

	/**
	 * Retrieve data with metadata and source tier information.
	 *
	 * @param key - The key to retrieve
	 * @returns The data, metadata, and source tier, or null if not found
	 *
	 * @remarks
	 * Use this when you need to know:
	 * - Which tier served the data (for observability)
	 * - Metadata like access count, TTL, checksum
	 * - When the data was created/last accessed
	 */
	async getWithMetadata(key: string): Promise<StorageResult<T> | null> {
		// 1. Check hot tier first
		if (this.config.tiers.hot) {
			const result = await this.getFromTier(this.config.tiers.hot, key);
			if (result) {
				if (this.isExpired(result.metadata)) {
					await this.delete(key);
					return null;
				}
				// Fire-and-forget access stats update (non-critical)
				void this.updateAccessStats(key, 'hot');
				return {
					data: (await this.deserializeData(result.data)) as T,
					metadata: result.metadata,
					source: 'hot',
				};
			}
		}

		// 2. Check warm tier
		if (this.config.tiers.warm) {
			const result = await this.getFromTier(this.config.tiers.warm, key);
			if (result) {
				if (this.isExpired(result.metadata)) {
					await this.delete(key);
					return null;
				}
				// Eager promotion to hot tier (awaited - guaranteed to complete)
				if (this.config.tiers.hot && this.config.promotionStrategy === 'eager') {
					await this.config.tiers.hot.set(key, result.data, result.metadata);
				}
				// Fire-and-forget access stats update (non-critical)
				void this.updateAccessStats(key, 'warm');
				return {
					data: (await this.deserializeData(result.data)) as T,
					metadata: result.metadata,
					source: 'warm',
				};
			}
		}

		// 3. Check cold tier (source of truth)
		const result = await this.getFromTier(this.config.tiers.cold, key);
		if (result) {
			if (this.isExpired(result.metadata)) {
				await this.delete(key);
				return null;
			}

			// Promote to warm and hot (if configured)
			// Eager promotion is awaited to guarantee completion
			if (this.config.promotionStrategy === 'eager') {
				const promotions: Promise<void>[] = [];
				if (this.config.tiers.warm) {
					promotions.push(this.config.tiers.warm.set(key, result.data, result.metadata));
				}
				if (this.config.tiers.hot) {
					promotions.push(this.config.tiers.hot.set(key, result.data, result.metadata));
				}
				await Promise.all(promotions);
			}

			// Fire-and-forget access stats update (non-critical)
			void this.updateAccessStats(key, 'cold');
			return {
				data: (await this.deserializeData(result.data)) as T,
				metadata: result.metadata,
				source: 'cold',
			};
		}

		return null;
	}

	/**
	 * Get data and metadata from a tier using the most efficient method.
	 *
	 * @remarks
	 * Uses the tier's getWithMetadata if available, otherwise falls back
	 * to separate get() and getMetadata() calls.
	 */
	private async getFromTier(
		tier: StorageTier,
		key: string,
	): Promise<{ data: Uint8Array; metadata: StorageMetadata } | null> {
		// Use optimized combined method if available
		if (tier.getWithMetadata) {
			return tier.getWithMetadata(key);
		}

		// Fallback: separate calls
		const data = await tier.get(key);
		if (!data) {
			return null;
		}
		const metadata = await tier.getMetadata(key);
		if (!metadata) {
			return null;
		}
		return { data, metadata };
	}

	/**
	 * Retrieve data as a readable stream with metadata.
	 *
	 * @param key - The key to retrieve
	 * @returns A readable stream, metadata, and source tier, or null if not found
	 *
	 * @remarks
	 * Use this for large files to avoid loading entire content into memory.
	 * The stream must be consumed or destroyed by the caller.
	 *
	 * Checks tiers in order: hot → warm → cold.
	 * On cache miss, does NOT promote data to upper tiers (streaming would
	 * require buffering, defeating the purpose).
	 *
	 * Decompression is automatically handled if the data was stored with
	 * compression enabled (metadata.compressed = true).
	 *
	 * @example
	 * ```typescript
	 * const result = await storage.getStream('large-file.mp4');
	 * if (result) {
	 *   result.stream.pipe(response); // Stream directly to HTTP response
	 * }
	 * ```
	 */
	async getStream(key: string): Promise<StreamResult | null> {
		// 1. Check hot tier first
		if (this.config.tiers.hot?.getStream) {
			const result = await this.config.tiers.hot.getStream(key);
			if (result) {
				if (this.isExpired(result.metadata)) {
					(result.stream as Readable).destroy?.();
					await this.delete(key);
					return null;
				}
				void this.updateAccessStats(key, 'hot');
				return this.wrapStreamWithDecompression(result, 'hot');
			}
		}

		// 2. Check warm tier
		if (this.config.tiers.warm?.getStream) {
			const result = await this.config.tiers.warm.getStream(key);
			if (result) {
				if (this.isExpired(result.metadata)) {
					(result.stream as Readable).destroy?.();
					await this.delete(key);
					return null;
				}
				// NOTE: No promotion for streaming (would require buffering)
				void this.updateAccessStats(key, 'warm');
				return this.wrapStreamWithDecompression(result, 'warm');
			}
		}

		// 3. Check cold tier (source of truth)
		if (this.config.tiers.cold.getStream) {
			const result = await this.config.tiers.cold.getStream(key);
			if (result) {
				if (this.isExpired(result.metadata)) {
					(result.stream as Readable).destroy?.();
					await this.delete(key);
					return null;
				}
				// NOTE: No promotion for streaming (would require buffering)
				void this.updateAccessStats(key, 'cold');
				return this.wrapStreamWithDecompression(result, 'cold');
			}
		}

		return null;
	}

	/**
	 * Wrap a stream result with decompression if needed.
	 */
	private wrapStreamWithDecompression(
		result: { stream: NodeJS.ReadableStream; metadata: StorageMetadata },
		source: 'hot' | 'warm' | 'cold',
	): StreamResult {
		if (result.metadata.compressed) {
			// Pipe through decompression stream
			const decompressStream = createDecompressStream();
			(result.stream as Readable).pipe(decompressStream);
			return { stream: decompressStream, metadata: result.metadata, source };
		}
		return { ...result, source };
	}

	/**
	 * Store data from a readable stream.
	 *
	 * @param key - The key to store under
	 * @param stream - Readable stream of data to store
	 * @param options - Configuration including size (required), checksum, and tier options
	 * @returns Information about what was stored and where
	 *
	 * @remarks
	 * Use this for large files to avoid loading entire content into memory.
	 *
	 * **Important differences from set():**
	 * - `options.size` is required (stream size cannot be determined upfront)
	 * - Serialization is NOT applied (stream is stored as-is)
	 * - If no checksum is provided, one will be computed during streaming
	 * - Checksum is computed on the original (pre-compression) data
	 *
	 * **Compression:**
	 * - If `config.compression` is true, the stream is compressed before storage
	 * - Checksum is always computed on the original uncompressed data
	 *
	 * **Tier handling:**
	 * - Only writes to tiers that support streaming (have setStream method)
	 * - Hot tier is skipped by default for streaming (typically memory-based)
	 * - Tees the stream to write to multiple tiers simultaneously
	 *
	 * @example
	 * ```typescript
	 * const fileStream = fs.createReadStream('large-file.mp4');
	 * const stat = fs.statSync('large-file.mp4');
	 *
	 * await storage.setStream('videos/large.mp4', fileStream, {
	 *   size: stat.size,
	 *   mimeType: 'video/mp4',
	 * });
	 * ```
	 */
	async setStream(
		key: string,
		stream: NodeJS.ReadableStream,
		options: StreamSetOptions,
	): Promise<SetResult> {
		const shouldCompress = this.config.compression ?? false;

		// Create metadata
		const now = new Date();
		const ttl = options.ttl ?? this.config.defaultTTL;

		const metadata: StorageMetadata = {
			key,
			size: options.size, // Original uncompressed size
			createdAt: now,
			lastAccessed: now,
			accessCount: 0,
			compressed: shouldCompress,
			checksum: options.checksum ?? '', // Will be computed if not provided
			...(options.mimeType && { mimeType: options.mimeType }),
		};

		if (ttl) {
			metadata.ttl = new Date(now.getTime() + ttl);
		}

		if (options.metadata) {
			metadata.customMetadata = options.metadata;
		}

		// Determine which tiers to write to
		// Default: skip hot tier for streaming (typically memory-based, defeats purpose)
		const tierOptions: { skipTiers?: ('hot' | 'warm')[]; onlyTiers?: ('hot' | 'warm' | 'cold')[] } = {};
		if (options.onlyTiers) {
			tierOptions.onlyTiers = options.onlyTiers;
		} else if (options.skipTiers) {
			tierOptions.skipTiers = options.skipTiers;
		} else {
			tierOptions.skipTiers = ['hot']; // Default for streaming
		}
		const allowedTiers = this.getTiersForKey(key, tierOptions);

		// Collect tiers that support streaming
		const streamingTiers: Array<{ name: 'hot' | 'warm' | 'cold'; tier: StorageTier }> = [];

		if (this.config.tiers.hot?.setStream && allowedTiers.includes('hot')) {
			streamingTiers.push({ name: 'hot', tier: this.config.tiers.hot });
		}

		if (this.config.tiers.warm?.setStream && allowedTiers.includes('warm')) {
			streamingTiers.push({ name: 'warm', tier: this.config.tiers.warm });
		}

		if (this.config.tiers.cold.setStream && allowedTiers.includes('cold')) {
			streamingTiers.push({ name: 'cold', tier: this.config.tiers.cold });
		}

		const tiersWritten: ('hot' | 'warm' | 'cold')[] = [];

		if (streamingTiers.length === 0) {
			throw new Error('No tiers support streaming. Use set() for buffered writes.');
		}

		// We always need to compute checksum on uncompressed data if not provided
		const needsChecksum = !options.checksum;

		// Create pass-through streams for each tier
		const passThroughs = streamingTiers.map(() => new PassThrough());
		const hashStream = needsChecksum ? createHash('sha256') : null;

		// Set up the stream pipeline:
		// source -> (hash) -> (compress) -> tee to all tier streams
		const sourceStream = stream as Readable;

		// If compression is enabled, we need to:
		// 1. Compute hash on original data
		// 2. Then compress
		// 3. Then tee to all tiers
		if (shouldCompress) {
			const compressStream = createCompressStream();

			// Hash the original uncompressed data
			sourceStream.on('data', (chunk: Buffer) => {
				if (hashStream) {
					hashStream.update(chunk);
				}
			});

			// Pipe source through compression
			sourceStream.pipe(compressStream);

			// Tee compressed output to all tier streams
			compressStream.on('data', (chunk: Buffer) => {
				for (const pt of passThroughs) {
					pt.write(chunk);
				}
			});

			compressStream.on('end', () => {
				for (const pt of passThroughs) {
					pt.end();
				}
			});

			compressStream.on('error', (err) => {
				for (const pt of passThroughs) {
					pt.destroy(err);
				}
			});
		} else {
			// No compression - hash and tee directly
			sourceStream.on('data', (chunk: Buffer) => {
				for (const pt of passThroughs) {
					pt.write(chunk);
				}
				if (hashStream) {
					hashStream.update(chunk);
				}
			});

			sourceStream.on('end', () => {
				for (const pt of passThroughs) {
					pt.end();
				}
			});

			sourceStream.on('error', (err) => {
				for (const pt of passThroughs) {
					pt.destroy(err);
				}
			});
		}

		// Wait for all tier writes
		const writePromises = streamingTiers.map(async ({ name, tier }, index) => {
			await tier.setStream!(key, passThroughs[index]!, metadata);
			tiersWritten.push(name);
		});

		await Promise.all(writePromises);

		// Update checksum in metadata if computed
		if (hashStream) {
			metadata.checksum = hashStream.digest('hex');
			// Update metadata in all tiers with the computed checksum
			await Promise.all(streamingTiers.map(({ tier }) => tier.setMetadata(key, metadata)));
		}

		return { key, metadata, tiersWritten };
	}

	/**
	 * Store data with optional configuration.
	 *
	 * @param key - The key to store under
	 * @param data - The data to store
	 * @param options - Optional configuration (TTL, metadata, tier skipping)
	 * @returns Information about what was stored and where
	 *
	 * @remarks
	 * Data cascades down through tiers:
	 * - If written to hot, also written to warm and cold
	 * - If written to warm (hot skipped), also written to cold
	 * - Cold is always written (source of truth)
	 *
	 * Use `skipTiers` to control placement. For example:
	 * - Large files: `skipTiers: ['hot']` to avoid memory bloat
	 * - Critical small files: Write to all tiers for fastest access
	 *
	 * Automatically handles serialization and optional compression.
	 */
	async set(key: string, data: T, options?: SetOptions): Promise<SetResult> {
		// 1. Serialize data
		const serialized = await this.serialize(data);

		// 2. Optionally compress
		const finalData = this.config.compression ? await compress(serialized) : serialized;

		// 3. Create metadata
		const metadata = this.createMetadata(key, finalData, options);

		// 4. Determine which tiers to write to
		const tierOptions: { skipTiers?: ('hot' | 'warm')[]; onlyTiers?: ('hot' | 'warm' | 'cold')[] } = {};
		if (options?.onlyTiers) {
			tierOptions.onlyTiers = options.onlyTiers;
		} else if (options?.skipTiers) {
			tierOptions.skipTiers = options.skipTiers;
		}
		const allowedTiers = this.getTiersForKey(key, tierOptions);

		// 5. Write to tiers
		const tiersWritten: ('hot' | 'warm' | 'cold')[] = [];

		if (this.config.tiers.hot && allowedTiers.includes('hot')) {
			await this.config.tiers.hot.set(key, finalData, metadata);
			tiersWritten.push('hot');
		}

		if (this.config.tiers.warm && allowedTiers.includes('warm')) {
			await this.config.tiers.warm.set(key, finalData, metadata);
			tiersWritten.push('warm');
		}

		if (allowedTiers.includes('cold')) {
			await this.config.tiers.cold.set(key, finalData, metadata);
			tiersWritten.push('cold');
		}

		return { key, metadata, tiersWritten };
	}

	/**
	 * Determine which tiers a key should be written to.
	 *
	 * @param key - The key being stored
	 * @param options - skipTiers or onlyTiers options
	 * @returns Array of tiers to write to
	 *
	 * @remarks
	 * Priority: onlyTiers > skipTiers > placementRules > all configured tiers
	 */
	private getTiersForKey(
		key: string,
		options?: { skipTiers?: ('hot' | 'warm')[]; onlyTiers?: ('hot' | 'warm' | 'cold')[] },
	): ('hot' | 'warm' | 'cold')[] {
		// If explicit onlyTiers provided, use that exactly
		if (options?.onlyTiers && options.onlyTiers.length > 0) {
			return options.onlyTiers;
		}

		// If explicit skipTiers provided, use that
		if (options?.skipTiers && options.skipTiers.length > 0) {
			const allTiers: ('hot' | 'warm' | 'cold')[] = ['hot', 'warm', 'cold'];
			return allTiers.filter((t) => !options.skipTiers!.includes(t as 'hot' | 'warm'));
		}

		// Check placement rules
		if (this.config.placementRules) {
			for (const rule of this.config.placementRules) {
				if (matchGlob(rule.pattern, key)) {
					// Ensure cold is always included
					if (!rule.tiers.includes('cold')) {
						return [...rule.tiers, 'cold'];
					}
					return rule.tiers;
				}
			}
		}

		// Default: write to all configured tiers
		return ['hot', 'warm', 'cold'];
	}

	/**
	 * Delete data from all tiers.
	 *
	 * @param key - The key to delete
	 *
	 * @remarks
	 * Deletes from all configured tiers in parallel.
	 * Does not throw if the key doesn't exist.
	 */
	async delete(key: string): Promise<void> {
		await Promise.all([
			this.config.tiers.hot?.delete(key),
			this.config.tiers.warm?.delete(key),
			this.config.tiers.cold.delete(key),
		]);
	}

	/**
	 * Check if a key exists in any tier.
	 *
	 * @param key - The key to check
	 * @returns true if the key exists and hasn't expired
	 *
	 * @remarks
	 * Checks tiers in order: hot → warm → cold.
	 * Returns false if key exists but has expired.
	 */
	async exists(key: string): Promise<boolean> {
		// Check hot first (fastest)
		if (this.config.tiers.hot && (await this.config.tiers.hot.exists(key))) {
			const metadata = await this.config.tiers.hot.getMetadata(key);
			if (metadata && !this.isExpired(metadata)) {
				return true;
			}
		}

		// Check warm
		if (this.config.tiers.warm && (await this.config.tiers.warm.exists(key))) {
			const metadata = await this.config.tiers.warm.getMetadata(key);
			if (metadata && !this.isExpired(metadata)) {
				return true;
			}
		}

		// Check cold (source of truth)
		if (await this.config.tiers.cold.exists(key)) {
			const metadata = await this.config.tiers.cold.getMetadata(key);
			if (metadata && !this.isExpired(metadata)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Renew TTL for a key.
	 *
	 * @param key - The key to touch
	 * @param ttlMs - Optional new TTL in milliseconds (uses default if not provided)
	 *
	 * @remarks
	 * Updates the TTL and lastAccessed timestamp in all tiers.
	 * Useful for implementing "keep alive" behavior for actively used keys.
	 * Does nothing if no TTL is configured.
	 */
	async touch(key: string, ttlMs?: number): Promise<void> {
		const ttl = ttlMs ?? this.config.defaultTTL;
		if (!ttl) return;

		const newTTL = new Date(Date.now() + ttl);

		for (const tier of [
			this.config.tiers.hot,
			this.config.tiers.warm,
			this.config.tiers.cold,
		]) {
			if (!tier) continue;

			const metadata = await tier.getMetadata(key);
			if (metadata) {
				metadata.ttl = newTTL;
				metadata.lastAccessed = new Date();
				await tier.setMetadata(key, metadata);
			}
		}
	}

	/**
	 * Invalidate all keys matching a prefix.
	 *
	 * @param prefix - The prefix to match (e.g., 'user:' matches 'user:123', 'user:456')
	 * @returns Number of keys deleted
	 *
	 * @remarks
	 * Useful for bulk invalidation:
	 * - Site invalidation: `invalidate('site:abc:')`
	 * - User invalidation: `invalidate('user:123:')`
	 * - Global invalidation: `invalidate('')` (deletes everything)
	 *
	 * Deletes from all tiers in parallel for efficiency.
	 */
	async invalidate(prefix: string): Promise<number> {
		const keysToDelete = new Set<string>();

		// Collect all keys matching prefix from all tiers
		if (this.config.tiers.hot) {
			for await (const key of this.config.tiers.hot.listKeys(prefix)) {
				keysToDelete.add(key);
			}
		}

		if (this.config.tiers.warm) {
			for await (const key of this.config.tiers.warm.listKeys(prefix)) {
				keysToDelete.add(key);
			}
		}

		for await (const key of this.config.tiers.cold.listKeys(prefix)) {
			keysToDelete.add(key);
		}

		// Delete from all tiers in parallel
		const keys = Array.from(keysToDelete);

		await Promise.all([
			this.config.tiers.hot?.deleteMany(keys),
			this.config.tiers.warm?.deleteMany(keys),
			this.config.tiers.cold.deleteMany(keys),
		]);

		return keys.length;
	}

	/**
	 * List all keys, optionally filtered by prefix.
	 *
	 * @param prefix - Optional prefix to filter keys
	 * @returns Async iterator of keys
	 *
	 * @remarks
	 * Returns keys from the cold tier (source of truth).
	 * Memory-efficient - streams keys rather than loading all into memory.
	 *
	 * @example
	 * ```typescript
	 * for await (const key of storage.listKeys('user:')) {
	 *	 console.log(key);
	 * }
	 * ```
	 */
	async *listKeys(prefix?: string): AsyncIterableIterator<string> {
		// List from cold tier (source of truth)
		for await (const key of this.config.tiers.cold.listKeys(prefix)) {
			yield key;
		}
	}

	/**
	 * Get aggregated statistics across all tiers.
	 *
	 * @returns Statistics including size, item count, hits, misses, hit rate
	 *
	 * @remarks
	 * Useful for monitoring and capacity planning.
	 * Hit rate is calculated as: hits / (hits + misses).
	 */
	async getStats(): Promise<AllTierStats> {
		const [hot, warm, cold] = await Promise.all([
			this.config.tiers.hot?.getStats(),
			this.config.tiers.warm?.getStats(),
			this.config.tiers.cold.getStats(),
		]);

		const totalHits = (hot?.hits ?? 0) + (warm?.hits ?? 0) + (cold?.hits ?? 0);
		const totalMisses = (hot?.misses ?? 0) + (warm?.misses ?? 0) + (cold?.misses ?? 0);
		const hitRate = totalHits + totalMisses > 0 ? totalHits / (totalHits + totalMisses) : 0;

		return {
			...(hot && { hot }),
			...(warm && { warm }),
			cold,
			totalHits,
			totalMisses,
			hitRate,
		};
	}

	/**
	 * Clear all data from all tiers.
	 *
	 * @remarks
	 * Use with extreme caution! This will delete all data in the entire storage system.
	 * Cannot be undone.
	 */
	async clear(): Promise<void> {
		await Promise.all([
			this.config.tiers.hot?.clear(),
			this.config.tiers.warm?.clear(),
			this.config.tiers.cold.clear(),
		]);
	}

	/**
	 * Clear a specific tier.
	 *
	 * @param tier - Which tier to clear
	 *
	 * @remarks
	 * Useful for:
	 * - Clearing hot tier to test warm/cold performance
	 * - Clearing warm tier to force rebuilding from cold
	 * - Clearing cold tier to start fresh (⚠️ loses source of truth!)
	 */
	async clearTier(tier: 'hot' | 'warm' | 'cold'): Promise<void> {
		switch (tier) {
			case 'hot':
				await this.config.tiers.hot?.clear();
				break;
			case 'warm':
				await this.config.tiers.warm?.clear();
				break;
			case 'cold':
				await this.config.tiers.cold.clear();
				break;
		}
	}

	/**
	 * Export metadata snapshot for backup or migration.
	 *
	 * @returns Snapshot containing all keys, metadata, and statistics
	 *
	 * @remarks
	 * The snapshot includes metadata but not the actual data (data remains in tiers).
	 * Useful for:
	 * - Backup and restore
	 * - Migration between storage systems
	 * - Auditing and compliance
	 */
	async export(): Promise<StorageSnapshot> {
		const keys: string[] = [];
		const metadata: Record<string, StorageMetadata> = {};

		// Export from cold tier (source of truth)
		for await (const key of this.config.tiers.cold.listKeys()) {
			keys.push(key);
			const meta = await this.config.tiers.cold.getMetadata(key);
			if (meta) {
				metadata[key] = meta;
			}
		}

		const stats = await this.getStats();

		return {
			version: 1,
			exportedAt: new Date(),
			keys,
			metadata,
			stats,
		};
	}

	/**
	 * Import metadata snapshot.
	 *
	 * @param snapshot - Snapshot to import
	 *
	 * @remarks
	 * Validates version compatibility before importing.
	 * Only imports metadata - assumes data already exists in cold tier.
	 */
	async import(snapshot: StorageSnapshot): Promise<void> {
		if (snapshot.version !== 1) {
			throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
		}

		// Import metadata into all configured tiers
		for (const key of snapshot.keys) {
			const metadata = snapshot.metadata[key];
			if (!metadata) continue;

			if (this.config.tiers.hot) {
				await this.config.tiers.hot.setMetadata(key, metadata);
			}

			if (this.config.tiers.warm) {
				await this.config.tiers.warm.setMetadata(key, metadata);
			}

			await this.config.tiers.cold.setMetadata(key, metadata);
		}
	}

	/**
	 * Bootstrap hot tier from warm tier.
	 *
	 * @param limit - Optional limit on number of items to load
	 * @returns Number of items loaded
	 *
	 * @remarks
	 * Loads the most frequently accessed items from warm into hot.
	 * Useful for warming up the cache after a restart.
	 * Items are sorted by: accessCount * lastAccessed timestamp (higher is better).
	 */
	async bootstrapHot(limit?: number): Promise<number> {
		if (!this.config.tiers.hot || !this.config.tiers.warm) {
			return 0;
		}

		let loaded = 0;
		const keyMetadata: Array<[string, StorageMetadata]> = [];

		// Load metadata for all keys
		for await (const key of this.config.tiers.warm.listKeys()) {
			const metadata = await this.config.tiers.warm.getMetadata(key);
			if (metadata) {
				keyMetadata.push([key, metadata]);
			}
		}

		// Sort by access count * recency (simple scoring)
		keyMetadata.sort((a, b) => {
			const scoreA = a[1].accessCount * a[1].lastAccessed.getTime();
			const scoreB = b[1].accessCount * b[1].lastAccessed.getTime();
			return scoreB - scoreA;
		});

		// Load top N keys into hot tier
		const keysToLoad = limit ? keyMetadata.slice(0, limit) : keyMetadata;

		for (const [key, metadata] of keysToLoad) {
			const data = await this.config.tiers.warm.get(key);
			if (data) {
				await this.config.tiers.hot.set(key, data, metadata);
				loaded++;
			}
		}

		return loaded;
	}

	/**
	 * Bootstrap warm tier from cold tier.
	 *
	 * @param options - Optional limit and date filter
	 * @returns Number of items loaded
	 *
	 * @remarks
	 * Loads recent items from cold into warm.
	 * Useful for:
	 * - Initial cache population
	 * - Recovering from warm tier failure
	 * - Migrating to a new warm tier implementation
	 */
	async bootstrapWarm(options?: { limit?: number; sinceDate?: Date }): Promise<number> {
		if (!this.config.tiers.warm) {
			return 0;
		}

		let loaded = 0;

		for await (const key of this.config.tiers.cold.listKeys()) {
			const metadata = await this.config.tiers.cold.getMetadata(key);
			if (!metadata) continue;

			// Skip if too old
			if (options?.sinceDate && metadata.lastAccessed < options.sinceDate) {
				continue;
			}

			const data = await this.config.tiers.cold.get(key);
			if (data) {
				await this.config.tiers.warm.set(key, data, metadata);
				loaded++;

				if (options?.limit && loaded >= options.limit) {
					break;
				}
			}
		}

		return loaded;
	}

	/**
	 * Check if data has expired based on TTL.
	 */
	private isExpired(metadata: StorageMetadata): boolean {
		if (!metadata.ttl) return false;
		return Date.now() > metadata.ttl.getTime();
	}

	/**
	 * Update access statistics for a key.
	 */
	private async updateAccessStats(key: string, tier: 'hot' | 'warm' | 'cold'): Promise<void> {
		const tierObj =
			tier === 'hot'
				? this.config.tiers.hot
				: tier === 'warm'
					? this.config.tiers.warm
					: this.config.tiers.cold;

		if (!tierObj) return;

		const metadata = await tierObj.getMetadata(key);
		if (metadata) {
			metadata.lastAccessed = new Date();
			metadata.accessCount++;
			await tierObj.setMetadata(key, metadata);
		}
	}

	/**
	 * Create metadata for new data.
	 */
	private createMetadata(key: string, data: Uint8Array, options?: SetOptions): StorageMetadata {
		const now = new Date();
		const ttl = options?.ttl ?? this.config.defaultTTL;

		const metadata: StorageMetadata = {
			key,
			size: data.byteLength,
			createdAt: now,
			lastAccessed: now,
			accessCount: 0,
			compressed: this.config.compression ?? false,
			checksum: calculateChecksum(data),
		};

		if (ttl) {
			metadata.ttl = new Date(now.getTime() + ttl);
		}

		if (options?.metadata) {
			metadata.customMetadata = options.metadata;
		}

		return metadata;
	}

	/**
	 * Deserialize data, handling compression automatically.
	 */
	private async deserializeData(data: Uint8Array): Promise<unknown> {
		// Decompress if needed (check for gzip magic bytes)
		const finalData =
			this.config.compression && data[0] === 0x1f && data[1] === 0x8b
				? await decompress(data)
				: data;

		return this.deserialize(finalData);
	}
}
