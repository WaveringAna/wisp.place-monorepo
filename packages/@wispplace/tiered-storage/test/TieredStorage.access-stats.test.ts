import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TieredStorage } from '../src/TieredStorage.js'
import { DiskStorageTier } from '../src/tiers/DiskStorageTier.js'
import { MemoryStorageTier } from '../src/tiers/MemoryStorageTier.js'
import type { StorageMetadata, TieredStorageConfig } from '../src/types/index.js'

function metadata(key: string, size: number, lastAccessed = new Date()): StorageMetadata {
	return { key, size, createdAt: lastAccessed, lastAccessed, accessCount: 0, compressed: false, checksum: `c-${key}` }
}

const bytes = (size: number) => new Uint8Array(size).fill(7)

let directory: string
let warm: DiskStorageTier
let cold: MemoryStorageTier
let metadataWrites: number

function createStorage(config: Partial<TieredStorageConfig> = {}): TieredStorage<Uint8Array> {
	return new TieredStorage<Uint8Array>({
		tiers: { warm, cold },
		promotionStrategy: 'eager',
		serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
		...config,
	})
}

describe('TieredStorage access statistics', () => {
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'tiered-storage-access-stats-'))
		warm = new DiskStorageTier({ directory, maxSizeBytes: 2500, evictionPolicy: 'lru' })
		cold = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		metadataWrites = 0
		for (const method of ['setMetadata', 'setMetadataIfChecksumMatches'] as const) {
			const original = (warm[method] as (...args: never[]) => Promise<unknown>).bind(warm)
			;(warm as unknown as Record<string, unknown>)[method] = (...args: never[]) => {
				metadataWrites++
				return original(...args)
			}
		}
	})
	afterEach(async () => rm(directory, { recursive: true, force: true }))

	test('warm reads write metadata once per key per flush, not once per read', async () => {
		const key = 'site/page.html'
		await warm.set(key, bytes(100), metadata(key, 100))
		const storage = createStorage()

		for (let i = 0; i < 200; i++) await storage.getWithMetadata(key)
		await Bun.sleep(10)
		expect(metadataWrites).toBe(0)
		expect(storage.getAccessStatsBufferStats().pendingKeys).toBe(1)

		await storage.flushAccessStats()
		expect(metadataWrites).toBe(1)
		expect((await warm.getMetadata(key))?.accessCount).toBe(200)
		expect(storage.getAccessStatsBufferStats()).toEqual({ pendingKeys: 0, flushedKeys: 1, droppedReads: 0 })
	})

	test('streamed warm reads are batched too', async () => {
		const key = 'site/photo.png'
		await warm.set(key, bytes(100), metadata(key, 100))
		const storage = createStorage()

		for (let i = 0; i < 20; i++) {
			const result = await storage.getStream(key)
			for await (const _chunk of result!.stream) {
			}
		}
		await Bun.sleep(10)
		expect(metadataWrites).toBe(0)
		await storage.flushAccessStats()
		expect((await warm.getMetadata(key))?.accessCount).toBe(20)
	})

	test('a read entry is not evicted as cold before its statistics are written', async () => {
		const old = new Date(Date.now() - 60_000)
		await warm.set('a', bytes(1000), metadata('a', 1000, old))
		await warm.set('b', bytes(1000), metadata('b', 1000, new Date(old.getTime() + 1000)))
		const storage = createStorage()

		await storage.getWithMetadata('a')
		await warm.set('c', bytes(1000), metadata('c', 1000))

		expect(await warm.exists('a')).toBe(true)
		expect(await warm.exists('b')).toBe(false)
		expect(storage.getAccessStatsBufferStats().pendingKeys).toBe(1)
	})

	test('a batched write does not move recency back behind a newer read', async () => {
		const old = new Date(Date.now() - 60_000)
		await warm.set('a', bytes(1000), metadata('a', 1000, old))
		await warm.set('b', bytes(1000), metadata('b', 1000, new Date(old.getTime() + 1000)))

		// A write of statistics gathered before the latest read of 'a'.
		warm.recordAccess('a', new Date())
		await warm.setMetadata('a', metadata('a', 1000, old))
		await warm.set('c', bytes(1000), metadata('c', 1000))

		expect(await warm.exists('a')).toBe(true)
		expect(await warm.exists('b')).toBe(false)
	})

	test('the buffer holds at most maxPendingKeys keys and counts dropped reads', async () => {
		warm = new DiskStorageTier({ directory })
		const keys = ['k1', 'k2', 'k3', 'k4', 'k5']
		for (const key of keys) await warm.set(key, bytes(10), metadata(key, 10))
		const storage = createStorage({ accessStats: { maxPendingKeys: 2 } })

		for (const key of keys) await storage.getWithMetadata(key)
		await storage.getWithMetadata('k1')
		expect(storage.getAccessStatsBufferStats()).toEqual({ pendingKeys: 2, flushedKeys: 0, droppedReads: 3 })

		await storage.flushAccessStats()
		expect((await warm.getMetadata('k1'))?.accessCount).toBe(2)
		expect((await warm.getMetadata('k3'))?.accessCount).toBe(0)
	})

	test('the timer writes batches of at most flushBatchSize keys', async () => {
		warm = new DiskStorageTier({ directory })
		for (const key of ['k1', 'k2', 'k3']) await warm.set(key, bytes(10), metadata(key, 10))
		const storage = createStorage({ accessStats: { flushIntervalMs: 20, flushBatchSize: 2 } })

		for (const key of ['k1', 'k2', 'k3']) await storage.getWithMetadata(key)
		await Bun.sleep(30)
		expect(storage.getAccessStatsBufferStats().pendingKeys).toBe(1)
		await Bun.sleep(30)
		expect(storage.getAccessStatsBufferStats()).toEqual({ pendingKeys: 0, flushedKeys: 3, droppedReads: 0 })
		expect((await warm.getMetadata('k3'))?.accessCount).toBe(1)
	})

	test('statistics for a key removed before the flush are skipped', async () => {
		await warm.set('gone', bytes(10), metadata('gone', 10))
		const storage = createStorage()
		await storage.getWithMetadata('gone')
		await warm.delete('gone')

		await storage.flushAccessStats()
		expect(await warm.exists('gone')).toBe(false)
		expect(storage.getAccessStatsBufferStats().flushedKeys).toBe(0)
	})
})

