import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logCollector } from '@wispplace/observability'
import { MemoryStorageTier, type StorageMetadata, type StorageTier } from '@wispplace/tiered-storage'

const cacheDir = join(tmpdir(), `wisp-storage-test-${process.pid}-${Date.now()}`)
const environmentNames = [
	'CACHE_DIR',
	'HOT_CACHE_SIZE',
	'HOT_CACHE_COUNT',
	'WARM_CACHE_SIZE',
	'HOT_CACHE_TTL',
	'S3_BUCKET',
	'PRIVATE_S3_BUCKET',
] as const
const originalEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]))

process.env.CACHE_DIR = cacheDir
process.env.HOT_CACHE_SIZE = 'NaN'
process.env.HOT_CACHE_COUNT = '0'
process.env.WARM_CACHE_SIZE = '-1'
process.env.HOT_CACHE_TTL = '9007199254740992'
process.env.S3_BUCKET = ''
process.env.PRIVATE_S3_BUCKET = ''

const storageTestModule = './storage?storage-test'
const {
	ReadOnlyS3Tier,
	StorageUnavailableError,
	evictPublicCacheKey,
	getStorageConfig,
	hotTier,
	isStorageUnavailableError,
	privateStorage,
	resolveHostingStorageConfig,
	storage,
	warmTier,
} = (await import(storageTestModule)) as typeof import('./storage')

type StorageInternals = {
	config: { tiers: { cold: StorageTier; hot?: StorageTier; warm?: StorageTier } }
}
type TTLMemoryTierInternals = { insertedAt: Map<string, number>; ttlMs: number }

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

beforeEach(async () => {
	await hotTier.clear()
	logCollector.clear()
})

afterAll(async () => {
	await storage.getStats()
	await rm(cacheDir, { recursive: true, force: true })
	for (const name of environmentNames) {
		const original = originalEnvironment.get(name)
		if (original === undefined) {
			delete process.env[name]
		} else {
			process.env[name] = original
		}
	}
})

describe('hosting storage configuration', () => {
	test('falls back from invalid numeric storage environment values', () => {
		expect(getStorageConfig()).toMatchObject({
			hotCacheSize: '100MB',
			hotCacheCount: 500,
			warmCacheSize: '10.0GB',
		})
		expect((hotTier as unknown as TTLMemoryTierInternals).ttlMs).toBe(60_000)
	})

	test('shares the disk tier between public and private disk-only storage', () => {
		expect(warmTier).toBeUndefined()
		expect((storage as unknown as StorageInternals).config.tiers.cold).toBe(
			(privateStorage as unknown as StorageInternals).config.tiers.cold,
		)
	})

	test('evicts one public key from hot and warm without touching cold storage', async () => {
		const internals = storage as unknown as StorageInternals
		const originalWarm = internals.config.tiers.warm
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const key = 'source-cid-check/index.html'
		const data = new Uint8Array([1, 2, 3])
		internals.config.tiers.warm = warm

		try {
			await storage.set(key, data, { onlyTiers: ['hot', 'warm', 'cold'] })
			expect(await hotTier.get(key)).toEqual(data)
			expect(await warm.get(key)).toEqual(data)
			expect(await internals.config.tiers.cold.get(key)).toEqual(data)

			await Promise.all([evictPublicCacheKey(key), evictPublicCacheKey(key)])
			expect(await hotTier.get(key)).toBeNull()
			expect(await warm.get(key)).toBeNull()
			expect(await internals.config.tiers.cold.get(key)).toEqual(data)
		} finally {
			internals.config.tiers.warm = originalWarm
		}
	})
})

