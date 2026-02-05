import { lru, type LRU } from 'tiny-lru';
import { Readable } from 'node:stream';
import type {
	StorageTier,
	StorageMetadata,
	TierStats,
	TierGetResult,
	TierStreamResult,
} from '../types/index.js';

interface CacheEntry {
	data: Uint8Array;
	metadata: StorageMetadata;
	size: number;
}

/**
 * Configuration for MemoryStorageTier.
 */
export interface MemoryStorageTierConfig {
	/**
	 * Maximum total size in bytes.
	 *
	 * @remarks
	 * When this limit is reached, least-recently-used entries are evicted.
	 */
	maxSizeBytes: number;

	/**
	 * Maximum number of items.
	 *
	 * @remarks
	 * When this limit is reached, least-recently-used entries are evicted.
	 * Useful for limiting memory usage when items have variable sizes.
	 */
	maxItems?: number;
}

/**
 * In-memory storage tier using TinyLRU for LRU eviction.
 *
 * @remarks
 * - Uses the battle-tested TinyLRU library for efficient LRU caching
 * - Automatically evicts least-recently-used entries when limits are reached
 * - Not distributed - single process only
 * - Data is lost on process restart (use warm/cold tiers for persistence)
 * - Implements both size-based and count-based eviction
 *
 * @example
 * ```typescript
 * const tier = new MemoryStorageTier({
 *	 maxSizeBytes: 100 * 1024 * 1024, // 100MB
 *	 maxItems: 1000,
 * });
 *
 * await tier.set('key', data, metadata);
 * const retrieved = await tier.get('key');
 * ```
 */
export class MemoryStorageTier implements StorageTier {
	private cache: LRU<CacheEntry>;
	private currentSize = 0;
	private stats = {
		hits: 0,
		misses: 0,
		evictions: 0,
	};

	constructor(private config: MemoryStorageTierConfig) {
		if (config.maxSizeBytes <= 0) {
			throw new Error('maxSizeBytes must be positive');
		}
		if (config.maxItems !== undefined && config.maxItems <= 0) {
			throw new Error('maxItems must be positive');
		}

		// Initialize TinyLRU with max items (we'll handle size limits separately)
		const maxItems = config.maxItems ?? 10000; // Default to 10k items if not specified
		this.cache = lru<CacheEntry>(maxItems);
	}

	async get(key: string): Promise<Uint8Array | null> {
		const entry = this.cache.get(key);

		if (!entry) {
			this.stats.misses++;
			return null;
		}

		this.stats.hits++;
		return entry.data;
	}

	/**
	 * Retrieve data and metadata together in a single cache lookup.
	 *
	 * @param key - The key to retrieve
	 * @returns The data and metadata, or null if not found
	 */
	async getWithMetadata(key: string): Promise<TierGetResult | null> {
		const entry = this.cache.get(key);

		if (!entry) {
			this.stats.misses++;
			return null;
		}

		this.stats.hits++;
		return { data: entry.data, metadata: entry.metadata };
	}

	/**
	 * Retrieve data as a readable stream with metadata.
	 *
	 * @param key - The key to retrieve
	 * @returns A readable stream and metadata, or null if not found
	 *
	 * @remarks
	 * Creates a readable stream from the in-memory data.
	 * Note that for memory tier, data is already in memory, so this
	 * provides API consistency rather than memory savings.
	 */
	async getStream(key: string): Promise<TierStreamResult | null> {
		const entry = this.cache.get(key);

		if (!entry) {
			this.stats.misses++;
			return null;
		}

		this.stats.hits++;

		// Create a readable stream from the buffer
		const stream = Readable.from([entry.data]);

		return { stream, metadata: entry.metadata };
	}

