import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Redis from 'ioredis'
import type {
	CacheInvalidationDependenciesForTests,
	CacheInvalidationGapRecoveryDependencies,
	CacheInvalidationMessage,
} from './cache-invalidation'

const DID = 'did:plc:test'
const RKEY = 'site'
const cursorFile = join(tmpdir(), `wisp-cache-invalidation-${process.pid}.lastid`)
const originalCursorFile = process.env.WISP_CACHE_INVALIDATION_CURSOR_FILE
const originalRedisUrl = process.env.REDIS_URL

const hotPrefixes: string[] = []
const warmPrefixes: string[] = []
const cacheDeletes: Array<[string, string]> = []
const cachePrefixDeletes: Array<[string, string]> = []
const htmlWarmupResets: Array<[string, string]> = []
const redisClients: FakeRedis[] = []
let hotFailuresRemaining = 0
let xinfoFirstEntryId: string | null = null
let xinfoResponse: unknown | null = null
let xinfoError: Error | null = null
let notifyReplayRead: (() => void) | null = null

class FakeRedis {
	readonly xreadArguments: unknown[][] = []
	readonly options: Record<string, unknown> | undefined
	status = 'ready'
	pingCount = 0
	pingError: Error | null = null
	disconnected = false
	private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
	private rejectPendingRead: ((reason?: unknown) => void) | null = null

	constructor(...args: unknown[]) {
		this.options = args[1] as Record<string, unknown> | undefined
		redisClients.push(this)
	}

	on(event: string, listener: (...args: unknown[]) => void): this {
		const listeners = this.listeners.get(event) ?? []
		listeners.push(listener)
		this.listeners.set(event, listeners)
		return this
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(...args)
		}
	}

	deferredSubscribeAck = false
	subscribeError: Error | null = null
	subscribeCalls: string[] = []
	private subscribeCallback: ((error: Error | null) => void) | null = null

	subscribe(channel: string, callback: (error: Error | null) => void): void {
		this.subscribeCalls.push(channel)
		if (this.deferredSubscribeAck) {
			this.subscribeCallback = callback
			return
		}
		callback(this.subscribeError)
	}

	ackSubscribe(): void {
		this.subscribeCallback?.(this.subscribeError)
		this.subscribeCallback = null
	}

	async ping(): Promise<string> {
		this.pingCount += 1
		if (this.pingError) throw this.pingError
		return 'PONG'
	}

	async xinfo(..._args: unknown[]): Promise<unknown> {
		if (xinfoError) throw xinfoError
		if (xinfoResponse !== null) return xinfoResponse
		return xinfoFirstEntryId ? ['first-entry', [xinfoFirstEntryId, []]] : []
	}

	xread(...args: unknown[]): Promise<null> {
		this.xreadArguments.push(args)
		// A real ioredis client rejects commands after 'end'; mirror that so a
		// replay loop reaching XREAD after disconnect cannot hang on a promise
		// that never settles.
		if (this.disconnected) {
			return Promise.reject(new Error('Connection is closed.'))
		}
		notifyReplayRead?.()
		notifyReplayRead = null
		return new Promise((_, reject) => {
			this.rejectPendingRead = reject
		})
	}

	disconnect(): void {
		this.disconnected = true
		this.rejectPendingRead?.(new Error('Redis disconnected'))
		this.rejectPendingRead = null
	}
}

/**
 * Captures heartbeat interval requests instead of running real timers. Each
 * scheduled entry stays fireable until its cancel handle is called, mirroring a
 * real clearInterval without needing fake time.
 */
class FakeHeartbeatScheduler {
	readonly requestedIntervalMs: number[] = []
	cancelledCount = 0
	private readonly entries: Array<{ intervalMs: number; cancelled: boolean; tick: () => void }> = []

	schedule = (callback: () => void, intervalMs: number): (() => void) => {
		const entry = { intervalMs, cancelled: false, tick: callback }
		this.entries.push(entry)
		this.requestedIntervalMs.push(intervalMs)
		return () => {
			entry.cancelled = true
			this.cancelledCount += 1
		}
	}

	get activeCount(): number {
		return this.entries.filter((entry) => !entry.cancelled).length
	}

	fireActiveTicks(): void {
		for (const entry of [...this.entries]) {
			if (!entry.cancelled) entry.tick()
		}
	}
}

const fakeHotTier = {
	async deletePrefix(prefix: string): Promise<number> {
		hotPrefixes.push(prefix)
		if (hotFailuresRemaining > 0) {
			hotFailuresRemaining -= 1
			throw new Error('hot tier unavailable')
		}
		return 3
	},
}

const fakeWarmTier = {
	async deletePrefix(prefix: string): Promise<number> {
		warmPrefixes.push(prefix)
		return 2
	},
}