describe('TTLMemoryTier timestamp bookkeeping', () => {
	test('drops timestamps for count-evicted keys', async () => {
		const data = new Uint8Array([1])
		for (let index = 0; index <= 500; index++) {
			const key = `entry-${index}`
			await hotTier.set(key, data, metadata(key, data.byteLength))
		}

		const insertedAt = (hotTier as unknown as TTLMemoryTierInternals).insertedAt
		expect(insertedAt.has('entry-0')).toBe(false)
		expect(insertedAt.has('entry-500')).toBe(true)
		expect(insertedAt.size).toBe(500)
	})

	test('does not leave a timestamp behind when the inner write fails', async () => {
		const insertedAt = (hotTier as unknown as TTLMemoryTierInternals).insertedAt
		const originalSet = hotTier.inner.set.bind(hotTier.inner)
		hotTier.inner.set = async () => {
			throw new Error('injected memory write failure')
		}

		const data = new Uint8Array([1])
		try {
			await expect(hotTier.set('failed', data, metadata('failed', data.byteLength))).rejects.toThrow(
				'injected memory write failure',
			)
		} finally {
			hotTier.inner.set = originalSet
		}

		expect(insertedAt.has('failed')).toBe(false)
	})
})

describe('hosting storage source configuration', () => {
	const productionBase = {
		NODE_ENV: 'production',
		CACHE_DIR: '/cache/sites',
		S3_BUCKET: 'wisp-sites',
		S3_ENDPOINT: 'https://storage.example',
		REDIS_URL: 'rediss://redis.example:6379',
	}

	test('treats an unknown environment as production-like', () => {
		expect(() => resolveHostingStorageConfig({ CACHE_DIR: '/cache/sites' })).toThrow(
			'S3_BUCKET is required unless disk-source mode is explicitly enabled',
		)
		expect(() => resolveHostingStorageConfig({ ...productionBase, NODE_ENV: undefined, REDIS_URL: undefined })).toThrow(
			'REDIS_URL is required unless disk-source mode is explicitly enabled',
		)
	})

	test('allows disk source only in explicit local modes or the explicit single-node flag', () => {
		expect(resolveHostingStorageConfig({ NODE_ENV: 'development', CACHE_DIR: '/cache/sites' }).allowDiskSource).toBe(
			true,
		)
		expect(resolveHostingStorageConfig({ NODE_ENV: 'test', CACHE_DIR: '/cache/sites' }).allowDiskSource).toBe(true)
		expect(
			resolveHostingStorageConfig({ HOSTING_ALLOW_DISK_SOURCE: 'true', CACHE_DIR: '/cache/sites' }).allowDiskSource,
		).toBe(true)
		expect(() => resolveHostingStorageConfig({ ...productionBase, HOSTING_ALLOW_DISK_SOURCE: 'true' })).toThrow(
			'HOSTING_ALLOW_DISK_SOURCE cannot be used with S3_BUCKET',
		)
	})

	test('validates production endpoint, prefix, and cache paths before startup', () => {
		expect(resolveHostingStorageConfig(productionBase)).toMatchObject({
			s3Bucket: 'wisp-sites',
			s3Prefix: 'sites/',
			allowDiskSource: false,
		})
		expect(resolveHostingStorageConfig({ ...productionBase, S3_PREFIX: 'sites/' }).s3Prefix).toBe('sites/')
		expect(resolveHostingStorageConfig({ ...productionBase, S3_PREFIX: 'nested/namespace' }).s3Prefix).toBe(
			'nested/namespace/',
		)
		expect(resolveHostingStorageConfig({ ...productionBase, S3_PREFIX: 'nested/namespace/' }).s3Prefix).toBe(
			'nested/namespace/',
		)
		expect(() => resolveHostingStorageConfig({ ...productionBase, S3_ENDPOINT: 'http://storage.example' })).toThrow(
			'Invalid S3_ENDPOINT',
		)
		for (const prefix of ['../other/', 'sites//other/', '/sites/', 'sites\\other/', 'sites/./other/']) {
			expect(() => resolveHostingStorageConfig({ ...productionBase, S3_PREFIX: prefix })).toThrow('Invalid S3_PREFIX')
		}
		expect(() => resolveHostingStorageConfig({ ...productionBase, CACHE_DIR: '/' })).toThrow('Invalid CACHE_DIR')
		expect(() => resolveHostingStorageConfig({ ...productionBase, CACHE_DIR: process.cwd() })).toThrow(
			'Invalid CACHE_DIR',
		)
		expect(
			resolveHostingStorageConfig({
				NODE_ENV: 'development',
				CACHE_DIR: '/cache/sites',
				S3_BUCKET: 'wisp-dev',
				REDIS_URL: 'redis://127.0.0.1:6379',
				S3_ENDPOINT: 'http://127.0.0.1:9000',
			}).s3Endpoint,
		).toBe('http://127.0.0.1:9000')
	})
})