describe('TieredStorage buffered hot promotion', () => {
	let hot: MemoryStorageTier

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'tiered-storage-buffered-hot-'))
		hot = new MemoryStorageTier({ maxSizeBytes: 32 * 1024 * 1024 })
		warm = new DiskStorageTier({ directory })
		cold = new MemoryStorageTier({ maxSizeBytes: 64 * 1024 * 1024 })
	})
	afterEach(async () => rm(directory, { recursive: true, force: true }))

	const storageWithHot = (config: Partial<TieredStorageConfig> = {}) =>
		createStorage({ tiers: { hot, warm, cold }, ...config })

	test('a cold read larger than the cap is promoted to warm only', async () => {
		const big = 'site/big.html'
		const small = 'site/small.html'
		await cold.set(big, bytes(3 * 1024 * 1024), metadata(big, 3 * 1024 * 1024))
		await cold.set(small, bytes(10 * 1024), metadata(small, 10 * 1024))
		const storage = storageWithHot()

		expect((await storage.getWithMetadata(big))?.source).toBe('cold')
		expect((await storage.getWithMetadata(small))?.source).toBe('cold')

		expect(await warm.exists(big)).toBe(true)
		expect(await hot.exists(big)).toBe(false)
		expect(await hot.exists(small)).toBe(true)
		expect((await storage.getWithMetadata(big))?.source).toBe('warm')
		expect(await hot.exists(big)).toBe(false)
	})

	test('a warm read larger than the cap is not promoted to hot', async () => {
		const key = 'site/big.html'
		await warm.set(key, bytes(2 * 1024 * 1024), metadata(key, 2 * 1024 * 1024))
		const storage = storageWithHot()

		expect((await storage.getWithMetadata(key))?.source).toBe('warm')
		expect(await hot.exists(key)).toBe(false)
	})

	test('the cap is configurable and inclusive', async () => {
		const key = 'site/page.html'
		await cold.set(key, bytes(4096), metadata(key, 4096))

		await storageWithHot({ bufferedHotPromotionMaxBytes: 4095 }).getWithMetadata(key)
		expect(await hot.exists(key)).toBe(false)
		await warm.delete(key)
		await storageWithHot({ bufferedHotPromotionMaxBytes: 4096 }).getWithMetadata(key)
		expect(await hot.exists(key)).toBe(true)
	})

	test('bootstrapHot skips objects above the cap', async () => {
		await warm.set('big', bytes(512 * 1024), metadata('big', 512 * 1024))
		await warm.set('small', bytes(1024), metadata('small', 1024))

		expect(await storageWithHot().bootstrapHot()).toBe(1)
		expect(await hot.exists('small')).toBe(true)
		expect(await hot.exists('big')).toBe(false)
	})
})