const fakeCache = {
	delete(namespace: string, key: string): void {
		cacheDeletes.push([namespace, key])
	},
	deletePrefix(namespace: string, prefix: string): void {
		cachePrefixDeletes.push([namespace, prefix])
	},
}

// Keep replay cursor test writes out of the repository while exercising the
// real persistence queue.
process.env.WISP_CACHE_INVALIDATION_CURSOR_FILE = cursorFile

const {
	applyCacheInvalidationForTests,
	clearSiteUpdating,
	compareStreamIds,
	getCacheInvalidationHealthSnapshot,
	getLastProcessedStreamIdForTests,
	getUpdatingSiteCountForTests,
	isSiteUpdating,
	markSiteUpdating,
	parseCacheInvalidationMessage,
	parseCacheInvalidationStreamEntry,
	resetCacheInvalidationReplayForTests,
	stopCacheInvalidationSubscriber,
	resetUpdatingSitesForTests,
	startCacheInvalidationSubscriberForTests,
} = await import('./cache-invalidation')

const testDependencies: CacheInvalidationDependenciesForTests = {
	hotTier: fakeHotTier as unknown as CacheInvalidationDependenciesForTests['hotTier'],
	warmTier: fakeWarmTier as unknown as CacheInvalidationDependenciesForTests['warmTier'],
	cache: fakeCache as unknown as CacheInvalidationDependenciesForTests['cache'],
	resetSiteHtmlHotCacheWarmup(did: string, rkey: string): void {
		htmlWarmupResets.push([did, rkey])
	},
}

function applyForTest(parsed: CacheInvalidationMessage, source: 'pubsub' | 'replay' = 'pubsub'): Promise<void> {
	return applyCacheInvalidationForTests(parsed, source, testDependencies)
}

function siteMessage(
	action: Extract<CacheInvalidationMessage['action'], 'updating' | 'update' | 'delete' | 'settings'>,
	overrides: Partial<CacheInvalidationMessage> = {},
): CacheInvalidationMessage {
	return { did: DID, rkey: RKEY, action, ...overrides }
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
}

function waitForReplayRead(): Promise<void> {
	return new Promise((resolve) => {
		notifyReplayRead = resolve
	})
}

beforeEach(async () => {
	await resetCacheInvalidationReplayForTests()
	await rm(cursorFile, { force: true })
	resetUpdatingSitesForTests()
	hotPrefixes.length = 0
	warmPrefixes.length = 0
	cacheDeletes.length = 0
	cachePrefixDeletes.length = 0
	htmlWarmupResets.length = 0
	redisClients.length = 0
	hotFailuresRemaining = 0
	xinfoFirstEntryId = null
	xinfoResponse = null
	xinfoError = null
	notifyReplayRead = null
})

afterAll(async () => {
	await resetCacheInvalidationReplayForTests()
	await rm(cursorFile, { force: true })
	if (originalCursorFile === undefined) {
		delete process.env.WISP_CACHE_INVALIDATION_CURSOR_FILE
	} else {
		process.env.WISP_CACHE_INVALIDATION_CURSOR_FILE = originalCursorFile
	}
	if (originalRedisUrl === undefined) {
		delete process.env.REDIS_URL
	} else {
		process.env.REDIS_URL = originalRedisUrl
	}
})

