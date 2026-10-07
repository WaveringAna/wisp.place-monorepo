import { describe, expect, test } from 'bun:test'
import { TieredStorage } from '../src/TieredStorage.js'
import { MemoryStorageTier } from '../src/tiers/MemoryStorageTier.js'

const identity = {
	serialize: async (data: unknown) => data as Uint8Array,
	deserialize: async (data: Uint8Array) => data,
}

function createStorage() {
	const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
	const cold = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
	const storage = new TieredStorage<Uint8Array>({
		tiers: { hot, cold },
		promotionStrategy: 'eager',
		serialization: identity,
	})
	return { hot, cold, storage }
}

describe('TieredStorage buffered read ownership', () => {
	test('copies bytes by default so callers can mutate their result', async () => {
		const { hot, storage } = createStorage()
		await storage.set('site/index.html', new Uint8Array([1, 2, 3]))

		const result = await storage.getWithMetadata('site/index.html')
		result!.data[0] = 99

		expect(result!.data).not.toBe(await hot.get('site/index.html'))
		expect(await hot.get('site/index.html')).toEqual(new Uint8Array([1, 2, 3]))
	})

	test('borrowData returns the hot-tier bytes without a copy', async () => {
		const { hot, storage } = createStorage()
		await storage.set('site/index.html', new Uint8Array([1, 2, 3]))

		const result = await storage.getWithMetadata('site/index.html', { borrowData: true })

		expect(result?.source).toBe('hot')
		expect(result!.data).toBe((await hot.get('site/index.html'))!)
		expect(await storage.get('site/index.html', { borrowData: true })).toBe((await hot.get('site/index.html'))!)
	})

	test('borrowData shares a cold read with the promoted hot entry and still isolates metadata', async () => {
		const { hot, storage } = createStorage()
		await storage.set('site/app.js', new Uint8Array([4, 5, 6]), { onlyTiers: ['cold'], metadata: { owner: 'cold' } })

		const result = await storage.getWithMetadata('site/app.js', { borrowData: true })
		result!.metadata.customMetadata!.owner = 'mutated'

		expect(result?.source).toBe('cold')
		expect(result!.data).toBe((await hot.get('site/app.js'))!)
		expect((await hot.getMetadata('site/app.js'))?.customMetadata).toEqual({ owner: 'cold' })
	})
})
