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
	test('coalesces concurrent buffered get operations without sharing typed values', async () => {
		const key = 'site/file.json'
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		await seedCold(cold, key)
		const originalGet = cold.getWithMetadata.bind(cold)
		const started = createDeferred()
		const release = createDeferred()
		let coldReads = 0
		cold.getWithMetadata = async (readKey) => {
			coldReads++
			started.resolve()
			await release.promise
			return originalGet(readKey)
		}
		const storage = new TieredStorage<{ value: string }>({ tiers: { cold } })

		const first = storage.get(key)
		const second = storage.getWithMetadata(key)
		await started.promise
		expect(coldReads).toBe(1)
		release.resolve()

		expect(await first).toEqual({ value: 'stale' })
		expect((await second)?.data).toEqual({ value: 'stale' })
	})

	test('does not reuse an in-flight cold read after a committed set', async () => {
		const key = 'site/file.json'
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const oldData = new TextEncoder().encode(JSON.stringify({ value: 'old' }))
		await cold.set(key, oldData, metadata(key, oldData.byteLength))
		const originalGet = cold.getWithMetadata.bind(cold)
		const firstReadStarted = createDeferred()
		const releaseFirstRead = createDeferred()
		let coldReads = 0
		cold.getWithMetadata = async (readKey) => {
			coldReads++
			const snapshot = await originalGet(readKey)
			if (coldReads === 1) {
				firstReadStarted.resolve()
				await releaseFirstRead.promise
			}
			return snapshot
		}
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const storage = new TieredStorage<{ value: string }>({ tiers: { hot, cold }, promotionStrategy: 'eager' })

		const first = storage.get(key)
		await firstReadStarted.promise
		await storage.set(key, { value: 'new' }, { onlyTiers: ['cold'] })
		const second = storage.get(key)
		releaseFirstRead.resolve()

		expect(await first).toEqual({ value: 'old' })
		expect(await second).toEqual({ value: 'new' })
		expect(coldReads).toBe(2)
		expect(new TextDecoder().decode((await cold.get(key))!)).toContain('new')
		expect(new TextDecoder().decode((await hot.get(key))!)).toContain('new')
	})

	test('isolates coalesced deserializer inputs and metadata from each caller', async () => {
		const key = 'site/file.bin'
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const stored = new Uint8Array([1, 2, 3])
		await cold.set(key, stored, {
			...metadata(key, stored.byteLength),
			ttl: new Date(Date.now() + 1234),
			customMetadata: { owner: 'original' },
		})
		const started = createDeferred()
		const release = createDeferred()
		const originalGet = cold.getWithMetadata.bind(cold)
		cold.getWithMetadata = async (readKey) => {
			const result = await originalGet(readKey)
			started.resolve()
			await release.promise
			return result
		}
		const storage = new TieredStorage<{
			firstByte: number
			raw: Uint8Array
		}>({
			tiers: { cold },
			serialization: {
				serialize: async (value) => value as Uint8Array,
				deserialize: async (data) => {
					const firstByte = data[0]!
					data[0] = 99
					return { firstByte, raw: data }
				},
			},
		})

		const firstPromise = storage.getWithMetadata(key)
		const secondPromise = storage.getWithMetadata(key)
		await started.promise
		release.resolve()
		const first = (await firstPromise)!
		const second = (await secondPromise)!

		const originalTtl = second.metadata.ttl!.getTime()
		first.data.raw[1] = 88
		first.metadata.customMetadata!.owner = 'mutated'
		first.metadata.ttl!.setTime(9999)
		expect(second.data.firstByte).toBe(1)
		expect(second.data.raw).toEqual(new Uint8Array([99, 2, 3]))
		expect(second.metadata.customMetadata).toEqual({ owner: 'original' })
		expect(second.metadata.ttl?.getTime()).toBe(originalTtl)
		expect(second.metadata.ttl).not.toBe(first.metadata.ttl)
		expect(await cold.get(key)).toEqual(stored)
	})

	test('cleans up coalesced null and error reads so later calls retry', async () => {
		const key = 'site/missing.json'
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const originalGet = cold.getWithMetadata.bind(cold)
		let coldReads = 0
		let fail = false
		cold.getWithMetadata = async (readKey) => {
			coldReads++
			if (fail) throw new Error('cold read failed')
			return originalGet(readKey)
		}
		const storage = new TieredStorage<{ value: string }>({ tiers: { cold } })

		const missing = await Promise.all([storage.get(key), storage.getWithMetadata(key)])
		expect(missing).toEqual([null, null])
		expect(coldReads).toBe(1)

		fail = true
		const failures = await Promise.allSettled([storage.get(key), storage.getWithMetadata(key)])
		expect(failures.every((result) => result.status === 'rejected')).toBe(true)
		expect(coldReads).toBe(2)

		fail = false
		expect(await storage.get(key)).toBeNull()
		expect(coldReads).toBe(3)
	})

	test('does not reuse a read across upper-cache invalidation', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		await seedCold(cold, key)
		const originalGet = cold.getWithMetadata.bind(cold)
		const firstStarted = createDeferred()
		const releaseFirst = createDeferred()
		let coldReads = 0
		cold.getWithMetadata = async (readKey) => {
			coldReads++
			if (coldReads === 1) {
				firstStarted.resolve()
				await releaseFirst.promise
			}
			return originalGet(readKey)
		}
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, cold },
			promotionStrategy: 'eager',
		})

		const first = storage.get(key)
		await firstStarted.promise
		await storage.invalidateUpperCacheKey(key)
		const second = storage.get(key)
		releaseFirst.resolve()

		await first
		await second
		expect(coldReads).toBe(2)
		expect(await hot.exists(key)).toBe(true)
	})

	test('does not reuse an invalidated cold read or promote its stale completion', async () => {
		const key = 'site/file.json'
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 })
		await seedCold(cold, key)
		const originalGet = cold.getWithMetadata.bind(cold)
		const firstStarted = createDeferred()
		const releaseFirst = createDeferred()
		let coldReads = 0
		cold.getWithMetadata = async (readKey) => {
			coldReads++
			if (coldReads === 1) {
				firstStarted.resolve()
				await releaseFirst.promise
			}
			return originalGet(readKey)
		}
		const storage = new TieredStorage<{ value: string }>({
			tiers: { hot, cold },
			promotionStrategy: 'eager',
		})

		const first = storage.get(key)
		await firstStarted.promise
		const invalidation = storage.delete(key)
		const afterInvalidation = storage.get(key)
		releaseFirst.resolve()

		await first
		await invalidation
		await afterInvalidation
		expect(coldReads).toBe(2)
		expect(await hot.exists(key)).toBe(false)
	})

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
