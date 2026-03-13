import { rm } from 'node:fs/promises'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { DiskStorageTier } from '../src/tiers/DiskStorageTier.js'
import type { StorageMetadata } from '../src/types/index.js'

const testDir = './test-disk-gc'

function makeMetadata(key: string, size: number, ttl?: Date): StorageMetadata {
	return {
		key,
		size,
		createdAt: new Date(),
		lastAccessed: new Date(),
		accessCount: 0,
		compressed: false,
		checksum: 'abc',
		...(ttl && { ttl }),
	}
}

describe('DiskStorageTier - Garbage Collection', () => {
	beforeEach(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	afterAll(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	describe('gc()', () => {
		test('should delete expired entries', async () => {
			const tier = new DiskStorageTier({ directory: testDir })
			const data = new TextEncoder().encode('test')

			const expiredTTL = new Date(Date.now() - 1000)
			await tier.set('expired1', data, makeMetadata('expired1', data.byteLength, expiredTTL))
			await tier.set('expired2', data, makeMetadata('expired2', data.byteLength, expiredTTL))

			const futureTTL = new Date(Date.now() + 60_000)
			await tier.set('alive', data, makeMetadata('alive', data.byteLength, futureTTL))

			expect(await tier.exists('expired1')).toBe(true)
			expect(await tier.exists('expired2')).toBe(true)

			const deleted = await tier.gc()

			expect(deleted).toBe(2)
			expect(await tier.exists('expired1')).toBe(false)
			expect(await tier.exists('expired2')).toBe(false)
			expect(await tier.exists('alive')).toBe(true)
		})

		test('should not delete entries without TTL', async () => {
			const tier = new DiskStorageTier({ directory: testDir })
			const data = new TextEncoder().encode('test')

			await tier.set('no-ttl', data, makeMetadata('no-ttl', data.byteLength))

			const deleted = await tier.gc()

			expect(deleted).toBe(0)
			expect(await tier.exists('no-ttl')).toBe(true)
		})

		test('should return 0 when nothing is expired', async () => {
			const tier = new DiskStorageTier({ directory: testDir })
			const data = new TextEncoder().encode('test')

			const futureTTL = new Date(Date.now() + 60_000)
			await tier.set('alive', data, makeMetadata('alive', data.byteLength, futureTTL))

			const deleted = await tier.gc()
			expect(deleted).toBe(0)
		})

		test('should return 0 on empty tier', async () => {
			const tier = new DiskStorageTier({ directory: testDir })
			const deleted = await tier.gc()
			expect(deleted).toBe(0)
		})

		test('should reclaim disk space tracked by currentSize', async () => {
			const tier = new DiskStorageTier({ directory: testDir, maxSizeBytes: 1024 })
			const data = new TextEncoder().encode('x'.repeat(100))

			const expiredTTL = new Date(Date.now() - 1000)
			await tier.set('expired', data, makeMetadata('expired', data.byteLength, expiredTTL))

			const statsBefore = await tier.getStats()
			expect(statsBefore.items).toBe(1)

			await tier.gc()

			const statsAfter = await tier.getStats()
			expect(statsAfter.items).toBe(0)
			expect(statsAfter.bytes).toBe(0)
		})

		test('should handle mixed expired and alive entries in nested dirs', async () => {
			const tier = new DiskStorageTier({ directory: testDir })
			const data = new TextEncoder().encode('test')

			const expired = new Date(Date.now() - 1000)
			const alive = new Date(Date.now() + 60_000)

			await tier.set('site:a/old.html', data, makeMetadata('site:a/old.html', data.byteLength, expired))
			await tier.set('site:a/new.html', data, makeMetadata('site:a/new.html', data.byteLength, alive))
			await tier.set('site:b/old.html', data, makeMetadata('site:b/old.html', data.byteLength, expired))

			const deleted = await tier.gc()

			expect(deleted).toBe(2)
			expect(await tier.exists('site:a/old.html')).toBe(false)
			expect(await tier.exists('site:a/new.html')).toBe(true)
			expect(await tier.exists('site:b/old.html')).toBe(false)
		})
	})

	describe('gcIntervalMs auto-sweep', () => {
		test('should run gc automatically on interval', async () => {
			const tier = new DiskStorageTier({ directory: testDir, gcIntervalMs: 200 })
			const data = new TextEncoder().encode('test')

			const expiredTTL = new Date(Date.now() - 1000)
			await tier.set('will-expire', data, makeMetadata('will-expire', data.byteLength, expiredTTL))

			expect(await tier.exists('will-expire')).toBe(true)

			// Wait for the GC interval to fire
			await new Promise((resolve) => setTimeout(resolve, 350))

			expect(await tier.exists('will-expire')).toBe(false)

			tier.dispose()
		})

		test('should not run gc after dispose', async () => {
			const tier = new DiskStorageTier({ directory: testDir, gcIntervalMs: 200 })
			const data = new TextEncoder().encode('test')

			tier.dispose()

			const expiredTTL = new Date(Date.now() - 1000)
			await tier.set('still-here', data, makeMetadata('still-here', data.byteLength, expiredTTL))

			await new Promise((resolve) => setTimeout(resolve, 350))

			// Should still exist because GC was stopped
			expect(await tier.exists('still-here')).toBe(true)
		})
	})

	describe('gc + eviction interaction', () => {
		test('should free space so new writes succeed without LRU eviction of live entries', async () => {
			const tier = new DiskStorageTier({ directory: testDir, maxSizeBytes: 200 })
			const data = new TextEncoder().encode('x'.repeat(80))

			const expired = new Date(Date.now() - 1000)
			const alive = new Date(Date.now() + 60_000)

			await tier.set('old1', data, makeMetadata('old1', data.byteLength, expired))
			await tier.set('old2', data, makeMetadata('old2', data.byteLength, expired))

			const deleted = await tier.gc()
			expect(deleted).toBe(2)

			await tier.set('new1', data, makeMetadata('new1', data.byteLength, alive))
			await tier.set('new2', data, makeMetadata('new2', data.byteLength, alive))

			expect(await tier.exists('new1')).toBe(true)
			expect(await tier.exists('new2')).toBe(true)
		})
	})

	describe('rebuildIndex preserves TTL', () => {
		test('should track TTL through index rebuild so gc works after restart', async () => {
			const data = new TextEncoder().encode('test')
			const expiredTTL = new Date(Date.now() - 1000)

			const tier1 = new DiskStorageTier({ directory: testDir })
			await tier1.set('stale', data, makeMetadata('stale', data.byteLength, expiredTTL))

			// Simulate restart - new instance rebuilds index from disk
			const tier2 = new DiskStorageTier({ directory: testDir })
			await new Promise((resolve) => setTimeout(resolve, 100))

			const deleted = await tier2.gc()
			expect(deleted).toBe(1)
			expect(await tier2.exists('stale')).toBe(false)
		})
	})
})
