import { describe, expect, test } from 'bun:test'
import { TieredStorage } from '../src/TieredStorage.js'
import { MemoryStorageTier } from '../src/tiers/MemoryStorageTier.js'
import type { StorageMetadata } from '../src/types/index.js'

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

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

async function seedCold(cold: MemoryStorageTier, key: string): Promise<void> {
	const data = new TextEncoder().encode(JSON.stringify({ value: 'stale' }))
	await cold.set(key, data, metadata(key, data.byteLength))
}

function blockNextSet(tier: MemoryStorageTier): { started: Promise<void>; release: () => void } {
	const started = createDeferred()
	const release = createDeferred()
	const originalSet = tier.set.bind(tier)

	tier.set = async (key, data, entryMetadata) => {
		started.resolve()
		await release.promise
		await originalSet(key, data, entryMetadata)
	}

	return { started: started.promise, release: release.resolve }
}

function blockNextDelete(tier: MemoryStorageTier): { started: Promise<void>; release: () => void } {
	const started = createDeferred()
	const release = createDeferred()
	const originalDelete = tier.delete.bind(tier)

	tier.delete = async (key) => {
		started.resolve()
		await release.promise
		await originalDelete(key)
	}

	return { started: started.promise, release: release.resolve }
}

function pauseNextMetadataRead(tier: MemoryStorageTier): { started: Promise<void>; release: () => void } {
	const started = createDeferred()
	const release = createDeferred()
	const originalGetWithMetadata = tier.getWithMetadata.bind(tier)

	tier.getWithMetadata = async (key) => {
		const result = await originalGetWithMetadata(key)
		started.resolve()
		await release.promise
		return result
	}

	return { started: started.promise, release: release.resolve }
}

