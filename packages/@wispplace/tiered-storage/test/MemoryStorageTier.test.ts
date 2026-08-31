import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { MemoryStorageTier } from '../src/tiers/MemoryStorageTier.js'
import type { StorageMetadata } from '../src/types/index.js'

function bytes(size: number, value = 0): Uint8Array {
	return new Uint8Array(size).fill(value)
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

describe('MemoryStorageTier byte accounting', () => {
	test('tracks TinyLRU maxItems evictions in bytes and eviction stats', async () => {
		const tier = new MemoryStorageTier({ maxSizeBytes: 100, maxItems: 2 })
		const first = bytes(3, 1)
		const second = bytes(5, 2)
		const third = bytes(7, 3)

		await tier.set('first', first, metadata('first', first.byteLength))
		await tier.set('second', second, metadata('second', second.byteLength))
		await tier.set('third', third, metadata('third', third.byteLength))

		expect(await tier.exists('first')).toBe(false)
		expect(await tier.getStats()).toMatchObject({ bytes: 12, items: 2, evictions: 1 })
	})

	test('accounts for replacement after size eviction', async () => {
		const tier = new MemoryStorageTier({ maxSizeBytes: 10, maxItems: 2 })
		const first = bytes(4, 1)
		const second = bytes(4, 2)
		const replacement = bytes(8, 3)

		await tier.set('first', first, metadata('first', first.byteLength))
		await tier.set('second', second, metadata('second', second.byteLength))
		await tier.set('first', replacement, metadata('first', replacement.byteLength))

		expect(await tier.exists('first')).toBe(true)
		expect(await tier.exists('second')).toBe(false)
		expect(await tier.getStats()).toMatchObject({ bytes: 8, items: 1, evictions: 1 })
	})

	test('keeps bytes equal to the resident value for concurrent same-key sets', async () => {
		const tier = new MemoryStorageTier({ maxSizeBytes: 100, maxItems: 2 })
		const first = bytes(3, 1)
		const second = bytes(5, 2)

		await Promise.all([
			tier.set('same-key', first, metadata('same-key', first.byteLength)),
			tier.set('same-key', second, metadata('same-key', second.byteLength)),
		])

		expect(await tier.get('same-key')).toEqual(second)
		expect(await tier.getStats()).toMatchObject({ bytes: second.byteLength, items: 1 })
	})

	test('keeps concurrent distinct writes within the byte cap', async () => {
		const tier = new MemoryStorageTier({ maxSizeBytes: 10, maxItems: 10 })
		const values = Array.from({ length: 4 }, (_, index) => bytes(6, index + 1))

		await Promise.all(
			values.map((value, index) => tier.set(`key-${index}`, value, metadata(`key-${index}`, value.byteLength))),
		)

		expect(await tier.getStats()).toMatchObject({ bytes: 6, items: 1, evictions: 3 })
		expect(await tier.get('key-3')).toEqual(values[3])
	})

	test('does not change resident bytes when a streaming write fails', async () => {
		const tier = new MemoryStorageTier({ maxSizeBytes: 100 })
		const resident = bytes(6, 1)
		await tier.set('resident', resident, metadata('resident', resident.byteLength))

		async function* failingStream(): AsyncGenerator<Uint8Array> {
			yield bytes(3, 2)
			throw new Error('stream failed')
		}

		await expect(tier.setStream('failed', Readable.from(failingStream()), metadata('failed', 3))).rejects.toThrow(
			'stream failed',
		)

		expect(await tier.exists('failed')).toBe(false)
		expect(await tier.getStats()).toMatchObject({ bytes: resident.byteLength, items: 1 })
	})

	test('never retains an entry larger than its byte cap', async () => {
		const tier = new MemoryStorageTier({ maxSizeBytes: 10 })
		const resident = bytes(4, 1)
		const oversized = bytes(11, 2)
		await tier.set('resident', resident, metadata('resident', resident.byteLength))

		await tier.set('oversized', oversized, metadata('oversized', oversized.byteLength))
		expect(await tier.exists('resident')).toBe(true)
		expect(await tier.exists('oversized')).toBe(false)
		expect(await tier.getStats()).toMatchObject({ bytes: resident.byteLength, items: 1 })

		await tier.set('resident', oversized, metadata('resident', oversized.byteLength))
		expect(await tier.exists('resident')).toBe(false)
		expect(await tier.getStats()).toMatchObject({ bytes: 0, items: 0 })
	})

	test('does not retain an oversized stream when its metadata understates the size', async () => {
		const tier = new MemoryStorageTier({ maxSizeBytes: 10 })
		const oversized = bytes(11, 2)

		await tier.setStream('oversized', Readable.from([oversized]), metadata('oversized', 1))

		expect(await tier.exists('oversized')).toBe(false)
		expect(await tier.getStats()).toMatchObject({ bytes: 0, items: 0 })
	})
})

describe('MemoryStorageTier conditional metadata', () => {
	test('updates only the observed checksum and preserves existing custom metadata', async () => {
		const tier = new MemoryStorageTier({ maxSizeBytes: 100 })
		const original = { ...metadata('key', 1), customMetadata: { mimeType: 'text/plain' } }
		await tier.set('key', bytes(1), original)
		const updated = { ...original, customMetadata: { ...original.customMetadata, sourceCid: 'bafyreitest' } }
		expect(await tier.setMetadataIfChecksumMatches('key', 'other', updated)).toBe(false)
		expect(await tier.setMetadataIfChecksumMatches('key', 'test', updated)).toBe(true)
		expect((await tier.getMetadata('key'))?.customMetadata).toEqual({
			mimeType: 'text/plain',
			sourceCid: 'bafyreitest',
		})
		expect(await tier.setMetadataIfChecksumMatches('absent', 'test', updated)).toBe(false)
	})
})
