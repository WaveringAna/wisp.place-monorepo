import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { StorageMetadata, StorageTier, TierGetResult, TierStats, TierStreamResult } from '../types/index.js'
import { encodeKey } from '../utils/path-encoding.js'

function getErrnoCode(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined
	const maybeCode = (error as { code?: unknown }).code
	return typeof maybeCode === 'string' ? maybeCode : undefined
}

/**
 * Eviction policy for disk tier when size limit is reached.
 */
export type EvictionPolicy = 'lru' | 'fifo' | 'size'

/**
 * Configuration for DiskStorageTier.
 */
export interface DiskStorageTierConfig {
	/**
	 * Directory path where files will be stored.
	 *
	 * @remarks
	 * Created automatically if it doesn't exist.
	 * Files are stored as: `{directory}/{encoded-key}`
	 * Metadata is stored as: `{directory}/{encoded-key}.meta`
	 */
	directory: string

	/**
	 * Optional maximum size in bytes.
	 *
	 * @remarks
	 * When this limit is reached, files are evicted according to the eviction policy.
	 * If not set, no size limit is enforced (grows unbounded).
	 */
	maxSizeBytes?: number

	/**
	 * Eviction policy when maxSizeBytes is reached.
	 *
	 * @defaultValue 'lru'
	 *
	 * @remarks
	 * - 'lru': Evict least-recently-accessed files (based on metadata.lastAccessed)
	 * - 'fifo': Evict oldest files (based on metadata.createdAt)
	 * - 'size': Evict largest files first
	 */
	evictionPolicy?: EvictionPolicy

	/**
	 * Whether to encode colons in keys as %3A.
	 *
	 * @defaultValue true on Windows, false on Unix/macOS
	 *
	 * @remarks
	 * Colons are invalid in Windows filenames but allowed on Unix.
	 * Set to false to preserve colons for human-readable paths on Unix systems.
	 * Set to true on Windows or for cross-platform compatibility.
	 *
	 * @example
	 * ```typescript
	 * // Unix with readable paths
	 * new DiskStorageTier({ directory: './cache', encodeColons: false })
	 * // Result: cache/did:plc:abc123/site/index.html
	 *
	 * // Windows or cross-platform
	 * new DiskStorageTier({ directory: './cache', encodeColons: true })
	 * // Result: cache/did%3Aplc%3Aabc123/site/index.html
	 * ```
	 */
	encodeColons?: boolean
}

/**
 * Filesystem-based storage tier.
 *
 * @remarks
 * - Stores data files and `.meta` JSON files side-by-side
 * - Keys are encoded to be filesystem-safe
 * - Human-readable file structure for debugging
 * - Optional size-based eviction with configurable policy
 * - Zero external dependencies (uses Node.js fs APIs)
 *
 * File structure:
 * ```
 * cache/
 * ├── user%3A123/
 * │	 ├── profile					# Data file (encoded key)
 * │	 └── profile.meta			# Metadata JSON
 * └── did%3Aplc%3Aabc/
 *		 └── site/
 *				 ├── index.html
 *				 └── index.html.meta
 * ```
 *
 * @example
 * ```typescript
 * const tier = new DiskStorageTier({
 *	 directory: './cache',
 *	 maxSizeBytes: 10 * 1024 * 1024 * 1024, // 10GB
 *	 evictionPolicy: 'lru',
 * });
 *
 * await tier.set('key', data, metadata);
 * const retrieved = await tier.get('key');
 * ```
 */
export class DiskStorageTier implements StorageTier {
	private metadataIndex = new Map<string, { size: number; createdAt: Date; lastAccessed: Date }>()
	private currentSize = 0
	private readonly encodeColons: boolean

	constructor(private config: DiskStorageTierConfig) {
		if (!config.directory) {
			throw new Error('directory is required')
		}
		if (config.maxSizeBytes !== undefined && config.maxSizeBytes <= 0) {
			throw new Error('maxSizeBytes must be positive')
		}

		// Default: encode colons on Windows, preserve on Unix/macOS
		const platform = process.platform
		this.encodeColons = config.encodeColons ?? platform === 'win32'

		void this.ensureDirectory()
		void this.rebuildIndex()
	}