describe('TieredStorage promotion invalidation fence', () => {
	test('delete removes a promotion that was already writing to hot storage', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		await seedCold(cold, key)
		const gate = blockNextSet(hot)
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, cold },
			promotionStrategy: 'eager',
		})

		const read = storage.get(key)
		await gate.started
		const deletion = storage.delete(key)
		gate.release()

		expect(await read).toEqual({ value: 'stale' })
		await deletion
		expect(await hot.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(false)
		expect(await storage.get(key)).toBeNull()
	})

	test('prefix invalidation removes a promotion that was already writing to hot storage', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		await seedCold(cold, key)
		const gate = blockNextSet(hot)
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, cold },
			promotionStrategy: 'eager',
		})

		const read = storage.get(key)
		await gate.started
		const invalidation = storage.invalidate('site/')
		gate.release()

		expect(await read).toEqual({ value: 'stale' })
		expect(await invalidation).toBe(1)
		expect(await hot.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(false)
		expect(await storage.get(key)).toBeNull()
	})

	test('does not promote a lower-tier read that starts while deletion is in flight', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		await seedCold(cold, key)
		const deletionGate = blockNextDelete(cold)
		const readGate = pauseNextMetadataRead(cold)
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, cold },
			promotionStrategy: 'eager',
		})

		const deletion = storage.delete(key)
		await deletionGate.started
		const read = storage.get(key)
		await readGate.started
		deletionGate.release()
		await deletion
		readGate.release()

		expect(await read).toEqual({ value: 'stale' })
		expect(await hot.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(false)
		expect(await storage.get(key)).toBeNull()
	})

	test('clears only upper cache tiers and reports their deleted counts', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, warm, cold },
			promotionStrategy: 'eager',
		})

		await storage.set(key, { value: 'source' })
		expect(await storage.invalidateUpperCaches('site/')).toEqual({
			hotDeleted: 1,
			warmDeleted: 1,
			failures: [],
		})

		expect(await hot.exists(key)).toBe(false)
		expect(await warm.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(true)
	})

	test('clears one exact upper-cache key without touching adjacent or cold keys', async () => {
		const key = 'site/file.json'
		const adjacentKey = 'site/file.json.bak'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, warm, cold },
			promotionStrategy: 'eager',
		})

		await storage.set(key, { value: 'source' })
		await storage.set(adjacentKey, { value: 'adjacent' })
		expect(await storage.invalidateUpperCacheKey(key)).toEqual([])

		expect(await hot.exists(key)).toBe(false)
		expect(await warm.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(true)
		expect(await hot.exists(adjacentKey)).toBe(true)
		expect(await warm.exists(adjacentKey)).toBe(true)
		expect(await cold.exists(adjacentKey)).toBe(true)
	})

	test('exact upper-cache eviction wins over an in-flight eager promotion', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		await seedCold(cold, key)
		const writeGate = blockNextSet(hot)
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, warm, cold },
			promotionStrategy: 'eager',
		})

		const read = storage.get(key)
		await writeGate.started
		const eviction = storage.invalidateUpperCacheKey(key)
		writeGate.release()

		expect(await read).toEqual({ value: 'stale' })
		expect(await eviction).toEqual([])
		expect(await hot.exists(key)).toBe(false)
		expect(await warm.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(true)
	})

	test('serializes concurrent exact upper-cache evictions', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const storage = new TieredStorage<{ value: string }>({ tiers: { hot, warm, cold } })
		await storage.set(key, { value: 'source' })

		const firstDeleteStarted = createDeferred()
		const releaseFirstDelete = createDeferred()
		const originalDelete = hot.delete.bind(hot)
		let hotDeleteCalls = 0
		hot.delete = async (deletedKey) => {
			hotDeleteCalls++
			if (hotDeleteCalls === 1) {
				firstDeleteStarted.resolve()
				await releaseFirstDelete.promise
			}
			await originalDelete(deletedKey)
		}

		const first = storage.invalidateUpperCacheKey(key)
		await firstDeleteStarted.promise
		const second = storage.invalidateUpperCacheKey(key)
		await Promise.resolve()
		expect(hotDeleteCalls).toBe(1)
		releaseFirstDelete.resolve()

		expect(await first).toEqual([])
		expect(await second).toEqual([])
		expect(hotDeleteCalls).toBe(2)
		expect(await hot.exists(key)).toBe(false)
		expect(await warm.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(true)
	})

	test('attempts every upper tier and surfaces individual purge failures', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 }) as MemoryStorageTier & {
			deletePrefix(prefix: string): Promise<number>
		}
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, warm, cold },
			promotionStrategy: 'eager',
		})
		const failure = new Error('hot unavailable')
		hot.deletePrefix = async () => {
			throw failure
		}

		await storage.set(key, { value: 'source' })
		const result = await storage.invalidateUpperCaches('site/')

		expect(result.hotDeleted).toBe(0)
		expect(result.warmDeleted).toBe(1)
		expect(result.failures).toEqual([{ tier: 'hot', reason: failure }])
		expect(await warm.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(true)
	})

	test('skips an oversized hot entry without preventing its cold write', async () => {
		const key = 'site/large.bin'
		const hot = new MemoryStorageTier({ maxSizeBytes: 10 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 100 })
		const storage = new TieredStorage<Uint8Array>({
			tiers: { hot, cold },
			serialization: {
				serialize: async (data) => data as Uint8Array,
				deserialize: async (data) => data,
			},
		})
		const oversized = new Uint8Array(11).fill(1)

		await storage.set(key, oversized)

		expect(await hot.exists(key)).toBe(false)
		expect(await cold.get(key)).toEqual(oversized)
	})

	test('does not promote a cold read after upper-cache invalidation completes', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		await seedCold(cold, key)
		const readGate = pauseNextMetadataRead(cold)
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, warm, cold },
			promotionStrategy: 'eager',
		})

		const read = storage.get(key)
		await readGate.started
		expect(await storage.invalidateUpperCaches('site/')).toEqual({
			hotDeleted: 0,
			warmDeleted: 0,
			failures: [],
		})
		readGate.release()

		expect(await read).toEqual({ value: 'stale' })
		expect(await hot.exists(key)).toBe(false)
		expect(await warm.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(true)
	})

	test('purges a promotion that was already writing when upper-cache invalidation began', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		await seedCold(cold, key)
		const writeGate = blockNextSet(hot)
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, warm, cold },
			promotionStrategy: 'eager',
		})

		const read = storage.get(key)
		await writeGate.started
		const invalidation = storage.invalidateUpperCaches('site/')
		writeGate.release()

		expect(await read).toEqual({ value: 'stale' })
		expect(await invalidation).toEqual({ hotDeleted: 1, warmDeleted: 1, failures: [] })
		expect(await hot.exists(key)).toBe(false)
		expect(await warm.exists(key)).toBe(false)
		expect(await cold.exists(key)).toBe(true)
	})
})
