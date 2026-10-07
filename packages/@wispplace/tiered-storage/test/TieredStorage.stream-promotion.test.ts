import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { TieredStorage } from '../src/TieredStorage.js'
import { DiskStorageTier } from '../src/tiers/DiskStorageTier.js'
import { MemoryStorageTier } from '../src/tiers/MemoryStorageTier.js'
import type { StorageMetadata, TieredStorageConfig } from '../src/types/index.js'

const KEY = 'did:plc:a/site/photo.png'

function metadata(key: string, size: number): StorageMetadata {
	return {
		key,
		size,
		createdAt: new Date(),
		lastAccessed: new Date(),
		accessCount: 0,
		compressed: false,
		checksum: 'test',
	}
}

const bytes = (size: number, fill = 7) => new Uint8Array(size).fill(fill)

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = []
	for await (const chunk of stream) chunks.push(chunk as Buffer)
	return Buffer.concat(chunks)
}

let directory: string
let hot: MemoryStorageTier
let warm: DiskStorageTier
let cold: MemoryStorageTier
let coldCalls: { getStream: number; getMetadata: number; setMetadata: number }

function createStorage(config: Partial<TieredStorageConfig> = {}): TieredStorage<Uint8Array> {
	return new TieredStorage<Uint8Array>({
		tiers: { hot, warm, cold },
		promotionStrategy: 'eager',
		serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
		...config,
	})
}

/** Replace the cold stream for the next read with one the test writes to. */
function controlNextColdStream(): PassThrough {
	const stream = new PassThrough()
	const original = cold.getStream.bind(cold)
	cold.getStream = async (key, options) => {
		cold.getStream = original
		const result = await original(key, options)
		return result && { stream, metadata: result.metadata }
	}
	return stream
}

const stagingEntries = async () => readdir(join(directory, '.staging')).catch(() => [])

describe('TieredStorage streamed-read promotion', () => {
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'tiered-storage-stream-promotion-'))
		hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		warm = new DiskStorageTier({ directory })
		cold = new MemoryStorageTier({ maxSizeBytes: 64 * 1024 * 1024 })
		coldCalls = { getStream: 0, getMetadata: 0, setMetadata: 0 }
		for (const method of Object.keys(coldCalls) as Array<keyof typeof coldCalls>) {
			const original = (cold[method] as (...args: never[]) => unknown).bind(cold)
			;(cold as unknown as Record<string, unknown>)[method] = (...args: never[]) => {
				coldCalls[method]++
				return original(...args)
			}
		}
	})
	afterEach(async () => rm(directory, { recursive: true, force: true }))

	test('copies a cold read into warm so later reads stop reaching cold', async () => {
		const data = bytes(300 * 1024)
		await cold.set(KEY, data, metadata(KEY, data.byteLength))
		const storage = createStorage()

		const first = await storage.getStream(KEY)
		expect(first?.source).toBe('cold')
		expect(await readAll(first!.stream)).toEqual(Buffer.from(data))

		const second = await storage.getStream(KEY)
		expect(second?.source).toBe('warm')
		expect(await readAll(second!.stream)).toEqual(Buffer.from(data))
		expect(coldCalls.getStream).toBe(1)
		expect(await stagingEntries()).toEqual([])
	})

	test('never reads or rewrites cold metadata for access stats', async () => {
		const data = bytes(1024)
		await cold.set(KEY, data, metadata(KEY, data.byteLength))
		const storage = createStorage({ promotionStrategy: 'lazy' })

		for (let read = 0; read < 3; read++) await readAll((await storage.getStream(KEY))!.stream)
		await storage.get(KEY)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(coldCalls.getMetadata).toBe(0)
		expect(coldCalls.setMetadata).toBe(0)
	})

	test('promotes to hot only when placement allows it and the object is small', async () => {
		const small = 'did:plc:a/site/app.css'
		const large = 'did:plc:a/site/vendor.js'
		const media = 'did:plc:a/site/icon.png'
		for (const [key, size] of [
			[small, 1024],
			[large, 4096],
			[media, 1024],
		] as const) {
			await cold.set(key, bytes(size), metadata(key, size))
		}
		const storage = createStorage({
			streamHotPromotionMaxBytes: 2048,
			placementRules: [
				{ pattern: '**/*.{css,js}', tiers: ['hot', 'warm', 'cold'] },
				{ pattern: '**', tiers: ['warm', 'cold'] },
			],
		})

		for (const key of [small, large, media]) await readAll((await storage.getStream(key))!.stream)
		expect(await hot.exists(small)).toBe(true)
		expect(await hot.exists(large)).toBe(false)
		expect(await hot.exists(media)).toBe(false)
		for (const key of [small, large, media]) expect(await warm.exists(key)).toBe(true)
		expect((await storage.getStream(small))?.source).toBe('hot')
	})

	test('promotes a warm read into hot', async () => {
		const data = bytes(1024)
		await warm.set(KEY, data, metadata(KEY, data.byteLength))
		const storage = createStorage()

		const result = await storage.getStream(KEY)
		expect(result?.source).toBe('warm')
		await readAll(result!.stream)
		expect(await hot.get(KEY)).toEqual(data)
	})

	test('does not promote with the lazy strategy', async () => {
		await cold.set(KEY, bytes(1024), metadata(KEY, 1024))
		const storage = createStorage({ promotionStrategy: 'lazy' })

		await readAll((await storage.getStream(KEY))!.stream)
		expect(await warm.exists(KEY)).toBe(false)
		expect(await hot.exists(KEY)).toBe(false)
	})

	test('a stream destroyed before its end leaves no partial object', async () => {
		await cold.set(KEY, bytes(1024), metadata(KEY, 1024))
		const source = controlNextColdStream()
		const storage = createStorage()

		const result = await storage.getStream(KEY)
		const stream = result!.stream as Readable
		source.write(bytes(512))
		await new Promise((resolve) => stream.once('data', resolve))
		stream.destroy()
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(source.destroyed).toBe(true)
		expect(await warm.exists(KEY)).toBe(false)
		expect(await hot.exists(KEY)).toBe(false)
		expect(await stagingEntries()).toEqual([])
	})

	test('a failed source stream leaves no partial object', async () => {
		await cold.set(KEY, bytes(1024), metadata(KEY, 1024))
		const source = controlNextColdStream()
		const storage = createStorage()

		const result = await storage.getStream(KEY)
		source.write(bytes(512))
		source.destroy(new Error('connection reset'))
		await expect(readAll(result!.stream)).rejects.toThrow('connection reset')
		await new Promise((resolve) => setTimeout(resolve, 10))

		expect(await warm.exists(KEY)).toBe(false)
		expect(await stagingEntries()).toEqual([])
	})

	test('a source that ends short of its recorded size is not promoted', async () => {
		await cold.set(KEY, bytes(1024), metadata(KEY, 1024))
		const source = controlNextColdStream()
		const storage = createStorage()

		const result = await storage.getStream(KEY)
		source.end(bytes(512))
		expect((await readAll(result!.stream)).byteLength).toBe(512)

		expect(await warm.exists(KEY)).toBe(false)
		expect(await hot.exists(KEY)).toBe(false)
		expect(await stagingEntries()).toEqual([])
	})

	test('an invalidation during the stream discards its promotion', async () => {
		await cold.set(KEY, bytes(1024), metadata(KEY, 1024))
		const source = controlNextColdStream()
		const storage = createStorage()

		const result = await storage.getStream(KEY)
		const body = readAll(result!.stream)
		source.write(bytes(512))
		await storage.invalidateUpperCacheKey(KEY)
		source.end(bytes(512))
		expect((await body).byteLength).toBe(1024)

		expect(await warm.exists(KEY)).toBe(false)
		expect(await hot.exists(KEY)).toBe(false)
		expect(await stagingEntries()).toEqual([])
	})

	test('a write during the stream wins over the stale streamed bytes', async () => {
		await cold.set(KEY, bytes(1024, 1), metadata(KEY, 1024))
		const source = controlNextColdStream()
		const storage = createStorage()

		const result = await storage.getStream(KEY)
		const body = readAll(result!.stream)
		source.write(bytes(512, 1))
		const fresh = bytes(1024, 2)
		const write = storage.set(KEY, fresh)
		source.end(bytes(512, 1))
		await body
		await write

		expect(await warm.get(KEY)).toEqual(fresh)
		expect(await hot.get(KEY)).toEqual(fresh)
		expect(await stagingEntries()).toEqual([])
	})

	test('concurrent cold reads of one key stage a single copy', async () => {
		await cold.set(KEY, bytes(1024), metadata(KEY, 1024))
		const storage = createStorage()
		let staged = 0
		const stageWrite = warm.stageWrite.bind(warm)
		warm.stageWrite = async (...args) => {
			staged++
			return stageWrite(...args)
		}

		const reads = await Promise.all([storage.getStream(KEY), storage.getStream(KEY)])
		await Promise.all(reads.map((result) => readAll(result!.stream)))
		expect(reads.map((result) => result?.source)).toEqual(['cold', 'cold'])
		expect(staged).toBe(1)
		expect(await warm.exists(KEY)).toBe(true)
	})
})