describe('ReadOnlyS3Tier availability contract', () => {
	test('keeps an authoritative NoSuchKey miss as null without recording an outage', async () => {
		const inner = new MemoryStorageTier({ maxSizeBytes: 1024 })
		const missing = new Error('not found')
		missing.name = 'NoSuchKey'
		inner.get = async () => {
			throw missing
		}
		const tier = new ReadOnlyS3Tier(inner)

		expect(await tier.get('missing')).toBeNull()
		expect(tier.getHealthSnapshot()).toMatchObject({
			breaker: 'closed',
			consecutiveFailures: 0,
			totalFailures: 0,
			totalSuccesses: 1,
		})
		expect(logCollector.getLogs()).toHaveLength(0)
	})

	test('surfaces transient failures and opens a bounded breaker instead of returning a miss', async () => {
		const inner = new MemoryStorageTier({ maxSizeBytes: 1024 })
		let reads = 0
		inner.get = async () => {
			reads++
			const error = new Error('transient driver detail must not escape')
			error.name = 'TimeoutError'
			throw error
		}
		const tier = new ReadOnlyS3Tier(inner)

		for (let index = 0; index < 3; index++) {
			await expect(tier.get(`key-${index}`)).rejects.toMatchObject({
				operation: 'get',
				kind: 'timeout',
			})
		}
		await expect(tier.get('breaker-key')).rejects.toMatchObject({
			operation: 'get',
			kind: 'circuit-open',
		})
		expect(reads).toBe(3)
		expect(tier.getHealthSnapshot()).toMatchObject({
			breaker: 'open',
			consecutiveFailures: 3,
			totalFailures: 3,
			circuitRejections: 1,
			lastErrorKind: 'timeout',
		})
	})

	test('logs only safe fields while typed errors propagate from reads and listing', async () => {
		const bucketUrl = 'https://private-bucket.example'
		const key = 'private-prefix/top-secret-file'
		const prefix = 'private-prefix/'
		const secret = `${bucketUrl}/${key}?signature=do-not-log`
		const driverError = new Error(secret)
		driverError.name = `${bucketUrl}/${key}`
		const inner = new MemoryStorageTier({ maxSizeBytes: 1024 })
		inner.get = async () => {
			throw driverError
		}
		inner.listKeys = async function* () {
			yield 'already-listed'
			throw driverError
		}
		const tier = new ReadOnlyS3Tier(inner)

		await expect(tier.get(key)).rejects.toBeInstanceOf(StorageUnavailableError)
		const listed: string[] = []
		const listResult = (async () => {
			for await (const listedKey of tier.listKeys(prefix)) {
				listed.push(listedKey)
			}
		})()
		try {
			await listResult
			throw new Error('Expected listKeys to reject')
		} catch (error) {
			expect(isStorageUnavailableError(error)).toBe(true)
		}
		expect(listed).toEqual(['already-listed'])

		const logs = logCollector.getLogs()
		expect(logs).toHaveLength(2)
		expect(logs.map((entry) => entry.message)).toEqual(['S3 read operation failed', 'S3 read operation failed'])
		expect(logs.map((entry) => entry.context)).toEqual([
			expect.objectContaining({
				operation: 'listKeys',
				errorKind: 'unknown',
				errorDigest: expect.stringMatching(/^[a-f0-9]{16}$/),
			}),
			expect.objectContaining({
				operation: 'get',
				errorKind: 'unknown',
				errorDigest: expect.stringMatching(/^[a-f0-9]{16}$/),
			}),
		])
		const serializedLogs = JSON.stringify(logs)
		expect(serializedLogs).not.toContain(bucketUrl)
		expect(serializedLogs).not.toContain(key)
		expect(serializedLogs).not.toContain(prefix)
		expect(serializedLogs).not.toContain(secret)
	})
})