	/**
	 * Store data from a readable stream.
	 *
	 * @param key - The key to store under
	 * @param stream - Readable stream of data to store
	 * @param metadata - Metadata to store alongside the data
	 *
	 * @remarks
	 * Buffers the stream into memory. For memory tier, this is unavoidable
	 * since the tier stores data in memory. Use disk or S3 tiers for
	 * truly streaming large file handling.
	 */
	async setStream(
		key: string,
		stream: NodeJS.ReadableStream,
		metadata: StorageMetadata,
	): Promise<void> {
		const chunks: Uint8Array[] = [];

		for await (const chunk of stream) {
			if (Buffer.isBuffer(chunk)) {
				chunks.push(new Uint8Array(chunk));
			} else if (ArrayBuffer.isView(chunk)) {
				chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
			} else if (typeof chunk === 'string') {
				chunks.push(new TextEncoder().encode(chunk));
			}
		}

		const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
		const data = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			data.set(chunk, offset);
			offset += chunk.length;
		}

		await this.set(key, data, metadata);
	}

	async set(key: string, data: Uint8Array, metadata: StorageMetadata): Promise<void> {
		const size = data.byteLength;

		// Check existing entry for size accounting
		const existing = this.cache.get(key);
		if (existing) {
			this.currentSize -= existing.size;
		}

		// Evict entries until we have space for the new entry
		await this.evictIfNeeded(size);

		// Add new entry
		const entry: CacheEntry = { data, metadata, size };
		this.cache.set(key, entry);
		this.currentSize += size;
	}

	async delete(key: string): Promise<void> {
		const entry = this.cache.get(key);
		if (entry) {
			this.cache.delete(key);
			this.currentSize -= entry.size;
		}
	}

	async exists(key: string): Promise<boolean> {
		return this.cache.has(key);
	}

	async *listKeys(prefix?: string): AsyncIterableIterator<string> {
		// TinyLRU returns keys as any[] but they are strings in our usage
		const keys = this.cache.keys() as string[];
		for (const key of keys) {
			if (!prefix || key.startsWith(prefix)) {
				yield key;
			}
		}
	}

	async deleteMany(keys: string[]): Promise<void> {
		for (const key of keys) {
			await this.delete(key);
		}
	}

	async getMetadata(key: string): Promise<StorageMetadata | null> {
		const entry = this.cache.get(key);
		return entry ? entry.metadata : null;
	}

	async setMetadata(key: string, metadata: StorageMetadata): Promise<void> {
		const entry = this.cache.get(key);
		if (entry) {
			// Update metadata in place
			entry.metadata = metadata;
			// Re-set to mark as recently used
			this.cache.set(key, entry);
		}
	}

	async getStats(): Promise<TierStats> {
		return {
			bytes: this.currentSize,
			items: this.cache.size,
			hits: this.stats.hits,
			misses: this.stats.misses,
			evictions: this.stats.evictions,
		};
	}

	async clear(): Promise<void> {
		this.cache.clear();
		this.currentSize = 0;
	}

	/**
	 * Evict least-recently-used entries until there's space for new data.
	 *
	 * @param incomingSize - Size of data being added
	 *
	 * @remarks
	 * TinyLRU handles count-based eviction automatically.
	 * This method handles size-based eviction by using TinyLRU's built-in evict() method,
	 * which properly removes the LRU item without updating access order.
	 */
	private async evictIfNeeded(incomingSize: number): Promise<void> {
		// Keep evicting until we have enough space
		while (this.currentSize + incomingSize > this.config.maxSizeBytes && this.cache.size > 0) {
			// Get the LRU key (first in the list) without accessing it
			const keys = this.cache.keys() as string[];
			if (keys.length === 0) break;

			const lruKey = keys[0];
			if (!lruKey) break;

			// Access the entry directly from internal items without triggering LRU update
			// items is a public property in LRU interface for this purpose
			const entry = this.cache.items[lruKey]?.value;
			if (!entry) break;

			// Use TinyLRU's built-in evict() which properly removes the LRU item
			this.cache.evict();
			this.currentSize -= entry.size;
			this.stats.evictions++;
		}
	}
}