describe('DiskStorageTier staged writes', () => {
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'disk-tier-staged-'))
		warm = new DiskStorageTier({ directory })
	})
	afterEach(async () => rm(directory, { recursive: true, force: true }))

	test('stay invisible until commit and are published whole', async () => {
		const staged = await warm.stageWrite(KEY, metadata(KEY, 6))
		await staged.write(new TextEncoder().encode('abc'))
		await staged.write(new TextEncoder().encode('def'))
		expect(await warm.exists(KEY)).toBe(false)
		const keys: string[] = []
		for await (const key of warm.listKeys()) keys.push(key)
		expect(keys).toEqual([])
		expect((await warm.getStats()).items).toBe(0)

		await staged.commit()
		expect(new TextDecoder().decode((await warm.get(KEY))!)).toBe('abcdef')
		expect((await warm.getStats()).bytes).toBe(6)
		expect(await stagingEntries()).toEqual([])
	})

	test('abort removes the staged bytes and a later commit is a no-op', async () => {
		const staged = await warm.stageWrite(KEY, metadata(KEY, 3))
		await staged.write(new TextEncoder().encode('abc'))
		await staged.abort()
		await staged.commit()
		expect(await warm.exists(KEY)).toBe(false)
		expect(await stagingEntries()).toEqual([])
	})

	test('a commit larger than the tier cap removes the stale entry instead', async () => {
		const capped = new DiskStorageTier({ directory, maxSizeBytes: 4 })
		await capped.set(KEY, bytes(2), metadata(KEY, 2))
		const staged = await capped.stageWrite(KEY, metadata(KEY, 8))
		await staged.write(bytes(8))
		await staged.commit()
		expect(await capped.exists(KEY)).toBe(false)
		expect(await stagingEntries()).toEqual([])
	})

	test('startup removes staging files abandoned by a previous process', async () => {
		const staged = await warm.stageWrite(KEY, metadata(KEY, 3))
		await staged.write(bytes(3))
		expect(await stagingEntries()).toHaveLength(1)

		const restarted = new DiskStorageTier({ directory })
		await restarted.getStats()
		expect(await stagingEntries()).toEqual([])
		expect(await restarted.exists(KEY)).toBe(false)
	})
})