describe('cache invalidation updating state', () => {
	test('stale token cannot clear a newer update', () => {
		markSiteUpdating(DID, RKEY, 'token-a')
		markSiteUpdating(DID, RKEY, 'token-b')

		expect(clearSiteUpdating(DID, RKEY, 'token-a')).toBe(false)
		expect(isSiteUpdating(DID, RKEY)).toBe(true)
	})

	test('matching token clears the active update', () => {
		markSiteUpdating(DID, RKEY, 'token-a')

		expect(clearSiteUpdating(DID, RKEY, 'token-a')).toBe(true)
		expect(isSiteUpdating(DID, RKEY)).toBe(false)
	})

	test('unversioned clear remains backward compatible', () => {
		markSiteUpdating(DID, RKEY, 'token-a')

		expect(clearSiteUpdating(DID, RKEY)).toBe(true)
		expect(isSiteUpdating(DID, RKEY)).toBe(false)
	})

	test('a newer terminal stream clears an older marker despite a different token', () => {
		markSiteUpdating(DID, RKEY, 'token-a', '1-0')

		expect(clearSiteUpdating(DID, RKEY, 'token-b', '2-0')).toBe(true)
		expect(isSiteUpdating(DID, RKEY)).toBe(false)
	})

	test('an older terminal stream cannot clear a newer marker despite a different token', () => {
		markSiteUpdating(DID, RKEY, 'token-b', '2-0')

		expect(clearSiteUpdating(DID, RKEY, 'token-a', '1-0')).toBe(false)
		expect(isSiteUpdating(DID, RKEY)).toBe(true)
	})

	test('legacy unversioned token mismatch cannot clear a marker', () => {
		markSiteUpdating(DID, RKEY, 'token-a')

		expect(clearSiteUpdating(DID, RKEY, 'token-b')).toBe(false)
		expect(isSiteUpdating(DID, RKEY)).toBe(true)
	})

	test('legacy token matching remains compatible when only the start has a stream id', () => {
		markSiteUpdating(DID, RKEY, 'token-a', '2-0')

		expect(clearSiteUpdating(DID, RKEY, 'token-a')).toBe(true)
		expect(isSiteUpdating(DID, RKEY)).toBe(false)
	})

	test('tokenized final update invalidates when the updating marker is absent', async () => {
		await applyForTest(siteMessage('update', { token: 'token-a' }))

		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(warmPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(isSiteUpdating(DID, RKEY)).toBe(false)
	})

	test('tokenized final update clears a matching marker and invalidates', async () => {
		markSiteUpdating(DID, RKEY, 'token-a')

		await applyForTest(siteMessage('update', { token: 'token-a' }))

		expect(isSiteUpdating(DID, RKEY)).toBe(false)
		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(warmPrefixes).toEqual([`${DID}/${RKEY}/`])
	})

	test('tokenized final update keeps a newer marker and still invalidates', async () => {
		markSiteUpdating(DID, RKEY, 'token-b')

		await applyForTest(siteMessage('update', { token: 'token-a' }))

		expect(isSiteUpdating(DID, RKEY)).toBe(true)
		expect(clearSiteUpdating(DID, RKEY, 'token-b')).toBe(true)
		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(warmPrefixes).toEqual([`${DID}/${RKEY}/`])
	})

	test('marking a new site prunes expired updating entries that were never requested', () => {
		const originalNow = Date.now
		let now = 1_000_000
		Date.now = () => now

		try {
			markSiteUpdating(DID, 'expired-a')
			markSiteUpdating(DID, 'expired-b')

			now += 10 * 60 * 1000 + 1
			markSiteUpdating(DID, 'active')

			expect(getUpdatingSiteCountForTests()).toBe(1)
			expect(isSiteUpdating(DID, 'active')).toBe(true)
			expect(isSiteUpdating(DID, 'expired-a')).toBe(false)
			expect(isSiteUpdating(DID, 'expired-b')).toBe(false)
		} finally {
			Date.now = originalNow
		}
	})

	test('updating state is capped even when entries have not expired', () => {
		for (let i = 0; i < 10_005; i++) {
			markSiteUpdating(DID, `site-${i}`)
		}

		expect(getUpdatingSiteCountForTests()).toBe(10_000)
		expect(isSiteUpdating(DID, 'site-0')).toBe(false)
		expect(isSiteUpdating(DID, 'site-5')).toBe(true)
		expect(isSiteUpdating(DID, 'site-10004')).toBe(true)
	})
})

describe('cache invalidation actions', () => {
	test('settings only clears settings-dependent memory caches', async () => {
		markSiteUpdating(DID, RKEY, 'active-update')

		await applyForTest(siteMessage('settings'))

		expect(hotPrefixes).toEqual([])
		expect(warmPrefixes).toEqual([])
		expect(cacheDeletes).toEqual([
			['redirectRules', `${DID}:${RKEY}`],
			['settings', `${DID}:${RKEY}`],
		])
		expect(cachePrefixDeletes).toEqual([
			['siteFiles', `${DID}:${RKEY}:`],
			['sourceCidMismatches', `${DID}:${RKEY}:`],
		])
		expect(htmlWarmupResets).toEqual([])
		expect(isSiteUpdating(DID, RKEY)).toBe(true)
	})

	test('site update purges file tiers and related memory caches', async () => {
		await applyForTest(siteMessage('update'))

		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(warmPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(cacheDeletes).toEqual([
			['redirectRules', `${DID}:${RKEY}`],
			['settings', `${DID}:${RKEY}`],
			['siteCache', `${DID}:${RKEY}`],
		])
		expect(cachePrefixDeletes).toEqual([
			['siteFiles', `${DID}:${RKEY}:`],
			['sourceCidMismatches', `${DID}:${RKEY}:`],
		])
		expect(htmlWarmupResets).toEqual([[DID, RKEY]])
	})

	test('site delete purges file tiers and related memory caches', async () => {
		await applyForTest(siteMessage('delete'))

		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(warmPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(cacheDeletes).toEqual([
			['redirectRules', `${DID}:${RKEY}`],
			['settings', `${DID}:${RKEY}`],
			['siteCache', `${DID}:${RKEY}`],
		])
		expect(cachePrefixDeletes).toEqual([
			['siteFiles', `${DID}:${RKEY}:`],
			['sourceCidMismatches', `${DID}:${RKEY}:`],
		])
		expect(htmlWarmupResets).toEqual([[DID, RKEY]])
	})

	test('uses the TieredStorage upper-cache invalidation fence when no tiers are injected', async () => {
		const upperCachePrefixes: string[] = []
		const productionStyleDependencies: CacheInvalidationDependenciesForTests = {
			storage: {
				async invalidateUpperCaches(prefix: string) {
					upperCachePrefixes.push(prefix)
					return { hotDeleted: 3, warmDeleted: 2, failures: [] }
				},
			},
			cache: fakeCache,
			resetSiteHtmlHotCacheWarmup(did: string, rkey: string): void {
				htmlWarmupResets.push([did, rkey])
			},
		}

		await applyCacheInvalidationForTests(siteMessage('update'), 'pubsub', productionStyleDependencies)

		expect(upperCachePrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(hotPrefixes).toEqual([])
		expect(warmPrefixes).toEqual([])
		expect(htmlWarmupResets).toEqual([[DID, RKEY]])
	})
})

describe('cache invalidation replay', () => {
	test('a higher live stream id cannot skip an earlier replay event for another site', async () => {
		const liveTarget = { did: DID, rkey: 'live-site', action: 'update' as const, streamId: '2-0' }
		const earlierReplayTarget = { did: DID, rkey: 'replay-site', action: 'update' as const, streamId: '1-0' }

		await applyForTest(liveTarget, 'pubsub')
		expect(getLastProcessedStreamIdForTests()).toBe('0-0')

		await applyForTest(earlierReplayTarget, 'replay')
		expect(getLastProcessedStreamIdForTests()).toBe('1-0')

		await applyForTest(liveTarget, 'replay')
		expect(getLastProcessedStreamIdForTests()).toBe('2-0')
		expect(hotPrefixes).toEqual([`${DID}/live-site/`, `${DID}/replay-site/`, `${DID}/live-site/`])
	})

	test('a live terminal update suppresses an older replayed updating marker', async () => {
		const terminal = siteMessage('update', { token: 'token-a', streamId: '2-0' })
		const olderUpdating = siteMessage('updating', { token: 'token-a', streamId: '1-0' })

		await applyForTest(terminal, 'pubsub')
		await applyForTest(olderUpdating, 'replay')

		expect(isSiteUpdating(DID, RKEY)).toBe(false)
		expect(getLastProcessedStreamIdForTests()).toBe('1-0')
		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`])

		// Replay still reapplies the terminal event idempotently and advances only in order.
		await applyForTest(terminal, 'replay')
		expect(getLastProcessedStreamIdForTests()).toBe('2-0')
	})

	test('an older tokenless delete retains a newer live updating marker but still purges stale caches', async () => {
		await applyForTest(siteMessage('updating', { token: 'token-new', streamId: '2-0' }), 'pubsub')
		await applyForTest(siteMessage('delete', { streamId: '1-0' }), 'replay')

		expect(isSiteUpdating(DID, RKEY)).toBe(true)
		expect(getLastProcessedStreamIdForTests()).toBe('1-0')
		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(warmPrefixes).toEqual([`${DID}/${RKEY}/`])
	})

	test('settings and terminal invalidations remain independent across out-of-order delivery', async () => {
		await applyForTest(siteMessage('settings', { streamId: '2-0' }), 'pubsub')
		await applyForTest(siteMessage('delete', { streamId: '1-0' }), 'replay')

		// A newer settings event cannot suppress an older terminal file purge.
		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(warmPrefixes).toEqual([`${DID}/${RKEY}/`])
		expect(getLastProcessedStreamIdForTests()).toBe('1-0')

		const otherTerminal = { did: DID, rkey: 'mixed-site', action: 'update' as const, streamId: '3-0' }
		const olderSettings = { did: DID, rkey: 'mixed-site', action: 'settings' as const, streamId: '2-0' }
		await applyForTest(otherTerminal, 'pubsub')
		cacheDeletes.length = 0
		cachePrefixDeletes.length = 0
		await applyForTest(olderSettings, 'replay')

		// Settings cleanup is also safe after a terminal event for the same site.
		expect(cacheDeletes).toEqual([
			['redirectRules', `${DID}:mixed-site`],
			['settings', `${DID}:mixed-site`],
		])
		expect(cachePrefixDeletes).toEqual([
			['siteFiles', `${DID}:mixed-site:`],
			['sourceCidMismatches', `${DID}:mixed-site:`],
		])
		expect(getLastProcessedStreamIdForTests()).toBe('2-0')
	})

	test('tier failure does not advance the replay cursor and retries the same event', async () => {
		hotFailuresRemaining = 1
		const event = siteMessage('update', { streamId: '3-0' })

		await expect(applyForTest(event, 'replay')).rejects.toThrow('Failed to invalidate file caches')
		expect(getLastProcessedStreamIdForTests()).toBe('0-0')
		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`])
		// Warm cleanup still ran despite the hot-tier failure.
		expect(warmPrefixes).toEqual([`${DID}/${RKEY}/`])

		await applyForTest(event, 'replay')
		expect(getLastProcessedStreamIdForTests()).toBe('3-0')
		expect(hotPrefixes).toEqual([`${DID}/${RKEY}/`, `${DID}/${RKEY}/`])
		expect(warmPrefixes).toEqual([`${DID}/${RKEY}/`, `${DID}/${RKEY}/`])
	})

	test('TieredStorage upper-cache failures also retain the replay cursor for retry', async () => {
		const failure = new Error('hot tier unavailable')
		let attempts = 0
		const dependencies: CacheInvalidationDependenciesForTests = {
			storage: {
				async invalidateUpperCaches() {
					attempts++
					return attempts === 1
						? { hotDeleted: 0, warmDeleted: 2, failures: [{ tier: 'hot' as const, reason: failure }] }
						: { hotDeleted: 3, warmDeleted: 2, failures: [] }
				},
			},
			cache: fakeCache,
			resetSiteHtmlHotCacheWarmup(did: string, rkey: string): void {
				htmlWarmupResets.push([did, rkey])
			},
		}
		const event = siteMessage('update', { streamId: '3-0' })

		await expect(applyCacheInvalidationForTests(event, 'replay', dependencies)).rejects.toThrow(
			'Failed to invalidate file caches',
		)
		expect(getLastProcessedStreamIdForTests()).toBe('0-0')

		await applyCacheInvalidationForTests(event, 'replay', dependencies)
		expect(attempts).toBe(2)
		expect(getLastProcessedStreamIdForTests()).toBe('3-0')
	})

	test('tier failure retains a matching updating marker until the retry succeeds', async () => {
		markSiteUpdating(DID, RKEY, 'token-a', '3-0')
		hotFailuresRemaining = 1
		const event = siteMessage('update', { token: 'token-a', streamId: '3-0' })

		await expect(applyForTest(event, 'replay')).rejects.toThrow('Failed to invalidate file caches')
		expect(isSiteUpdating(DID, RKEY)).toBe(true)
		expect(getLastProcessedStreamIdForTests()).toBe('0-0')

		await applyForTest(event, 'replay')
		expect(isSiteUpdating(DID, RKEY)).toBe(false)
		expect(getLastProcessedStreamIdForTests()).toBe('3-0')
	})
})

describe('cache invalidation message parsing', () => {
	test('message parsing preserves token', () => {
		expect(
			parseCacheInvalidationMessage(JSON.stringify({ did: DID, rkey: RKEY, action: 'update', token: 'token-a' })),
		).toEqual({
			did: DID,
			rkey: RKEY,
			action: 'update',
			token: 'token-a',
		})
	})

	test('message parsing preserves stream id', () => {
		expect(
			parseCacheInvalidationMessage(
				JSON.stringify({ did: DID, rkey: RKEY, action: 'update', token: 'token-a', streamId: '1713811200000-2' }),
			),
		).toEqual({
			did: DID,
			rkey: RKEY,
			action: 'update',
			token: 'token-a',
			streamId: '1713811200000-2',
		})
	})

	test('stream entry parsing reconstructs invalidation messages', () => {
		expect(
			parseCacheInvalidationStreamEntry('1713811200000-5', [
				'did',
				DID,
				'rkey',
				RKEY,
				'action',
				'updating',
				'token',
				'token-a',
				'ts',
				'1713811200000',
			]),
		).toEqual({
			did: DID,
			rkey: RKEY,
			action: 'updating',
			token: 'token-a',
			streamId: '1713811200000-5',
		})
	})

	test('domain invalidation message parsing preserves domain keys', () => {
		expect(
			parseCacheInvalidationMessage(
				JSON.stringify({
					action: 'domain',
					domain: 'example.wisp.place',
					domainKind: 'wisp',
					streamId: '1713811200000-6',
				}),
			),
		).toEqual({
			action: 'domain',
			domain: 'example.wisp.place',
			domainKind: 'wisp',
			streamId: '1713811200000-6',
		})
	})

	test('domain stream entry parsing reconstructs domain invalidation messages', () => {
		expect(
			parseCacheInvalidationStreamEntry('1713811200000-7', [
				'action',
				'domain',
				'domain',
				'example.com',
				'domainKind',
				'custom',
				'customDomainId',
				'abc123',
				'ts',
				'1713811200000',
			]),
		).toEqual({
			action: 'domain',
			domain: 'example.com',
			domainKind: 'custom',
			customDomainId: 'abc123',
			streamId: '1713811200000-7',
		})
	})

	test('stream ids sort by timestamp and sequence', () => {
		expect(compareStreamIds('1713811200000-1', '1713811200000-2')).toBeLessThan(0)
		expect(compareStreamIds('1713811200001-0', '1713811200000-999')).toBeGreaterThan(0)
		expect(compareStreamIds('1713811200001-3', '1713811200001-3')).toBe(0)
	})
})

describe('cache invalidation replay health', () => {
	test('stopping disconnects a blocking replay read promptly', async () => {
		process.env.REDIS_URL = 'redis://cache-invalidation-test'
		startCacheInvalidationSubscriberForTests(
			(redisUrl, options) => new FakeRedis(redisUrl, options) as unknown as Redis,
		)
		await flushAsyncWork()

		expect(redisClients).toHaveLength(2)
		const [subscriber, replay] = redisClients
		expect(replay?.xreadArguments).toHaveLength(1)
		expect(replay?.options?.blockingTimeout).toEqual(expect.any(Number))
		expect(replay?.options?.socketTimeout as number).toBeGreaterThan(replay?.options?.blockingTimeout as number)

		await stopCacheInvalidationSubscriber()

		expect(subscriber?.disconnected).toBe(true)
		expect(replay?.disconnected).toBe(true)
		expect(getCacheInvalidationHealthSnapshot()).toMatchObject({
			subscriberConnected: false,
			replayConnected: false,
			replayState: 'stopped',
			retrying: false,
		})
	})

	test('recovers a retained-stream gap by clearing local state before replaying from zero', async () => {
		process.env.REDIS_URL = 'redis://cache-invalidation-test'
		xinfoFirstEntryId = '2-0'
		await writeFile(cursorFile, '1-0\n')
		markSiteUpdating(DID, RKEY, 'stale-update', '1-0')
		const recoveryOrder: string[] = []
		const replayRead = waitForReplayRead()
		const recovery: CacheInvalidationGapRecoveryDependencies = {
			clearMutableCaches() {
				recoveryOrder.push('cache-manager')
			},
			clearUpdatingAndTerminalState() {
				recoveryOrder.push('site-state')
				resetUpdatingSitesForTests()
			},
			resetHtmlPrewarmState() {
				recoveryOrder.push('html-prewarm')
			},
			async evictHotTier() {
				recoveryOrder.push('hot-tier')
			},
			async validateWarmCacheSourceCids() {
				recoveryOrder.push('warm-cid-validation')
			},
		}

		startCacheInvalidationSubscriberForTests(
			(redisUrl, options) => new FakeRedis(redisUrl, options) as unknown as Redis,
			recovery,
		)
		await replayRead

		expect(recoveryOrder).toEqual(['cache-manager', 'site-state', 'html-prewarm', 'hot-tier', 'warm-cid-validation'])
		expect(isSiteUpdating(DID, RKEY)).toBe(false)
		expect(getLastProcessedStreamIdForTests()).toBe('0-0')
		expect(await readFile(cursorFile, 'utf8')).toBe('0-0\n')
		const replayReadArguments = redisClients[1]?.xreadArguments[0] ?? []
		expect(replayReadArguments[replayReadArguments.length - 1]).toBe('0-0')

		const health = getCacheInvalidationHealthSnapshot()
		expect(health.replayState).toBe('starting')
		expect(health.gapCount).toBe(1)
		expect(health.lastGapAt).not.toBeNull()
		expect(health.lastGapRecoveryAt).not.toBeNull()
		expect(health.lastErrorAt).not.toBeNull()

		await stopCacheInvalidationSubscriber()
	})

	test('retries malformed XINFO without clearing state or resetting the cursor', async () => {
		process.env.REDIS_URL = 'redis://cache-invalidation-test'
		xinfoResponse = ['first-entry', ['not-a-stream-id', []]]
		await writeFile(cursorFile, '1-0\n')
		const recoveryOrder: string[] = []

		startCacheInvalidationSubscriberForTests(
			(redisUrl, options) => new FakeRedis(redisUrl, options) as unknown as Redis,
			{
				clearMutableCaches: () => {
					recoveryOrder.push('cache-manager')
				},
			},
		)
		await flushAsyncWork()

		expect(recoveryOrder).toEqual([])
		expect(getLastProcessedStreamIdForTests()).toBe('1-0')
		expect(redisClients[1]?.xreadArguments).toEqual([])
		expect(getCacheInvalidationHealthSnapshot()).toMatchObject({
			replayState: 'degraded',
			gapCount: 0,
			lastGapAt: null,
			lastGapRecoveryAt: null,
			retrying: true,
		})

		await stopCacheInvalidationSubscriber()
	})

	test('retries an XINFO Redis error without clearing state or resetting the cursor', async () => {
		process.env.REDIS_URL = 'redis://cache-invalidation-test'
		xinfoError = new Error('Redis temporarily unavailable')
		await writeFile(cursorFile, '1-0\n')
		const recoveryOrder: string[] = []

		startCacheInvalidationSubscriberForTests(
			(redisUrl, options) => new FakeRedis(redisUrl, options) as unknown as Redis,
			{
				clearMutableCaches: () => {
					recoveryOrder.push('cache-manager')
				},
			},
		)
		await flushAsyncWork()

		expect(recoveryOrder).toEqual([])
		expect(getLastProcessedStreamIdForTests()).toBe('1-0')
		expect(redisClients[1]?.xreadArguments).toEqual([])
		expect(getCacheInvalidationHealthSnapshot()).toMatchObject({
			replayState: 'degraded',
			gapCount: 0,
			lastGapAt: null,
			lastGapRecoveryAt: null,
			retrying: true,
		})

		await stopCacheInvalidationSubscriber()
	})
})

describe('cache invalidation subscriber heartbeat', () => {
	async function startHeartbeatSubscriber(scheduler: FakeHeartbeatScheduler): Promise<FakeRedis> {
		process.env.REDIS_URL = 'redis://cache-invalidation-test'
		startCacheInvalidationSubscriberForTests(
			(redisUrl, options) => new FakeRedis(redisUrl, options) as unknown as Redis,
			undefined,
			{ scheduleInterval: scheduler.schedule },
		)
		// Park the replay loop in its blocking read before any lifecycle changes,
		// matching the rhythm of the replay-health tests above.
		await flushAsyncWork()
		const subscriberClient = redisClients[0]
		if (!subscriberClient) throw new Error('subscriber client was not created')
		return subscriberClient
	}

	test('requests the 60 second production keepalive interval', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		subscriberClient.emit('ready')

		expect(scheduler.requestedIntervalMs).toEqual([60_000])
		expect(subscriberClient.pingCount).toBe(0)

		await stopCacheInvalidationSubscriber()
	})

	test('pings the subscriber on each heartbeat interval tick while connected', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		subscriberClient.emit('ready')

		scheduler.fireActiveTicks()
		expect(subscriberClient.pingCount).toBe(1)
		scheduler.fireActiveTicks()
		expect(subscriberClient.pingCount).toBe(2)
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(true)

		await stopCacheInvalidationSubscriber()
	})

	test('repeated ready events replace the heartbeat interval instead of stacking', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		subscriberClient.emit('ready')
		subscriberClient.emit('ready')
		subscriberClient.emit('ready')

		expect(scheduler.requestedIntervalMs).toEqual([60_000, 60_000, 60_000])
		expect(scheduler.cancelledCount).toBe(2)
		expect(scheduler.activeCount).toBe(1)
		scheduler.fireActiveTicks()
		expect(subscriberClient.pingCount).toBe(1)
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(true)

		await stopCacheInvalidationSubscriber()
	})

	test('heartbeat stops on close/end and restarts on reconnect ready', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		subscriberClient.emit('ready')
		scheduler.fireActiveTicks()
		scheduler.fireActiveTicks()
		expect(subscriberClient.pingCount).toBe(2)

		subscriberClient.emit('close')
		scheduler.fireActiveTicks()
		expect(subscriberClient.pingCount).toBe(2)
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(false)

		subscriberClient.emit('ready')
		scheduler.fireActiveTicks()
		scheduler.fireActiveTicks()
		expect(subscriberClient.pingCount).toBe(4)
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(true)

		subscriberClient.emit('end')
		scheduler.fireActiveTicks()
		expect(subscriberClient.pingCount).toBe(4)
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(false)

		await stopCacheInvalidationSubscriber()
	})

	test('a failed keepalive ping recreates the wedged subscriber and fences stale clients', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		subscriberClient.emit('ready')
		scheduler.fireActiveTicks()
		expect(subscriberClient.pingCount).toBe(1)

		subscriberClient.pingError = new Error('subscriber keepalive failed')
		scheduler.fireActiveTicks()
		await flushAsyncWork()

		expect(getCacheInvalidationHealthSnapshot().lastErrorAt).not.toBeNull()
		expect(getCacheInvalidationHealthSnapshot().subscriberRecreations).toBe(1)
		expect(subscriberClient.disconnected).toBe(true)
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(false)

		// The replacement client restores health on ready + SUBSCRIBE ack, and
		// the heartbeat continues against the new client.
		const replacement = redisClients[2]
		if (!replacement) throw new Error('replacement subscriber was not created')
		replacement.emit('ready')
		scheduler.fireActiveTicks()
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(true)
		expect(replacement.pingCount).toBe(1)

		// A stale client's late events are generation-fenced: a close from the
		// old client cannot flip the new client's health.
		subscriberClient.emit('close')
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(true)

		await stopCacheInvalidationSubscriber()
	})

	test('autoResubscribe is disabled so each ready issues its own acked SUBSCRIBE', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		expect(subscriberClient.options?.autoResubscribe).toBe(false)

		subscriberClient.emit('ready')
		subscriberClient.emit('ready')
		expect(subscriberClient.subscribeCalls).toEqual(['wisp:cache-invalidate', 'wisp:cache-invalidate'])
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(true)

		await stopCacheInvalidationSubscriber()
	})

	test('ready alone is not connected until the SUBSCRIBE ack arrives', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		subscriberClient.deferredSubscribeAck = true
		subscriberClient.emit('ready')

		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(false)

		subscriberClient.ackSubscribe()
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(true)

		await stopCacheInvalidationSubscriber()
	})

	test('a failed SUBSCRIBE ack leaves the subscriber unconnected and records an error', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		subscriberClient.subscribeError = new Error('NOPERM denied')
		subscriberClient.emit('ready')

		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(false)
		expect(getCacheInvalidationHealthSnapshot().lastErrorAt).not.toBeNull()

		await stopCacheInvalidationSubscriber()
	})

	test('supervisor recreates a subscriber that stays ready without a SUBSCRIBE ack', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const supervisorScheduler = new FakeHeartbeatScheduler()
		process.env.REDIS_URL = 'redis://cache-invalidation-test'
		startCacheInvalidationSubscriberForTests(
			(redisUrl, options) => new FakeRedis(redisUrl, options) as unknown as Redis,
			undefined,
			{ scheduleInterval: scheduler.schedule },
			{ scheduleInterval: supervisorScheduler.schedule, recreateAfterMs: 1 },
		)
		await flushAsyncWork()
		const subscriberClient = redisClients[0]
		if (!subscriberClient) throw new Error('subscriber client was not created')
		subscriberClient.deferredSubscribeAck = true
		subscriberClient.emit('ready')

		// recreateAfterMs=1: the first supervisor tick records the unhealthy
		// start; a tick after the bound recreates the client.
		supervisorScheduler.fireActiveTicks()
		await new Promise((resolve) => setTimeout(resolve, 2))
		supervisorScheduler.fireActiveTicks()
		await flushAsyncWork()
		expect(getCacheInvalidationHealthSnapshot().subscriberRecreations).toBe(1)
		expect(subscriberClient.disconnected).toBe(true)

		const replacement = redisClients[2]
		if (!replacement) throw new Error('replacement subscriber was not created')
		replacement.emit('ready')
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(true)

		await stopCacheInvalidationSubscriber()
	})

	test('start-once: a repeated full start is ignored and creates no duplicate clients', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		startCacheInvalidationSubscriberForTests(
			(redisUrl, options) => new FakeRedis(redisUrl, options) as unknown as Redis,
			undefined,
			{ scheduleInterval: scheduler.schedule },
		)
		await flushAsyncWork()
		expect(redisClients).toHaveLength(2)

		subscriberClient.emit('ready')
		expect(getCacheInvalidationHealthSnapshot().subscriberConnected).toBe(true)
		await stopCacheInvalidationSubscriber()
	})

	test('stop-once: concurrent stops share one idempotent teardown', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		subscriberClient.emit('ready')

		const [first, second] = [stopCacheInvalidationSubscriber(), stopCacheInvalidationSubscriber()]
		await Promise.all([first, second])
		await stopCacheInvalidationSubscriber()

		expect(subscriberClient.disconnected).toBe(true)
		expect(redisClients[1]?.disconnected).toBe(true)
		expect(getCacheInvalidationHealthSnapshot()).toMatchObject({
			subscriberConnected: false,
			replayConnected: false,
			replayState: 'stopped',
		})
	})

	test('stopping the subscriber cancels the heartbeat so no further pings fire', async () => {
		const scheduler = new FakeHeartbeatScheduler()
		const subscriberClient = await startHeartbeatSubscriber(scheduler)
		subscriberClient.emit('ready')
		scheduler.fireActiveTicks()
		expect(subscriberClient.pingCount).toBe(1)

		await stopCacheInvalidationSubscriber()
		scheduler.fireActiveTicks()

		expect(subscriberClient.pingCount).toBe(1)
		expect(scheduler.activeCount).toBe(0)
		expect(subscriberClient.disconnected).toBe(true)
		expect(redisClients[1]?.disconnected).toBe(true)
		expect(getCacheInvalidationHealthSnapshot()).toMatchObject({
			subscriberConnected: false,
			replayConnected: false,
			replayState: 'stopped',
		})
	})
})
