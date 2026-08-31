import { describe, expect, test } from 'bun:test'
import { TieredStorage } from '../src/TieredStorage.js'
import type { StorageTier } from '../src/types/index.js'

describe('TieredStorage.deleteColdPrefix', () => {
	test('streams fallback keys into bounded deleteMany batches', async () => {
		const keys = Array.from({ length: 501 }, (_, index) => `private/site/${index}`)
		const emittedKeys = [...keys, 'other-site/never-delete']
		const batches: string[][] = []
		const cold: StorageTier = {
			get: async () => null,
			set: async () => {},
			delete: async () => {},
			exists: async () => false,
			async *listKeys() {
				for (const key of emittedKeys) yield key
			},
			deleteMany: async (batch) => {
				batches.push([...batch])
			},
			getMetadata: async () => null,
			setMetadata: async () => {},
			getStats: async () => ({ bytes: 0, items: 0 }),
			clear: async () => {},
		}
		const storage = new TieredStorage<Uint8Array>({
			tiers: { cold },
			serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
		})

		expect(await storage.deleteColdPrefix('private/site/', 250)).toBe(501)
		expect(batches.map((batch) => batch.length)).toEqual([250, 250, 1])
		expect(batches.flat()).toEqual(keys)
	})

	test('passes a write abort signal through to the durable tier', async () => {
		let receivedSignal: AbortSignal | undefined
		const cold: StorageTier = {
			get: async () => null,
			set: async (_key, _data, _metadata, options) => {
				receivedSignal = options?.signal
			},
			delete: async () => {},
			exists: async () => false,
			async *listKeys() {
				yield* []
			},
			deleteMany: async () => {},
			getMetadata: async () => null,
			setMetadata: async () => {},
			getStats: async () => ({ bytes: 0, items: 0 }),
			clear: async () => {},
		}
		const storage = new TieredStorage<Uint8Array>({
			tiers: { cold },
			serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
		})
		const controller = new AbortController()

		await storage.set('private/site/file', new Uint8Array([1]), { onlyTiers: ['cold'], signal: controller.signal })
		expect(receivedSignal).toBe(controller.signal)
	})

	test('uses a native prefix deletion without enumerating keys', async () => {
		let listed = false
		const cold: StorageTier = {
			get: async () => null,
			set: async () => {},
			delete: async () => {},
			exists: async () => false,
			async *listKeys() {
				listed = true
				yield* []
			},
			deleteMany: async () => {},
			deletePrefix: async (prefix) => {
				expect(prefix).toBe('private/site/')
				return 7
			},
			getMetadata: async () => null,
			setMetadata: async () => {},
			getStats: async () => ({ bytes: 0, items: 0 }),
			clear: async () => {},
		}
		const storage = new TieredStorage<Uint8Array>({
			tiers: { cold },
			serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
		})

		expect(await storage.deleteColdPrefix('private/site/')).toBe(7)
		expect(listed).toBe(false)
	})
})