	private async rebuildIndex(): Promise<void> {
		if (!existsSync(this.config.directory)) {
			return
		}

		await this.rebuildIndexRecursive(this.config.directory)
	}

	/**
	 * Recursively rebuild index from a directory and its subdirectories.
	 */
	private async rebuildIndexRecursive(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = join(dir, entry.name)

			if (entry.isDirectory()) {
				await this.rebuildIndexRecursive(fullPath)
			} else if (!entry.name.endsWith('.meta')) {
				try {
					const metaPath = `${fullPath}.meta`
					const metaContent = await readFile(metaPath, 'utf-8')
					const metadata = JSON.parse(metaContent) as StorageMetadata
					const fileStats = await stat(fullPath)

					this.metadataIndex.set(metadata.key, {
						size: fileStats.size,
						createdAt: new Date(metadata.createdAt),
						lastAccessed: new Date(metadata.lastAccessed),
					})

					this.currentSize += fileStats.size
				} catch {}
			}
		}
	}

	async get(key: string): Promise<Uint8Array | null> {
		const filePath = this.getFilePath(key)

		try {
			const data = await readFile(filePath)
			return new Uint8Array(data)
		} catch (error) {
			const code = getErrnoCode(error)
			if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
				return null
			}
			throw error
		}
	}

	/**
	 * Retrieve data and metadata together in a single operation.
	 *
	 * @param key - The key to retrieve
	 * @returns The data and metadata, or null if not found
	 *
	 * @remarks
	 * Reads data and metadata files in parallel for better performance.
	 */
	async getWithMetadata(key: string): Promise<TierGetResult | null> {
		const filePath = this.getFilePath(key)
		const metaPath = this.getMetaPath(key)

		try {
			// Read data and metadata in parallel
			const [dataBuffer, metaContent] = await Promise.all([readFile(filePath), readFile(metaPath, 'utf-8')])

			if (!metaContent.trim()) {
				return null
			}
			const metadata = JSON.parse(metaContent) as StorageMetadata

			// Convert date strings back to Date objects
			metadata.createdAt = new Date(metadata.createdAt)
			metadata.lastAccessed = new Date(metadata.lastAccessed)
			if (metadata.ttl) {
				metadata.ttl = new Date(metadata.ttl)
			}

			return { data: new Uint8Array(dataBuffer), metadata }
		} catch (error) {
			const code = getErrnoCode(error)
			if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
				return null
			}
			if (error instanceof SyntaxError) {
				return null
			}
			throw error
		}
	}

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
	async getStream(key: string): Promise<TierStreamResult | null> {
		const filePath = this.getFilePath(key)
		const metaPath = this.getMetaPath(key)

		try {
			// Read metadata first to verify file exists
			const metaContent = await readFile(metaPath, 'utf-8')
			if (!metaContent.trim()) {
				return null
			}
			const metadata = JSON.parse(metaContent) as StorageMetadata

			// Convert date strings back to Date objects
			metadata.createdAt = new Date(metadata.createdAt)
			metadata.lastAccessed = new Date(metadata.lastAccessed)
			if (metadata.ttl) {
				metadata.ttl = new Date(metadata.ttl)
			}

			// Guard against directories being treated as files (causes EISDIR at read time).
			const dataStat = await stat(filePath)
			if (!dataStat.isFile()) {
				return null
			}

			// Create stream - will throw if file doesn't exist
			const stream = createReadStream(filePath)

			return { stream, metadata }
		} catch (error) {
			const code = getErrnoCode(error)
			if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
				return null
			}
			if (error instanceof SyntaxError) {
				return null
			}
			throw error
		}
	}

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
	async setStream(key: string, stream: NodeJS.ReadableStream, metadata: StorageMetadata): Promise<void> {
		const filePath = this.getFilePath(key)
		const metaPath = this.getMetaPath(key)

		const dir = dirname(filePath)
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true })
		}

		const existingEntry = this.metadataIndex.get(key)
		if (existingEntry) {
			this.currentSize -= existingEntry.size
		}

		if (this.config.maxSizeBytes) {
			await this.evictIfNeeded(metadata.size)
		}

		// Write metadata first atomically so readers never observe partial JSON.
		await this.writeMetadataAtomically(metaPath, metadata)

		// Stream data to file
		const writeStream = createWriteStream(filePath)
		await pipeline(stream, writeStream)

		this.metadataIndex.set(key, {
			size: metadata.size,
			createdAt: metadata.createdAt,
			lastAccessed: metadata.lastAccessed,
		})
		this.currentSize += metadata.size
	}

	async set(key: string, data: Uint8Array, metadata: StorageMetadata): Promise<void> {
		const filePath = this.getFilePath(key)
		const metaPath = this.getMetaPath(key)

		const dir = dirname(filePath)
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true })
		}

		const existingEntry = this.metadataIndex.get(key)
		if (existingEntry) {
			this.currentSize -= existingEntry.size
		}

		if (this.config.maxSizeBytes) {
			await this.evictIfNeeded(data.byteLength)
		}

		await this.writeMetadataAtomically(metaPath, metadata)
		await writeFile(filePath, data)

		this.metadataIndex.set(key, {
			size: data.byteLength,
			createdAt: metadata.createdAt,
			lastAccessed: metadata.lastAccessed,
		})
		this.currentSize += data.byteLength
	}

	async delete(key: string): Promise<void> {
		const filePath = this.getFilePath(key)
		const metaPath = this.getMetaPath(key)

		const entry = this.metadataIndex.get(key)
		if (entry) {
			this.currentSize -= entry.size
			this.metadataIndex.delete(key)
		}

		await Promise.all([unlink(filePath).catch(() => {}), unlink(metaPath).catch(() => {})])

		// Clean up empty parent directories
		await this.cleanupEmptyDirectories(dirname(filePath))
	}

	async exists(key: string): Promise<boolean> {
		const filePath = this.getFilePath(key)
		try {
			const fileStat = await stat(filePath)
			return fileStat.isFile()
		} catch (error) {
			const code = getErrnoCode(error)
			if (code === 'ENOENT' || code === 'ENOTDIR') {
				return false
			}
			throw error
		}
	}

	async *listKeys(prefix?: string): AsyncIterableIterator<string> {
		if (!existsSync(this.config.directory)) {
			return
		}

		// Recursively list all files in directory tree
		for await (const key of this.listKeysRecursive(this.config.directory, prefix)) {
			yield key
		}
	}

	/**
	 * Recursively list keys from a directory and its subdirectories.
	 */
	private async *listKeysRecursive(dir: string, prefix?: string): AsyncIterableIterator<string> {
		const entries = await readdir(dir, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = join(dir, entry.name)

			if (entry.isDirectory()) {
				// Recurse into subdirectory
				for await (const key of this.listKeysRecursive(fullPath, prefix)) {
					yield key
				}
			} else if (!entry.name.endsWith('.meta')) {
				// Data file - read metadata to get original key
				const metaPath = `${fullPath}.meta`
				try {
					const metaContent = await readFile(metaPath, 'utf-8')
					const metadata = JSON.parse(metaContent) as StorageMetadata
					const originalKey = metadata.key

					if (!prefix || originalKey.startsWith(prefix)) {
						yield originalKey
					}
				} catch {}
			}
		}
	}

	async deleteMany(keys: string[]): Promise<void> {
		await Promise.all(keys.map((key) => this.delete(key)))
	}

	async getMetadata(key: string): Promise<StorageMetadata | null> {
		const metaPath = this.getMetaPath(key)

		try {
			const content = await readFile(metaPath, 'utf-8')
			if (!content.trim()) {
				return null
			}
			const metadata = JSON.parse(content) as StorageMetadata

			// Convert date strings back to Date objects
			metadata.createdAt = new Date(metadata.createdAt)
			metadata.lastAccessed = new Date(metadata.lastAccessed)
			if (metadata.ttl) {
				metadata.ttl = new Date(metadata.ttl)
			}

			return metadata
		} catch (error) {
			const code = getErrnoCode(error)
			if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
				return null
			}
			if (error instanceof SyntaxError) {
				return null
			}
			throw error
		}
	}

	async setMetadata(key: string, metadata: StorageMetadata): Promise<void> {
		const metaPath = this.getMetaPath(key)

		// Ensure parent directory exists
		const dir = dirname(metaPath)
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true })
		}

		await this.writeMetadataAtomically(metaPath, metadata)
	}

	async getStats(): Promise<TierStats> {
		if (!existsSync(this.config.directory)) {
			return { bytes: 0, items: 0 }
		}

		return this.getStatsRecursive(this.config.directory)
	}

	/**
	 * Recursively collect stats from a directory and its subdirectories.
	 */
	private async getStatsRecursive(dir: string): Promise<TierStats> {
		let bytes = 0
		let items = 0

		const entries = await readdir(dir, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = join(dir, entry.name)

			if (entry.isDirectory()) {
				const subStats = await this.getStatsRecursive(fullPath)
				bytes += subStats.bytes
				items += subStats.items
			} else if (!entry.name.endsWith('.meta')) {
				const fileStats = await stat(fullPath)
				bytes += fileStats.size
				items++
			}
		}

		return { bytes, items }
	}

	async clear(): Promise<void> {
		if (existsSync(this.config.directory)) {
			await rm(this.config.directory, { recursive: true, force: true })
			await this.ensureDirectory()
			this.metadataIndex.clear()
			this.currentSize = 0
		}
	}

	/**
	 * Clean up empty parent directories after file deletion.
	 *
	 * @param dirPath - Directory path to start cleanup from
	 *
	 * @remarks
	 * Recursively removes empty directories up to (but not including) the base directory.
	 * This prevents directory bloat when files with nested paths are deleted.
	 */
	private async cleanupEmptyDirectories(dirPath: string): Promise<void> {
		// Don't remove the base directory
		if (dirPath === this.config.directory || !dirPath.startsWith(this.config.directory)) {
			return
		}

		try {
			const entries = await readdir(dirPath)
			// If directory is empty, remove it and recurse to parent
			if (entries.length === 0) {
				await rm(dirPath, { recursive: false })
				await this.cleanupEmptyDirectories(dirname(dirPath))
			}
		} catch {
			// Directory doesn't exist or can't be read - that's fine
			return
		}
	}

	/**
	 * Atomically write metadata to avoid readers seeing partial JSON.
	 */
	private async writeMetadataAtomically(metaPath: string, metadata: StorageMetadata): Promise<void> {
		const tempMetaPath = `${metaPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
		try {
			await writeFile(tempMetaPath, JSON.stringify(metadata, null, 2))
			await rename(tempMetaPath, metaPath)
		} catch (error) {
			await unlink(tempMetaPath).catch(() => {})
			throw error
		}
	}

	/**
	 * Get the filesystem path for a key's data file.
	 */
	private getFilePath(key: string): string {
		const encoded = encodeKey(key, this.encodeColons)
		return join(this.config.directory, encoded)
	}

	/**
	 * Get the filesystem path for a key's metadata file.
	 */
	private getMetaPath(key: string): string {
		return `${this.getFilePath(key)}.meta`
	}

	private async ensureDirectory(): Promise<void> {
		await mkdir(this.config.directory, { recursive: true }).catch(() => {})
	}

	private async evictIfNeeded(incomingSize: number): Promise<void> {
		if (!this.config.maxSizeBytes) {
			return
		}

		if (this.currentSize + incomingSize <= this.config.maxSizeBytes) {
			return
		}

		const entries = Array.from(this.metadataIndex.entries()).map(([key, info]) => ({
			key,
			...info,
		}))

		const policy = this.config.evictionPolicy ?? 'lru'
		entries.sort((a, b) => {
			switch (policy) {
				case 'lru':
					return a.lastAccessed.getTime() - b.lastAccessed.getTime()
				case 'fifo':
					return a.createdAt.getTime() - b.createdAt.getTime()
				case 'size':
					return b.size - a.size
				default:
					return 0
			}
		})

		for (const entry of entries) {
			if (this.currentSize + incomingSize <= this.config.maxSizeBytes) {
				break
			}

			await this.delete(entry.key)
		}
	}
}
