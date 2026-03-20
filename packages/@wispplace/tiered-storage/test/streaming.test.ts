import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { TieredStorage } from '../src/TieredStorage.js'
import { DiskStorageTier } from '../src/tiers/DiskStorageTier.js'
import { MemoryStorageTier } from '../src/tiers/MemoryStorageTier.js'

const testDir = './test-streaming-cache'

describe('Streaming Operations', () => {
	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	afterAll(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	/**
	 * Helper to create a readable stream from a string or buffer
	 */
	function createStream(data: string | Buffer): Readable {
		return Readable.from([Buffer.from(data)])
	}

	/**
	 * Helper to consume a stream and return its contents as a buffer
	 */
	async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
		const chunks: Buffer[] = []
		for await (const chunk of stream) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
		}
		return Buffer.concat(chunks)
	}

	/**
	 * Helper to compute SHA256 checksum of a buffer
	 */
	function computeChecksum(data: Buffer): string {
		return createHash('sha256').update(data).digest('hex')
	}

	describe('DiskStorageTier Streaming', () => {
		test('should write and read data using streams', async () => {
			const tier = new DiskStorageTier({ directory: testDir })

			const testData = 'Hello, streaming world! '.repeat(100)
			const testBuffer = Buffer.from(testData)
			const checksum = computeChecksum(testBuffer)

			const metadata = {
				key: 'streaming-test.txt',
				size: testBuffer.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum,
			}

			// Write using stream
			await tier.setStream('streaming-test.txt', createStream(testData), metadata)

			// Verify file exists
			expect(await tier.exists('streaming-test.txt')).toBe(true)

			// Read using stream
			const result = await tier.getStream('streaming-test.txt')
			expect(result).not.toBeNull()

			const retrievedData = await streamToBuffer(result!.stream)
			expect(retrievedData.toString()).toBe(testData)
			expect(result!.metadata.key).toBe('streaming-test.txt')
		})

		test('should handle large data without memory issues', async () => {
			const tier = new DiskStorageTier({ directory: testDir })

			// Create a 1MB chunk and repeat pattern
			const chunkSize = 1024 * 1024 // 1MB
			const chunk = Buffer.alloc(chunkSize, 'x')

			const metadata = {
				key: 'large-file.bin',
				size: chunkSize,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: computeChecksum(chunk),
			}

			// Write using stream
			await tier.setStream('large-file.bin', Readable.from([chunk]), metadata)

			// Read using stream
			const result = await tier.getStream('large-file.bin')
			expect(result).not.toBeNull()

			const retrievedData = await streamToBuffer(result!.stream)
			expect(retrievedData.length).toBe(chunkSize)
			expect(retrievedData.equals(chunk)).toBe(true)
		})

		test('should return null for non-existent key', async () => {
			const tier = new DiskStorageTier({ directory: testDir })

			const result = await tier.getStream('non-existent-key')
			expect(result).toBeNull()
		})

		test('should handle nested directories with streaming', async () => {
			const tier = new DiskStorageTier({ directory: testDir })

			const testData = 'nested streaming data'
			const testBuffer = Buffer.from(testData)

			const metadata = {
				key: 'deep/nested/path/file.txt',
				size: testBuffer.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: computeChecksum(testBuffer),
			}

			await tier.setStream('deep/nested/path/file.txt', createStream(testData), metadata)

			const result = await tier.getStream('deep/nested/path/file.txt')
			expect(result).not.toBeNull()

			const retrievedData = await streamToBuffer(result!.stream)
			expect(retrievedData.toString()).toBe(testData)
		})
	})

	describe('MemoryStorageTier Streaming', () => {
		test('should write and read data using streams', async () => {
			const tier = new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 })

			const testData = 'Memory tier streaming test'
			const testBuffer = Buffer.from(testData)

			const metadata = {
				key: 'memory-test.txt',
				size: testBuffer.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: computeChecksum(testBuffer),
			}

			// Write using stream
			await tier.setStream('memory-test.txt', createStream(testData), metadata)

			// Read using stream
			const result = await tier.getStream('memory-test.txt')
			expect(result).not.toBeNull()

			const retrievedData = await streamToBuffer(result!.stream)
			expect(retrievedData.toString()).toBe(testData)
		})

		test('should return null for non-existent key', async () => {
			const tier = new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 })

			const result = await tier.getStream('non-existent-key')
			expect(result).toBeNull()
		})
	})

	describe('TieredStorage Streaming', () => {
		test('should store and retrieve data using streams', async () => {
			const storage = new TieredStorage({
				tiers: {
					hot: new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 }),
					warm: new DiskStorageTier({ directory: `${testDir}/warm` }),
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			const testData = 'TieredStorage streaming test data'
			const testBuffer = Buffer.from(testData)

			// Write using stream
			const setResult = await storage.setStream('stream-key', createStream(testData), {
				size: testBuffer.byteLength,
			})

			expect(setResult.key).toBe('stream-key')
			expect(setResult.metadata.size).toBe(testBuffer.byteLength)
			// Hot tier is skipped by default for streaming
			expect(setResult.tiersWritten).not.toContain('hot')
			expect(setResult.tiersWritten).toContain('warm')
			expect(setResult.tiersWritten).toContain('cold')

			// Read using stream
			const result = await storage.getStream('stream-key')
			expect(result).not.toBeNull()

			const retrievedData = await streamToBuffer(result!.stream)
			expect(retrievedData.toString()).toBe(testData)
		})

		test('should compute checksum during streaming write', async () => {
			const storage = new TieredStorage({
				tiers: {
					warm: new DiskStorageTier({ directory: `${testDir}/warm` }),
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			const testData = 'Data for checksum test'
			const testBuffer = Buffer.from(testData)
			const expectedChecksum = computeChecksum(testBuffer)

			const setResult = await storage.setStream('checksum-test', createStream(testData), {
				size: testBuffer.byteLength,
			})

			// Checksum should be computed and stored
			expect(setResult.metadata.checksum).toBe(expectedChecksum)
		})

		test('should use provided checksum without computing', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			const testData = 'Data with pre-computed checksum'
			const testBuffer = Buffer.from(testData)
			const providedChecksum = 'my-custom-checksum'

			const setResult = await storage.setStream('custom-checksum', createStream(testData), {
				size: testBuffer.byteLength,
				checksum: providedChecksum,
			})

			expect(setResult.metadata.checksum).toBe(providedChecksum)
		})

		test('should return null for non-existent key', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			const result = await storage.getStream('non-existent')
			expect(result).toBeNull()
		})

		test('should read from appropriate tier (warm before cold)', async () => {
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { warm, cold },
			})

			const testData = 'Tier priority test data'
			const testBuffer = Buffer.from(testData)

			await storage.setStream('tier-test', createStream(testData), {
				size: testBuffer.byteLength,
			})

			// Both tiers should have the data
			expect(await warm.exists('tier-test')).toBe(true)
			expect(await cold.exists('tier-test')).toBe(true)

			// Read should come from warm (first available)
			const result = await storage.getStream('tier-test')
			expect(result).not.toBeNull()
			expect(result!.source).toBe('warm')
		})

		test('should fall back to cold tier when warm has no data', async () => {
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { warm, cold },
			})

			// Write directly to cold only
			const testData = 'Cold tier only data'
			const testBuffer = Buffer.from(testData)
			const metadata = {
				key: 'cold-only',
				size: testBuffer.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: computeChecksum(testBuffer),
			}

			await cold.setStream('cold-only', createStream(testData), metadata)

			// Read should come from cold
			const result = await storage.getStream('cold-only')
			expect(result).not.toBeNull()
			expect(result!.source).toBe('cold')
		})

		test('should handle TTL with metadata', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
				defaultTTL: 60000, // 1 minute
			})

			const testData = 'TTL test data'
			const testBuffer = Buffer.from(testData)

			const setResult = await storage.setStream('ttl-test', createStream(testData), {
				size: testBuffer.byteLength,
				ttl: 30000, // 30 seconds
			})

			expect(setResult.metadata.ttl).toBeDefined()
			expect(setResult.metadata.ttl!.getTime()).toBeGreaterThan(Date.now())
		})

		test('should include mimeType in metadata', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			const testData = '{"message": "json data"}'
			const testBuffer = Buffer.from(testData)

			const setResult = await storage.setStream('json-file.json', createStream(testData), {
				size: testBuffer.byteLength,
				mimeType: 'application/json',
			})

			expect(setResult.metadata.mimeType).toBe('application/json')
		})

		test('should write to multiple tiers simultaneously', async () => {
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { warm, cold },
			})

			const testData = 'Multi-tier streaming data'
			const testBuffer = Buffer.from(testData)

			await storage.setStream('multi-tier', createStream(testData), {
				size: testBuffer.byteLength,
			})

			// Verify data in both tiers
			const warmResult = await warm.getStream('multi-tier')
			const coldResult = await cold.getStream('multi-tier')

			expect(warmResult).not.toBeNull()
			expect(coldResult).not.toBeNull()

			const warmData = await streamToBuffer(warmResult!.stream)
			const coldData = await streamToBuffer(coldResult!.stream)

			expect(warmData.toString()).toBe(testData)
			expect(coldData.toString()).toBe(testData)
		})

		test('should skip hot tier by default for streaming writes', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
			})

			const testData = 'Skip hot tier test'
			const testBuffer = Buffer.from(testData)

			const setResult = await storage.setStream('skip-hot', createStream(testData), {
				size: testBuffer.byteLength,
			})

			// Hot should be skipped by default
			expect(setResult.tiersWritten).not.toContain('hot')
			expect(await hot.exists('skip-hot')).toBe(false)

			// Warm and cold should have data
			expect(setResult.tiersWritten).toContain('warm')
			expect(setResult.tiersWritten).toContain('cold')
		})

		test('should allow including hot tier explicitly', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, cold },
			})

			const testData = 'Include hot tier test'
			const testBuffer = Buffer.from(testData)

			const setResult = await storage.setStream('include-hot', createStream(testData), {
				size: testBuffer.byteLength,
				skipTiers: [], // Don't skip any tiers
			})

			// Hot should be included
			expect(setResult.tiersWritten).toContain('hot')
			expect(await hot.exists('include-hot')).toBe(true)
		})
	})

	describe('Streaming with Compression', () => {
		test('should compress stream data when compression is enabled', async () => {
			const storage = new TieredStorage({
				tiers: {
					warm: new DiskStorageTier({ directory: `${testDir}/warm` }),
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
				compression: true,
			})

			const testData = 'Compressible data '.repeat(100) // Repeating data compresses well
			const testBuffer = Buffer.from(testData)

			const setResult = await storage.setStream('compress-test', createStream(testData), {
				size: testBuffer.byteLength,
			})

			// Metadata should indicate compression
			expect(setResult.metadata.compressed).toBe(true)
			// Checksum should be of original uncompressed data
			expect(setResult.metadata.checksum).toBe(computeChecksum(testBuffer))
		})

		test('should decompress stream data automatically on read', async () => {
			const storage = new TieredStorage({
				tiers: {
					warm: new DiskStorageTier({ directory: `${testDir}/warm` }),
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
				compression: true,
			})

			const testData = 'Hello, compressed world! '.repeat(50)
			const testBuffer = Buffer.from(testData)

			await storage.setStream('decompress-test', createStream(testData), {
				size: testBuffer.byteLength,
			})

			// Read back via stream
			const result = await storage.getStream('decompress-test')
			expect(result).not.toBeNull()
			expect(result!.metadata.compressed).toBe(true)

			// Stream should be decompressed automatically
			const retrievedData = await streamToBuffer(result!.stream)
			expect(retrievedData.toString()).toBe(testData)
		})

		test('should not compress when compression is disabled', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
				compression: false,
			})

			const testData = 'Uncompressed data '.repeat(50)
			const testBuffer = Buffer.from(testData)

			const setResult = await storage.setStream('no-compress-test', createStream(testData), {
				size: testBuffer.byteLength,
			})

			expect(setResult.metadata.compressed).toBe(false)

			// Read back - should be exact same data
			const result = await storage.getStream('no-compress-test')
			expect(result).not.toBeNull()

			const retrievedData = await streamToBuffer(result!.stream)
			expect(retrievedData.toString()).toBe(testData)
		})

		test('should preserve checksum of original data when compressed', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
				compression: true,
			})

			const testData = 'Data for checksum verification '.repeat(100)
			const testBuffer = Buffer.from(testData)
			const expectedChecksum = computeChecksum(testBuffer)

			const setResult = await storage.setStream('checksum-compress', createStream(testData), {
				size: testBuffer.byteLength,
			})

			// Checksum should match the ORIGINAL uncompressed data
			expect(setResult.metadata.checksum).toBe(expectedChecksum)

			// Read back and verify content matches
			const result = await storage.getStream('checksum-compress')
			const retrievedData = await streamToBuffer(result!.stream)
			expect(computeChecksum(retrievedData)).toBe(expectedChecksum)
		})
	})

	describe('Edge Cases', () => {
		test('should handle empty streams', async () => {
			const tier = new DiskStorageTier({ directory: testDir })

			const metadata = {
				key: 'empty-file.txt',
				size: 0,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: computeChecksum(Buffer.from('')),
			}

			await tier.setStream('empty-file.txt', createStream(''), metadata)

			const result = await tier.getStream('empty-file.txt')
			expect(result).not.toBeNull()

			const data = await streamToBuffer(result!.stream)
			expect(data.length).toBe(0)
		})

		test('should preserve binary data integrity', async () => {
			const tier = new DiskStorageTier({ directory: testDir })

			// Create binary data with all possible byte values
			const binaryData = Buffer.alloc(256)
			for (let i = 0; i < 256; i++) {
				binaryData[i] = i
			}

			const metadata = {
				key: 'binary-file.bin',
				size: binaryData.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: computeChecksum(binaryData),
			}

			await tier.setStream('binary-file.bin', Readable.from([binaryData]), metadata)

			const result = await tier.getStream('binary-file.bin')
			expect(result).not.toBeNull()

			const retrievedData = await streamToBuffer(result!.stream)
			expect(retrievedData.equals(binaryData)).toBe(true)
		})

		test('should handle special characters in keys', async () => {
			const tier = new DiskStorageTier({ directory: testDir })

			const testData = 'special key test'
			const testBuffer = Buffer.from(testData)

			const specialKey = 'user:123/file[1].txt'
			const metadata = {
				key: specialKey,
				size: testBuffer.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: computeChecksum(testBuffer),
			}

			await tier.setStream(specialKey, createStream(testData), metadata)

			const result = await tier.getStream(specialKey)
			expect(result).not.toBeNull()
			expect(result!.metadata.key).toBe(specialKey)
		})
	})
})
