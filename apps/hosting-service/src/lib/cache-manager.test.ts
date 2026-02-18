import { describe, test, expect } from 'bun:test'
import { CacheManager } from './cache-manager'

type TestNS = 'ttl' | 'lru' | 'sized' | 'combo'

function createTestCache() {
	return new CacheManager<TestNS>({
		ttl:   { ttl: 100, maxEntries: 100 },
		lru:   { maxEntries: 3 },
		sized: { maxEntries: 100, maxSize: 300, estimateSize: (v) => (v as string).length },
		combo: { ttl: 100, maxEntries: 3, maxSize: 500, estimateSize: (v) => (v as string).length },
	})
}

describe('CacheManager', () => {
	describe('get / set basics', () => {
		test('returns undefined for missing key', () => {
			const c = createTestCache()
			expect(c.get('ttl', 'missing')).toBeUndefined()
		})

		test('stores and retrieves a value', () => {
			const c = createTestCache()
			c.set('ttl', 'k', 42)
			expect(c.get<number>('ttl', 'k')).toBe(42)
		})

		test('namespaces are isolated', () => {
			const c = createTestCache()
			c.set('ttl', 'k', 'from-ttl')
			c.set('lru', 'k', 'from-lru')
			expect(c.get<string>('ttl', 'k')).toBe('from-ttl')
			expect(c.get<string>('lru', 'k')).toBe('from-lru')
		})

		test('overwrites existing key', () => {
			const c = createTestCache()
			c.set('lru', 'k', 'v1')
			c.set('lru', 'k', 'v2')
			expect(c.get<string>('lru', 'k')).toBe('v2')
		})
	})

	describe('TTL expiry', () => {
		test('returns value within TTL', () => {
			const c = createTestCache()
			c.set('ttl', 'k', 'fresh')
			expect(c.get<string>('ttl', 'k')).toBe('fresh')
		})

		test('expires value after TTL', async () => {
			const c = createTestCache()
			c.set('ttl', 'k', 'stale')
			await Bun.sleep(150)
			expect(c.get('ttl', 'k')).toBeUndefined()
		})
	})

	describe('LRU eviction by maxEntries', () => {
		test('evicts oldest entry when maxEntries exceeded', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			c.set('lru', 'c', 3)
			// At capacity (3). Adding a 4th should evict 'a' (oldest).
			c.set('lru', 'd', 4)
			expect(c.get<number>('lru', 'a')).toBeUndefined()
			expect(c.get<number>('lru', 'b')).toBe(2)
			expect(c.get<number>('lru', 'd')).toBe(4)
		})

		test('accessing a key refreshes its LRU position', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			c.set('lru', 'c', 3)
			// Touch 'a' so it's no longer the oldest
			c.get('lru', 'a')
			// Now 'b' is the oldest
			c.set('lru', 'd', 4)
			expect(c.get<number>('lru', 'b')).toBeUndefined()
			expect(c.get<number>('lru', 'a')).toBe(1)
		})
	})

	describe('LRU eviction by maxSize', () => {
		test('evicts entries when maxSize exceeded', () => {
			const c = createTestCache()
			// sized ns: maxSize=300, estimateSize = string length
			c.set('sized', 'a', 'x'.repeat(100))
			c.set('sized', 'b', 'x'.repeat(100))
			c.set('sized', 'c', 'x'.repeat(100))
			// At 300 bytes. Adding 150 more should evict until it fits.
			c.set('sized', 'd', 'x'.repeat(150))
			expect(c.get('sized', 'a')).toBeUndefined()
			expect(c.get('sized', 'd')).toBeDefined()
		})
	})

	describe('delete', () => {
		test('removes a key', () => {
			const c = createTestCache()
			c.set('lru', 'k', 'val')
			c.delete('lru', 'k')
			expect(c.get('lru', 'k')).toBeUndefined()
		})

		test('delete on missing key is a no-op', () => {
			const c = createTestCache()
			c.delete('lru', 'nonexistent') // should not throw
		})
	})

	describe('clear', () => {
		test('removes all entries in a namespace', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			c.set('ttl', 'x', 3)
			c.clear('lru')
			expect(c.get<number>('lru', 'a')).toBeUndefined()
			expect(c.get<number>('lru', 'b')).toBeUndefined()
			// Other namespace untouched
			expect(c.get<number>('ttl', 'x')).toBe(3)
		})
	})

	describe('getOrFetch', () => {
		test('calls fetcher on cache miss', async () => {
			const c = createTestCache()
			let called = 0
			const val = await c.getOrFetch('lru', 'k', () => { called++; return 'fetched' })
			expect(val).toBe('fetched')
			expect(called).toBe(1)
		})

		test('returns cached value without calling fetcher', async () => {
			const c = createTestCache()
			c.set('lru', 'k', 'cached')
			let called = 0
			const val = await c.getOrFetch('lru', 'k', () => { called++; return 'fetched' })
			expect(val).toBe('cached')
			expect(called).toBe(0)
		})

		test('works with async fetcher', async () => {
			const c = createTestCache()
			const val = await c.getOrFetch('lru', 'k', async () => {
				await Bun.sleep(5)
				return 'async-result'
			})
			expect(val).toBe('async-result')
			// Second call should be from cache
			expect(c.get<string>('lru', 'k')).toBe('async-result')
		})

		test('cacheIf: false skips caching', async () => {
			const c = createTestCache()
			const val = await c.getOrFetch('lru', 'k', () => null, {
				cacheIf: (v) => v !== null,
			})
			expect(val).toBeNull()
			// Should NOT be cached
			expect(c.get('lru', 'k')).toBeUndefined()
		})

		test('cacheIf: true caches normally', async () => {
			const c = createTestCache()
			const val = await c.getOrFetch('lru', 'k', () => 'good', {
				cacheIf: (v) => v !== null,
			})
			expect(val).toBe('good')
			expect(c.get<string>('lru', 'k')).toBe('good')
		})
	})

	describe('stats', () => {
		test('tracks hits and misses', () => {
			const c = createTestCache()
			c.get('lru', 'miss1')
			c.get('lru', 'miss2')
			c.set('lru', 'k', 'v')
			c.get('lru', 'k')
			const stats = c.getStats()
			expect(stats.lru.misses).toBe(2)
			expect(stats.lru.hits).toBe(1)
		})

		test('tracks evictions', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			c.set('lru', 'c', 3)
			c.set('lru', 'd', 4) // evicts 'a'
			const stats = c.getStats()
			expect(stats.lru.evictions).toBe(1)
		})

		test('tracks entries count', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			expect(c.getStats().lru.entries).toBe(2)
			c.delete('lru', 'a')
			expect(c.getStats().lru.entries).toBe(1)
		})

		test('tracks sizeBytes with estimateSize', () => {
			const c = createTestCache()
			c.set('sized', 'a', 'hello') // 5 bytes
			c.set('sized', 'b', 'world!') // 6 bytes
			expect(c.getStats().sized.sizeBytes).toBe(11)
			c.delete('sized', 'a')
			expect(c.getStats().sized.sizeBytes).toBe(6)
		})

		test('returns independent stats per namespace', () => {
			const c = createTestCache()
			c.set('ttl', 'a', 1)
			c.set('lru', 'b', 2)
			const stats = c.getStats()
			expect(stats.ttl.entries).toBe(1)
			expect(stats.lru.entries).toBe(1)
			expect(stats.sized.entries).toBe(0)
		})
	})

	describe('cleanup', () => {
		test('startCleanup / stopCleanup do not throw', () => {
			const c = createTestCache()
			c.startCleanup(50)
			c.stopCleanup()
		})

		test('cleanup sweeps expired TTL entries', async () => {
			const c = createTestCache()
			c.set('ttl', 'k', 'val')
			c.startCleanup(50)
			// Wait for TTL (100ms) + cleanup interval (50ms) + buffer
			await Bun.sleep(200)
			c.stopCleanup()
			expect(c.get('ttl', 'k')).toBeUndefined()
		})

		test('cleanup does not touch non-TTL namespaces', async () => {
			const c = createTestCache()
			c.set('lru', 'k', 'val')
			c.startCleanup(50)
			await Bun.sleep(200)
			c.stopCleanup()
			expect(c.get<string>('lru', 'k')).toBe('val')
		})
	})
})
