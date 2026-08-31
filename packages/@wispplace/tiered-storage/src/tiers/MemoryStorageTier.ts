import { Readable } from 'node:stream'
import { type LRU, lru } from 'tiny-lru'
import type { StorageMetadata, StorageTier, TierGetResult, TierStats, TierStreamResult } from '../types/index.js'

interface CacheEntry {
	data: Uint8Array
	metadata: StorageMetadata
	size: number
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
	maxSizeBytes: number

	/**
	 * Maximum number of items.
	 *
	 * @remarks
	 * When this limit is reached, least-recently-used entries are evicted.
	 * Useful for limiting memory usage when items have variable sizes.
	 */
	maxItems?: number
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
	private cache: LRU<CacheEntry>
	private currentSize = 0
	private stats = {
		hits: 0,
		misses: 0,
		evictions: 0,
	}

	constructor(private config: MemoryStorageTierConfig) {
		if (config.maxSizeBytes <= 0) {
			throw new Error('maxSizeBytes must be positive')
		}
		if (config.maxItems !== undefined && config.maxItems <= 0) {
			throw new Error('maxItems must be positive')
		}

		// Initialize TinyLRU with max items (we'll handle size limits separately)
		const maxItems = config.maxItems ?? 10000 // Default to 10k items if not specified
		this.cache = lru<CacheEntry>(maxItems)
	}

	async get(key: string): Promise<Uint8Array | null> {
		const entry = this.cache.get(key)

		if (!entry) {
			this.stats.misses++
			return null
		}

		this.stats.hits++
		return entry.data
	}

	/**
	 * Retrieve data and metadata together in a single cache lookup.
	 *
	 * @param key - The key to retrieve
	 * @returns The data and metadata, or null if not found
	 */
	async getWithMetadata(key: string): Promise<TierGetResult | null> {
		const entry = this.cache.get(key)

		if (!entry) {
			this.stats.misses++
			return null
		}

		this.stats.hits++
		return { data: entry.data, metadata: entry.metadata }
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
		const entry = this.cache.get(key)

		if (!entry) {
			this.stats.misses++
			return null
		}

		this.stats.hits++

		// Create a readable stream from the buffer
		const stream = Readable.from([entry.data])

		return { stream, metadata: entry.metadata }
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
	async setStream(key: string, stream: NodeJS.ReadableStream, metadata: StorageMetadata): Promise<void> {
		const chunks: Uint8Array[] = []
		let totalLength = 0
		let exceedsSizeLimit = metadata.size > this.config.maxSizeBytes

		for await (const chunk of stream) {
			let data: Uint8Array | undefined
			if (Buffer.isBuffer(chunk)) {
				data = new Uint8Array(chunk)
			} else if (ArrayBuffer.isView(chunk)) {
				data = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
			} else if (typeof chunk === 'string') {
				data = new TextEncoder().encode(chunk)
			}
			if (!data) continue

			totalLength += data.byteLength
			if (totalLength > this.config.maxSizeBytes) {
				exceedsSizeLimit = true
				chunks.length = 0
				continue
			}
			if (!exceedsSizeLimit) {
				chunks.push(data)
			}
		}

		if (exceedsSizeLimit) {
			// Consume the whole stream, but never retain an oversize value or an old
			// value for the same key after its replacement was skipped.
			this.deleteEntry(key)
			return
		}

		const data = new Uint8Array(totalLength)
		let offset = 0
		for (const chunk of chunks) {
			data.set(chunk, offset)
			offset += chunk.length
		}

		await this.set(key, data, metadata)
	}

	async set(key: string, data: Uint8Array, metadata: StorageMetadata): Promise<void> {
		const size = data.byteLength
		const entry: CacheEntry = { data, metadata, size }

		// All cache operations below are synchronous. Keeping the bookkeeping in the
		// same turn prevents two callers that both await set() from accounting for the
		// same replaced entry.
		try {
			// A single oversized value can never fit. Do not evict unrelated cache
			// entries just to exceed the configured hard cap. Remove a prior value for
			// this key so callers cannot receive stale data after a skipped write.
			if (size > this.config.maxSizeBytes) {
				this.deleteEntry(key)
				return
			}

			const existing = this.cache.items[key]?.value
			if (existing) {
				this.cache.delete(key)
				this.currentSize -= existing.size
			}

			this.evictIfNeeded(size)

			// TinyLRU evicts automatically when maxItems is reached. setWithEvicted
			// exposes that victim so byte accounting stays in lockstep with the cache.
			const evicted = this.cache.setWithEvicted(key, entry)
			if (evicted) {
				this.currentSize -= evicted.value.size
				this.stats.evictions++
			}
			this.currentSize += size
		} catch (error) {
			// Keep stats correct if TinyLRU throws after changing its state.
			this.synchronizeSize()
			throw error
		}
	}

	async delete(key: string): Promise<void> {
		this.deleteEntry(key)
	}

	async exists(key: string): Promise<boolean> {
		return this.cache.has(key)
	}

	async *listKeys(prefix?: string): AsyncIterableIterator<string> {
		// TinyLRU returns keys as any[] but they are strings in our usage.
		const keys = this.cache.keys() as string[]
		for (const key of keys) {
			if (!prefix || key.startsWith(prefix)) {
				yield key
			}
		}
	}

	async deleteMany(keys: string[]): Promise<void> {
		for (const key of keys) {
			this.deleteEntry(key)
		}
	}

	async getMetadata(key: string): Promise<StorageMetadata | null> {
		const entry = this.cache.get(key)
		return entry ? entry.metadata : null
	}

	async setMetadata(key: string, metadata: StorageMetadata): Promise<void> {
		const entry = this.cache.get(key)
		if (entry) {
			// Update metadata in place and mark the entry as recently used.
			entry.metadata = metadata
			this.cache.set(key, entry)
		}
	}

	async setMetadataIfChecksumMatches(
		key: string,
		expectedChecksum: string,
		metadata: StorageMetadata,
	): Promise<boolean> {
		const entry = this.cache.get(key)
		if (!entry || entry.metadata.checksum !== expectedChecksum) return false
		entry.metadata = metadata
		this.cache.set(key, entry)
		return true
	}

	async getStats(): Promise<TierStats> {
		this.synchronizeSize()
		return {
			bytes: this.currentSize,
			items: this.cache.size,
			hits: this.stats.hits,
			misses: this.stats.misses,
			evictions: this.stats.evictions,
		}
	}

	async clear(): Promise<void> {
		this.cache.clear()
		this.currentSize = 0
	}

	/**
	 * Recalculate byte usage from the entries that TinyLRU actually retains.
	 */
	private synchronizeSize(): void {
		let size = 0
		for (const key of this.cache.keys() as string[]) {
			const entry = this.cache.items[key]?.value
			if (entry) {
				size += entry.size
			}
		}
		this.currentSize = size
	}

	/**
	 * Delete one entry while maintaining byte accounting.
	 */
	private deleteEntry(key: string): void {
		const entry = this.cache.items[key]?.value
		if (!entry) return

		this.cache.delete(key)
		this.currentSize -= entry.size
	}

	/**
	 * Evict least-recently-used entries until there is space for new data.
	 *
	 * @param incomingSize Size of data being added
	 */
	private evictIfNeeded(incomingSize: number): void {
		while (this.currentSize + incomingSize > this.config.maxSizeBytes && this.cache.size > 0) {
			const entry = this.cache.first?.value
			if (!entry) break

			this.cache.evict()
			this.currentSize -= entry.size
			this.stats.evictions++
		}
	}
}
