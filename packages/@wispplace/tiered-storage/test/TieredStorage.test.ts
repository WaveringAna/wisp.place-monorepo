import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { TieredStorage } from '../src/TieredStorage.js'
import { DiskStorageTier } from '../src/tiers/DiskStorageTier.js'
import { MemoryStorageTier } from '../src/tiers/MemoryStorageTier.js'

describe('TieredStorage', () => {
	const testDir = './test-cache'

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true })
	})

	describe('Basic Operations', () => {
		it('should store and retrieve data', async () => {
			const storage = new TieredStorage({
				tiers: {
					hot: new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 }),
					warm: new DiskStorageTier({ directory: `${testDir}/warm` }),
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			await storage.set('test-key', { message: 'Hello, world!' })
			const result = await storage.get('test-key')

			expect(result).toEqual({ message: 'Hello, world!' })
		})

		it('should return null for non-existent key', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			const result = await storage.get('non-existent')
			expect(result).toBeNull()
		})

		it('should delete data from all tiers', async () => {
			const storage = new TieredStorage({
				tiers: {
					hot: new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 }),
					warm: new DiskStorageTier({ directory: `${testDir}/warm` }),
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			await storage.set('test-key', { data: 'test' })
			await storage.delete('test-key')
			const result = await storage.get('test-key')

			expect(result).toBeNull()
		})

		it('should check if key exists', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			await storage.set('test-key', { data: 'test' })

			expect(await storage.exists('test-key')).toBe(true)
			expect(await storage.exists('non-existent')).toBe(false)
		})
	})

	describe('Cascading Write', () => {
		it('should write to all configured tiers', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
			})

			await storage.set('test-key', { data: 'test' })

			// Verify data exists in all tiers
			expect(await hot.exists('test-key')).toBe(true)
			expect(await warm.exists('test-key')).toBe(true)
			expect(await cold.exists('test-key')).toBe(true)
		})

		it('should skip tiers when specified', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
			})

			// Skip hot tier
			await storage.set('test-key', { data: 'test' }, { skipTiers: ['hot'] })

			expect(await hot.exists('test-key')).toBe(false)
			expect(await warm.exists('test-key')).toBe(true)
			expect(await cold.exists('test-key')).toBe(true)
		})

		it('should write only to specified tiers with onlyTiers', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
			})

			// Write only to cold tier
			await storage.set('test-key', { data: 'test' }, { onlyTiers: ['cold'] })

			expect(await hot.exists('test-key')).toBe(false)
			expect(await warm.exists('test-key')).toBe(false)
			expect(await cold.exists('test-key')).toBe(true)
		})

		it('should write only to warm and cold with onlyTiers', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
			})

			// Write to warm and cold only
			await storage.set('test-key', { data: 'test' }, { onlyTiers: ['warm', 'cold'] })

			expect(await hot.exists('test-key')).toBe(false)
			expect(await warm.exists('test-key')).toBe(true)
			expect(await cold.exists('test-key')).toBe(true)
		})

		it('should allow onlyTiers to override placement rules', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				placementRules: [{ pattern: '**', tiers: ['hot', 'warm', 'cold'] }],
			})

			// onlyTiers should override the rule
			await storage.set('test-key', { data: 'test' }, { onlyTiers: ['cold'] })

			expect(await hot.exists('test-key')).toBe(false)
			expect(await warm.exists('test-key')).toBe(false)
			expect(await cold.exists('test-key')).toBe(true)
		})

		it('should prioritize onlyTiers over skipTiers if both are provided', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
			})

			// Both onlyTiers and skipTiers - onlyTiers should win
			await storage.set(
				'test-key',
				{ data: 'test' },
				{
					onlyTiers: ['cold'],
					skipTiers: ['warm'], // This should be ignored
				},
			)

			expect(await hot.exists('test-key')).toBe(false)
			expect(await warm.exists('test-key')).toBe(false)
			expect(await cold.exists('test-key')).toBe(true)
		})
	})

	describe('Bubbling Read', () => {
		it('should read from hot tier first', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
			})

			await storage.set('test-key', { data: 'test' })
			const result = await storage.getWithMetadata('test-key')

			expect(result?.source).toBe('hot')
			expect(result?.data).toEqual({ data: 'test' })
		})

		it('should fall back to warm tier on hot miss', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
			})

			// Write to warm and cold, skip hot
			await storage.set('test-key', { data: 'test' }, { skipTiers: ['hot'] })

			const result = await storage.getWithMetadata('test-key')

			expect(result?.source).toBe('warm')
			expect(result?.data).toEqual({ data: 'test' })
		})

		it('should fall back to cold tier on hot and warm miss', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, cold },
			})

			// Write only to cold
			await cold.set('test-key', new TextEncoder().encode(JSON.stringify({ data: 'test' })), {
				key: 'test-key',
				size: 100,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc123',
			})

			const result = await storage.getWithMetadata('test-key')

			expect(result?.source).toBe('cold')
			expect(result?.data).toEqual({ data: 'test' })
		})
	})

	describe('Promotion Strategy', () => {
		it('should eagerly promote data to upper tiers', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				promotionStrategy: 'eager',
			})

			// Write only to cold
			await cold.set('test-key', new TextEncoder().encode(JSON.stringify({ data: 'test' })), {
				key: 'test-key',
				size: 100,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc123',
			})

			// Read should promote to hot and warm
			await storage.get('test-key')

			expect(await hot.exists('test-key')).toBe(true)
			expect(await warm.exists('test-key')).toBe(true)
		})

		it('should lazily promote data (not automatic)', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				promotionStrategy: 'lazy',
			})

			// Write only to cold
			await cold.set('test-key', new TextEncoder().encode(JSON.stringify({ data: 'test' })), {
				key: 'test-key',
				size: 100,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc123',
			})

			// Read should NOT promote to hot and warm
			await storage.get('test-key')

			expect(await hot.exists('test-key')).toBe(false)
			expect(await warm.exists('test-key')).toBe(false)
		})
	})

	describe('TTL Management', () => {
		it('should expire data after TTL', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			// Set with 100ms TTL
			await storage.set('test-key', { data: 'test' }, { ttl: 100 })

			// Should exist immediately
			expect(await storage.get('test-key')).toEqual({ data: 'test' })

			// Wait for expiration
			await new Promise((resolve) => setTimeout(resolve, 150))

			// Should be null after expiration
			expect(await storage.get('test-key')).toBeNull()
		})

		it('should renew TTL with touch', async () => {
			const storage = new TieredStorage({
				tiers: {
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
				defaultTTL: 100,
			})

			await storage.set('test-key', { data: 'test' })

			// Wait 50ms
			await new Promise((resolve) => setTimeout(resolve, 50))

			// Renew TTL
			await storage.touch('test-key', 200)

			// Wait another 100ms (would have expired without touch)
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Should still exist
			expect(await storage.get('test-key')).toEqual({ data: 'test' })
		})
	})

	describe('Prefix Invalidation', () => {
		it('should invalidate all keys with prefix', async () => {
			const storage = new TieredStorage({
				tiers: {
					hot: new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 }),
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			await storage.set('user:123', { name: 'Alice' })
			await storage.set('user:456', { name: 'Bob' })
			await storage.set('post:789', { title: 'Test' })

			const deleted = await storage.invalidate('user:')

			expect(deleted).toBe(2)
			expect(await storage.exists('user:123')).toBe(false)
			expect(await storage.exists('user:456')).toBe(false)
			expect(await storage.exists('post:789')).toBe(true)
		})
	})

	describe('Compression', () => {
		it('should compress data when enabled', async () => {
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { cold },
				compression: true,
			})

			const largeData = { data: 'x'.repeat(10000) }
			const result = await storage.set('test-key', largeData)

			// Check that compressed flag is set
			expect(result.metadata.compressed).toBe(true)

			// Verify data can be retrieved correctly
			const retrieved = await storage.get('test-key')
			expect(retrieved).toEqual(largeData)
		})
	})

	describe('Bootstrap', () => {
		it('should bootstrap hot from warm', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
			})

			// Write some data
			await storage.set('key1', { data: '1' })
			await storage.set('key2', { data: '2' })
			await storage.set('key3', { data: '3' })

			// Clear hot tier
			await hot.clear()

			// Bootstrap hot from warm
			const loaded = await storage.bootstrapHot()

			expect(loaded).toBe(3)
			expect(await hot.exists('key1')).toBe(true)
			expect(await hot.exists('key2')).toBe(true)
			expect(await hot.exists('key3')).toBe(true)
		})

		it('should bootstrap warm from cold', async () => {
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { warm, cold },
			})

			// Write directly to cold
			await cold.set('key1', new TextEncoder().encode(JSON.stringify({ data: '1' })), {
				key: 'key1',
				size: 100,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			})

			// Bootstrap warm from cold
			const loaded = await storage.bootstrapWarm({ limit: 10 })

			expect(loaded).toBe(1)
			expect(await warm.exists('key1')).toBe(true)
		})
	})

	describe('Statistics', () => {
		it('should return statistics for all tiers', async () => {
			const storage = new TieredStorage({
				tiers: {
					hot: new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 }),
					warm: new DiskStorageTier({ directory: `${testDir}/warm` }),
					cold: new DiskStorageTier({ directory: `${testDir}/cold` }),
				},
			})

			await storage.set('key1', { data: 'test1' })
			await storage.set('key2', { data: 'test2' })

			const stats = await storage.getStats()

			expect(stats.cold.items).toBe(2)
			expect(stats.warm?.items).toBe(2)
			expect(stats.hot?.items).toBe(2)
		})
	})

	describe('Placement Rules', () => {
		it('should place index.html in all tiers based on rule', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				placementRules: [
					{ pattern: '**/index.html', tiers: ['hot', 'warm', 'cold'] },
					{ pattern: '**', tiers: ['warm', 'cold'] },
				],
			})

			await storage.set('site:abc/index.html', { content: 'hello' })

			expect(await hot.exists('site:abc/index.html')).toBe(true)
			expect(await warm.exists('site:abc/index.html')).toBe(true)
			expect(await cold.exists('site:abc/index.html')).toBe(true)
		})

		it('should skip hot tier for non-matching files', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				placementRules: [
					{ pattern: '**/index.html', tiers: ['hot', 'warm', 'cold'] },
					{ pattern: '**', tiers: ['warm', 'cold'] },
				],
			})

			await storage.set('site:abc/about.html', { content: 'about' })

			expect(await hot.exists('site:abc/about.html')).toBe(false)
			expect(await warm.exists('site:abc/about.html')).toBe(true)
			expect(await cold.exists('site:abc/about.html')).toBe(true)
		})

		it('should match directory patterns', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				placementRules: [
					{ pattern: 'assets/**', tiers: ['warm', 'cold'] },
					{ pattern: '**', tiers: ['hot', 'warm', 'cold'] },
				],
			})

			await storage.set('assets/images/logo.png', { data: 'png' })
			await storage.set('index.html', { data: 'html' })

			// assets/** should skip hot
			expect(await hot.exists('assets/images/logo.png')).toBe(false)
			expect(await warm.exists('assets/images/logo.png')).toBe(true)

			// everything else goes to all tiers
			expect(await hot.exists('index.html')).toBe(true)
		})

		it('should match file extension patterns', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				placementRules: [
					{ pattern: '**/*.{jpg,png,gif,mp4}', tiers: ['warm', 'cold'] },
					{ pattern: '**', tiers: ['hot', 'warm', 'cold'] },
				],
			})

			await storage.set('site/hero.png', { data: 'image' })
			await storage.set('site/video.mp4', { data: 'video' })
			await storage.set('site/index.html', { data: 'html' })

			// Images and video skip hot
			expect(await hot.exists('site/hero.png')).toBe(false)
			expect(await hot.exists('site/video.mp4')).toBe(false)

			// HTML goes everywhere
			expect(await hot.exists('site/index.html')).toBe(true)
		})

		it('should use first matching rule', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				placementRules: [
					// Specific rule first
					{ pattern: 'assets/critical.css', tiers: ['hot', 'warm', 'cold'] },
					// General rule second
					{ pattern: 'assets/**', tiers: ['warm', 'cold'] },
					{ pattern: '**', tiers: ['warm', 'cold'] },
				],
			})

			await storage.set('assets/critical.css', { data: 'css' })
			await storage.set('assets/style.css', { data: 'css' })

			// critical.css matches first rule -> hot
			expect(await hot.exists('assets/critical.css')).toBe(true)

			// style.css matches second rule -> no hot
			expect(await hot.exists('assets/style.css')).toBe(false)
		})

		it('should allow skipTiers to override placement rules', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				placementRules: [{ pattern: '**', tiers: ['hot', 'warm', 'cold'] }],
			})

			// Explicit skipTiers should override the rule
			await storage.set('large-file.bin', { data: 'big' }, { skipTiers: ['hot'] })

			expect(await hot.exists('large-file.bin')).toBe(false)
			expect(await warm.exists('large-file.bin')).toBe(true)
			expect(await cold.exists('large-file.bin')).toBe(true)
		})

		it('should always include cold tier even if not in rule', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				placementRules: [
					// Rule doesn't include cold (should be auto-added)
					{ pattern: '**', tiers: ['hot', 'warm'] },
				],
			})

			await storage.set('test-key', { data: 'test' })

			expect(await cold.exists('test-key')).toBe(true)
		})

		it('should write to all tiers when no rules match', async () => {
			const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
			const warm = new DiskStorageTier({ directory: `${testDir}/warm` })
			const cold = new DiskStorageTier({ directory: `${testDir}/cold` })

			const storage = new TieredStorage({
				tiers: { hot, warm, cold },
				placementRules: [{ pattern: 'specific-pattern-only', tiers: ['warm', 'cold'] }],
			})

			// This doesn't match any rule
			await storage.set('other-key', { data: 'test' })

			expect(await hot.exists('other-key')).toBe(true)
			expect(await warm.exists('other-key')).toBe(true)
			expect(await cold.exists('other-key')).toBe(true)
		})
	})
})
