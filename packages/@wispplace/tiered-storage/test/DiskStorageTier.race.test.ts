import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { TieredStorage } from '../src/TieredStorage.js'
import { DiskStorageTier } from '../src/tiers/DiskStorageTier.js'
import { MemoryStorageTier } from '../src/tiers/MemoryStorageTier.js'
import type { StorageMetadata } from '../src/types/index.js'

const testDir = './test-disk-race-cache'

function makeMetadata(key: string, size: number): StorageMetadata {
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

describe('DiskStorageTier initialization and mutation serialization', () => {
	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	afterAll(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	test('waits for a rebuilt index before immediately applying capacity eviction', async () => {
		const oldData = new Uint8Array(8).fill(1)
		const freshData = new Uint8Array(8).fill(2)
		const original = new DiskStorageTier({ directory: testDir, maxSizeBytes: 10 })
		await original.set('old', oldData, makeMetadata('old', oldData.byteLength))

		const reopened = new DiskStorageTier({ directory: testDir, maxSizeBytes: 10 })
		await reopened.set('fresh', freshData, makeMetadata('fresh', freshData.byteLength))

		expect(await reopened.exists('old')).toBe(false)
		expect(await reopened.exists('fresh')).toBe(true)
		expect(await reopened.getStats()).toEqual({ bytes: freshData.byteLength, items: 1 })
	})

	test('serializes concurrent writes before deciding size-based eviction', async () => {
		const tier = new DiskStorageTier({ directory: testDir, maxSizeBytes: 10 })
		const first = new Uint8Array(8).fill(1)
		const second = new Uint8Array(8).fill(2)

		await Promise.all([
			tier.set('first', first, makeMetadata('first', first.byteLength)),
			tier.set('second', second, makeMetadata('second', second.byteLength)),
		])

		expect(await tier.exists('first')).toBe(false)
		expect(await tier.exists('second')).toBe(true)
		expect(await tier.getStats()).toEqual({ bytes: second.byteLength, items: 1 })
	})

	test('recreates a nested directory that capacity eviction emptied', async () => {
		const tier = new DiskStorageTier({ directory: testDir, maxSizeBytes: 10 })
		const oldData = new Uint8Array(8).fill(1)
		const freshData = new Uint8Array(8).fill(2)

		await tier.set('site/old', oldData, makeMetadata('site/old', oldData.byteLength))
		await tier.set('site/fresh', freshData, makeMetadata('site/fresh', freshData.byteLength))

		expect(await tier.exists('site/old')).toBe(false)
		expect(await tier.exists('site/fresh')).toBe(true)
		expect(await tier.getStats()).toEqual({ bytes: freshData.byteLength, items: 1 })
	})

	test('never retains an entry larger than its byte cap', async () => {
		const tier = new DiskStorageTier({ directory: testDir, maxSizeBytes: 10 })
		const resident = new Uint8Array(4).fill(1)
		const oversized = new Uint8Array(11).fill(2)
		await tier.set('resident', resident, makeMetadata('resident', resident.byteLength))

		await tier.set('oversized', oversized, makeMetadata('oversized', oversized.byteLength))
		expect(await tier.exists('resident')).toBe(true)
		expect(await tier.exists('oversized')).toBe(false)
		expect(await tier.getStats()).toEqual({ bytes: resident.byteLength, items: 1 })

		await tier.set('resident', oversized, makeMetadata('resident', oversized.byteLength))
		expect(await tier.exists('resident')).toBe(false)
		expect(await tier.getStats()).toEqual({ bytes: 0, items: 0 })
	})

	test('drops streamed data that exceeds the cap even when metadata understates its size', async () => {
		const tier = new DiskStorageTier({ directory: testDir, maxSizeBytes: 10 })
		const oversized = new Uint8Array(11).fill(2)

		await tier.setStream('oversized', Readable.from([oversized]), makeMetadata('oversized', 1))

		expect(await tier.exists('oversized')).toBe(false)
		expect(await tier.getMetadata('oversized')).toBeNull()
		expect(await tier.getStats()).toEqual({ bytes: 0, items: 0 })
	})

	test('keeps a returned read stream usable after its key is invalidated', async () => {
		const tier = new DiskStorageTier({ directory: testDir })
		const data = new Uint8Array([1, 2, 3])
		await tier.set('site/file', data, makeMetadata('site/file', data.byteLength))

		const result = await tier.getStream('site/file')
		expect(result).not.toBeNull()
		await tier.delete('site/file')

		const chunks: Buffer[] = []
		for await (const chunk of result!.stream) {
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
		}
		expect(Buffer.concat(chunks)).toEqual(Buffer.from(data))
	})

	test('skips an oversized warm entry without preventing its cold write', async () => {
		const warm = new DiskStorageTier({ directory: testDir, maxSizeBytes: 10 })
		const cold = new MemoryStorageTier({ maxSizeBytes: 100 })
		const storage = new TieredStorage<Uint8Array>({
			tiers: { warm, cold },
			serialization: {
				serialize: async (data) => data as Uint8Array,
				deserialize: async (data) => data,
			},
		})
		const oversized = new Uint8Array(11).fill(3)

		await storage.set('oversized', oversized)

		expect(await warm.exists('oversized')).toBe(false)
		expect(await cold.get('oversized')).toEqual(oversized)
	})
})
