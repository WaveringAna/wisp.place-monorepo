import { afterEach, describe, expect, test } from 'bun:test'
import type { Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import type Redis from 'ioredis'
import { AuthoritativeSettingsRecordError, type SettingsUpdateOptions, SiteBlobBackoffError } from './cache-writer'
import {
	SETTINGS_DELETE_FAILURE_REASON,
	SETTINGS_UPDATE_FAILURE_REASON,
	SITE_DELETE_TOMBSTONE_REASON,
} from './revalidate-queue'
import { createRevalidationResourceContext } from './revalidate-resources'
import {
	createRevalidateWorkerRedisOptions,
	getRevalidateWorkerStateForTests,
	processRevalidationMessage,
	type RevalidateRedisClient,
	type RevalidateWorkerDependencies,
	type RevalidateWorkerRedisFactory,
	type RevalidateWorkerRedisOptions,
	type RevalidateWorkerRuntimeConfig,
	resolveRevalidateWorkerRuntimeConfig,
	scanStaleRevalidationMessagesForTests,
	shouldSkipInvalidationForReason,
	startRevalidateWorkerForTests,
	stopRevalidateWorker,
	trimDrainedRevalidationEntries,
} from './revalidate-worker'

const DID = 'did:plc:test'
const RKEY = 'site'
const MESSAGE_ID = '1-0'

function messageFields(reason: string): string[] {
	return ['did', DID, 'rkey', RKEY, 'reason', reason]
}

function createRedis(
	ttl = -1,
	completionOutcome: [number, number] | Error = [1, 1],
): {
	redis: RevalidateRedisClient
	acks: string[]
	streamDeletes: string[]
	calls: string[]
	sets: Array<[string, string, 'EX', number]>
} {
	const acks: string[] = []
	const streamDeletes: string[] = []
	const calls: string[] = []
	const sets: Array<[string, string, 'EX', number]> = []

	return {
		redis: {
			async ttl() {
				return ttl
			},
			async eval(_script, keyCount, ...args) {
				const id = args[keyCount + 1] as string
				calls.push(`eval-complete:${id}`)
				if (completionOutcome instanceof Error) throw completionOutcome
				if (completionOutcome[0] === 1) acks.push(id)
				if (completionOutcome[0] === 1 && completionOutcome[1] === 1) streamDeletes.push(id)
				return completionOutcome
			},
			async set(key, value, expirationMode, ttlSeconds) {
				sets.push([key, value, expirationMode, ttlSeconds])
				return 'OK'
			},
		},
		acks,
		streamDeletes,
		calls,
		sets,
	}
}

function createDependencies(overrides: Partial<RevalidateWorkerDependencies> = {}): RevalidateWorkerDependencies {
	return {
		fetchSettingsRecord: async () => null,
		fetchSiteRecord: async () => null,
		handleSettingsDelete: async () => undefined,
		handleSettingsUpdate: async () => undefined,
		handleSiteCreateOrUpdate: async () => undefined,
		handleSiteDelete: async () => undefined,
		...overrides,
	}
}

const reappearedRecord: WispFsRecord = {
	$type: 'place.wisp.fs',
	site: RKEY,
	root: { type: 'directory', entries: [] },
	createdAt: '2024-01-01T00:00:00.000Z',
}

const reappearedSettings: WispSettings = {
	$type: 'place.wisp.settings',
	directoryListing: false,
	cleanUrls: true,
}

async function runSettingsReconciliationForTest(
	options: SettingsUpdateOptions | undefined,
	onPresent: (record: WispSettings, cid: string) => void,
	onAbsent: () => void,
): Promise<void> {
	const outcome = await options?.fetchSettingsRecordOutcome?.(DID, RKEY, undefined, options.resources)
	if (!outcome) throw new Error('Expected the locked settings lookup seam')
	if (outcome.kind === 'retryable') throw new AuthoritativeSettingsRecordError(outcome.error)
	if (outcome.kind === 'present') onPresent(outcome.record, outcome.cid)
	else onAbsent()
}

async function flushAsyncWork(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve()
	}
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

class FakeLifecycleRedis {
	readonly xreadArguments: unknown[][] = []
	claimCalls = 0
	evalCalls = 0
	disconnected = false
	private rejectPendingRead: ((reason?: unknown) => void) | null = null

	constructor(
		readonly options: RevalidateWorkerRedisOptions,
		private readonly xgroupFailure?: Error,
		private readonly xautoclaimFailure?: Error,
	) {}

	on(_event: string, _listener: (..._args: unknown[]) => void): this {
		return this
	}

	async xgroup(..._args: unknown[]): Promise<unknown> {
		if (this.xgroupFailure) throw this.xgroupFailure
		return 'OK'
	}

	async xautoclaim(..._args: unknown[]): Promise<unknown> {
		this.claimCalls++
		if (this.xautoclaimFailure) throw this.xautoclaimFailure
		return ['0-0', []]
	}

	async ttl(_key: string): Promise<number> {
		return -1
	}

	async eval(..._args: unknown[]): Promise<unknown> {
		this.evalCalls++
		return [1, 1]
	}

	xreadgroup(...args: unknown[]): Promise<null | [string, Array<[string, string[]]>][]> {
		this.xreadArguments.push(args)
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

class FakeHealthyThenFailureRedis extends FakeLifecycleRedis {
	override async xautoclaim(..._args: unknown[]): Promise<unknown> {
		this.claimCalls++
		if (this.claimCalls === 1) return ['0-0', []]
		throw new Error('connection failed after healthy read')
	}

	override xreadgroup(...args: unknown[]): Promise<null> {
		this.xreadArguments.push(args)
		return Promise.resolve(null)
	}

	override async eval(..._args: unknown[]): Promise<number> {
		return 0
	}
}

class FakeMessageRedis extends FakeLifecycleRedis {
	override xreadgroup(...args: unknown[]): Promise<[string, Array<[string, string[]]>][]> {
		this.xreadArguments.push(args)
		return Promise.resolve([['wisp:revalidate', [['1-0', messageFields(SITE_DELETE_TOMBSTONE_REASON)]]]])
	}
}

function lifecycleFactory(
	clients: FakeLifecycleRedis[],
	options: { xgroupFailure?: Error; xautoclaimFailure?: Error } = {},
): RevalidateWorkerRedisFactory {
	return (_redisUrl, redisOptions) => {
		const client = new FakeLifecycleRedis(redisOptions, options.xgroupFailure, options.xautoclaimFailure)
		clients.push(client)
		return client as unknown as Redis
	}
}

interface FakePipeline {
	ttl(key: string): FakePipeline
	exec(): Promise<unknown>
}

class FakeClaimRedis {
	readonly calls: Array<{ command: string; args: unknown[] }> = []
	readonly deliveryCounts = new Map<string, number>()
	readonly quarantineAttempts: number[] = []
	readonly ids: string[]
	readonly id: string
	readonly fields: string[]
	readonly retryTtlOverrides = new Map<string, number>()
	private pending = true
	retryTtlSeconds = 0
	siteBackoffTtlSeconds = -1
	pipelineResultOverride: unknown = undefined

	constructor(id: string | readonly string[], fields: string[]) {
		this.ids = typeof id === 'string' ? [id] : [...id]
		const firstId = this.ids[0]
		if (!firstId) throw new Error('FakeClaimRedis needs at least one ID')
		this.id = firstId
		this.fields = fields
	}

	private ttlForKey(key: string): number {
		if (key.startsWith('revalidate:retry:')) {
			const id = key.slice('revalidate:retry:'.length)
			return this.retryTtlOverrides.get(id) ?? this.retryTtlSeconds
		}
		if (key.startsWith('revalidate:site:failure-backoff:')) return this.siteBackoffTtlSeconds
		return -1
	}

	async ttl(key: string): Promise<number> {
		this.calls.push({ command: 'TTL', args: [key] })
		return this.ttlForKey(key)
	}

	pipeline(): FakePipeline {
		const keys: string[] = []
		const pipeline: FakePipeline = {
			ttl: (key) => {
				keys.push(key)
				return pipeline
			},
			exec: async () => {
				this.calls.push({ command: 'PIPELINE_EXEC', args: [...keys] })
				return this.pipelineResultOverride ?? keys.map((key) => [null, this.ttlForKey(key)])
			},
		}
		return pipeline
	}

	async xautoclaim(...args: unknown[]): Promise<unknown> {
		this.calls.push({ command: 'XAUTOCLAIM', args })
		return ['0-0', this.pending ? this.ids : [], []]
	}

	async xclaim(...args: unknown[]): Promise<unknown> {
		this.calls.push({ command: 'XCLAIM', args })
		const ids = args.slice(4).filter((value): value is string => typeof value === 'string')
		return ids
			.filter((id) => this.ids.includes(id) && this.pending)
			.map((id) => {
				this.deliveryCounts.set(id, (this.deliveryCounts.get(id) ?? 0) + 1)
				return [id, this.fields]
			})
	}

	async xpending(...args: unknown[]): Promise<unknown> {
		this.calls.push({ command: 'XPENDING', args })
		const id = String(args[2])
		return [[id, 'consumer', 0, this.deliveryCounts.get(id) ?? 0]]
	}

	async set(key: string, _value: string, _mode: 'EX', ttlSeconds: number): Promise<'OK'> {
		this.calls.push({ command: 'SET', args: [key, ttlSeconds] })
		if (key === `revalidate:retry:${this.id}`) this.retryTtlSeconds = ttlSeconds
		else if (key.startsWith('revalidate:retry:'))
			this.retryTtlOverrides.set(key.slice('revalidate:retry:'.length), ttlSeconds)
		else if (key.startsWith('revalidate:site:failure-backoff:')) this.siteBackoffTtlSeconds = ttlSeconds
		return 'OK'
	}

	async eval(_script: string, keyCount: number, ...args: string[]): Promise<unknown> {
		this.calls.push({ command: 'EVAL', args: [keyCount, ...args] })
		if (keyCount === 4) {
			this.quarantineAttempts.push(Number(args[4 + 7]))
			this.pending = false
			return [1, 'dlq-1', 1]
		}
		this.pending = false
		return [1, 1]
	}
}

afterEach(async () => {
	await stopRevalidateWorker()
})

describe('shouldSkipInvalidationForReason', () => {
	test('skips invalidation for rewrite repair jobs', () => {
		expect(shouldSkipInvalidationForReason('rewrite-miss:docs/w/~/index.html')).toBe(true)
	})

	test('does not skip invalidation for storage misses', () => {
		expect(shouldSkipInvalidationForReason('storage-miss:docs/raw/README.md')).toBe(false)
	})

	test('does not skip invalidation for other revalidate reasons', () => {
		expect(shouldSkipInvalidationForReason('manual')).toBe(false)
	})
})

describe('delete tombstone revalidation', () => {
	test('deletes a missing PDS record and ACKs only after delete succeeds', async () => {
		const { redis, acks, streamDeletes } = createRedis(60)
		const deletes: Array<[string, string]> = []
		const dependencies = createDependencies({
			handleSiteDelete: async (did, rkey) => {
				deletes.push([did, rkey])
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields(SITE_DELETE_TOMBSTONE_REASON), redis, dependencies)

		expect(deletes).toEqual([[DID, RKEY]])
		expect(acks).toEqual([MESSAGE_ID])
		expect(streamDeletes).toEqual([MESSAGE_ID])
	})

	test('fully materializes a reappeared PDS record instead of deleting it', async () => {
		const { redis, acks, streamDeletes } = createRedis()
		const deletes: Array<[string, string]> = []
		const updates: Array<{ did: string; rkey: string; cid: string; forceDownload?: boolean }> = []
		const dependencies = createDependencies({
			fetchSiteRecord: async () => ({ record: reappearedRecord, cid: 'new-cid' }),
			handleSiteCreateOrUpdate: async (did, rkey, _record, cid, options) => {
				updates.push({ did, rkey, cid, forceDownload: options?.forceDownload })
			},
			handleSiteDelete: async (did, rkey) => {
				deletes.push([did, rkey])
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields(SITE_DELETE_TOMBSTONE_REASON), redis, dependencies)

		expect(updates).toEqual([{ did: DID, rkey: RKEY, cid: 'new-cid', forceDownload: true }])
		expect(deletes).toEqual([])
		expect(acks).toEqual([MESSAGE_ID])
		expect(streamDeletes).toEqual([MESSAGE_ID])
	})

	test('leaves a tombstone pending when delete cleanup has a transient failure', async () => {
		const { redis, acks, streamDeletes } = createRedis()
		const dependencies = createDependencies({
			handleSiteDelete: async () => {
				throw new Error('database temporarily unavailable')
			},
		})

		await expect(
			processRevalidationMessage(MESSAGE_ID, messageFields(SITE_DELETE_TOMBSTONE_REASON), redis, dependencies),
		).rejects.toThrow('database temporarily unavailable')

		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
	})

	test('aborts a blocked PDS fetch without acknowledging or retrying the pending entry', async () => {
		const { redis, acks, streamDeletes, sets, calls } = createRedis()
		const controller = new AbortController()
		const fetchStarted = deferred<void>()
		const dependencies = createDependencies({
			fetchSiteRecord: async (_did, _rkey, resources) => {
				fetchStarted.resolve()
				await new Promise<void>((resolve) =>
					resources?.signal.addEventListener('abort', () => resolve(), { once: true }),
				)
				throw resources?.signal.reason instanceof Error ? resources.signal.reason : new Error('aborted')
			},
		})
		const processing = processRevalidationMessage(
			MESSAGE_ID,
			messageFields(SITE_DELETE_TOMBSTONE_REASON),
			redis,
			dependencies,
			{ upstreamSignal: controller.signal, enforceAttemptPolicy: true },
		)

		await fetchStarted.promise
		controller.abort()
		await processing

		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
		expect(sets).toEqual([])
		expect(calls).toEqual([])
	})

	test('aborts a blocked blob operation without acknowledging or retrying the pending entry', async () => {
		const { redis, acks, streamDeletes, sets, calls } = createRedis()
		const controller = new AbortController()
		const materializationStarted = deferred<void>()
		const dependencies = createDependencies({
			fetchSiteRecord: async () => ({ record: reappearedRecord, cid: 'new-cid' }),
			handleSiteCreateOrUpdate: async (_did, _rkey, _record, _cid, options) => {
				materializationStarted.resolve()
				await new Promise<void>((resolve) =>
					options?.resources?.signal.addEventListener('abort', () => resolve(), { once: true }),
				)
				throw options?.resources?.signal.reason instanceof Error
					? options.resources.signal.reason
					: new Error('aborted')
			},
		})
		const processing = processRevalidationMessage(
			MESSAGE_ID,
			messageFields(SITE_DELETE_TOMBSTONE_REASON),
			redis,
			dependencies,
			{ upstreamSignal: controller.signal, enforceAttemptPolicy: true },
		)

		await materializationStarted.promise
		controller.abort()
		await processing

		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
		expect(sets).toEqual([])
		expect(calls).toEqual([])
	})

	test('treats a supplied resource deadline as a retryable failure, not lifecycle cancellation', async () => {
		const { redis, acks, streamDeletes, sets } = createRedis()
		const resources = createRevalidationResourceContext(1, 1024)
		const dependencies = createDependencies({
			fetchSiteRecord: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5))
				return { record: reappearedRecord, cid: 'new-cid' }
			},
		})

		try {
			await processRevalidationMessage(MESSAGE_ID, messageFields(SITE_DELETE_TOMBSTONE_REASON), redis, dependencies, {
				resourceContext: resources,
				deliveryAttempt: 1,
				enforceAttemptPolicy: true,
			})
		} finally {
			resources.close()
		}

		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
		expect(sets.map(([key]) => key)).toEqual([`revalidate:retry:${MESSAGE_ID}`])
	})

	test('keeps a reappeared tombstone pending while a blob backoff is active', async () => {
		const { redis, acks, streamDeletes } = createRedis(60)
		let updates = 0
		const dependencies = createDependencies({
			fetchSiteRecord: async () => ({ record: reappearedRecord, cid: 'new-cid' }),
			handleSiteCreateOrUpdate: async () => {
				updates++
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields(SITE_DELETE_TOMBSTONE_REASON), redis, dependencies)

		expect(updates).toBe(0)
		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
	})

	test('keeps a tombstone pending when its replacement record hits blob backoff', async () => {
		const { redis, acks, sets, streamDeletes } = createRedis()
		const dependencies = createDependencies({
			fetchSiteRecord: async () => ({ record: reappearedRecord, cid: 'new-cid' }),
			handleSiteCreateOrUpdate: async () => {
				throw new SiteBlobBackoffError(DID, RKEY, Date.now() + 60_000, 1)
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields(SITE_DELETE_TOMBSTONE_REASON), redis, dependencies)

		expect(sets).toHaveLength(2)
		expect(sets.map(([key]) => key)).toEqual([
			`revalidate:site:failure-backoff:${DID}:${RKEY}`,
			`revalidate:retry:${MESSAGE_ID}`,
		])
		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
	})
})

describe('settings failure revalidation', () => {
	test('applies a current settings record after a failed settings update', async () => {
		const { redis, acks, streamDeletes } = createRedis(60)
		const updates: Array<{ did: string; rkey: string; cid: string; settings: WispSettings }> = []
		let lookups = 0
		let deletes = 0
		const dependencies = createDependencies({
			fetchSettingsRecord: async () => {
				lookups++
				return { record: reappearedSettings, cid: 'settings-cid' }
			},
			handleSettingsUpdate: async (did, rkey, _settings, _cid, options) => {
				await runSettingsReconciliationForTest(
					options,
					(settings, cid) => {
						updates.push({ did, rkey, settings, cid })
					},
					() => {
						deletes++
					},
				)
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields(SETTINGS_UPDATE_FAILURE_REASON), redis, dependencies)

		expect(lookups).toBe(1)
		expect(updates).toEqual([{ did: DID, rkey: RKEY, settings: reappearedSettings, cid: 'settings-cid' }])
		expect(deletes).toBe(0)
		expect(acks).toEqual([MESSAGE_ID])
		expect(streamDeletes).toEqual([MESSAGE_ID])
	})

	test('keeps settings pending for transient, invalid, or missing-CID PDS outcomes', async () => {
		const { redis, acks, streamDeletes } = createRedis()
		let deletes = 0
		const dependencies = createDependencies({
			fetchSettingsRecordOutcome: async () => ({ kind: 'retryable', error: 'MISSING_CID' }),
			handleSettingsDelete: async (_did, _rkey, _dependencies, _resources, options) => {
				await runSettingsReconciliationForTest(
					options,
					() => undefined,
					() => {
						deletes++
					},
				)
			},
		})
		await processRevalidationMessage(MESSAGE_ID, messageFields(SETTINGS_DELETE_FAILURE_REASON), redis, dependencies)
		expect(deletes).toBe(0)
		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
	})

	test('applies an idempotent settings delete after a failed delete remains absent', async () => {
		const { redis, acks, streamDeletes } = createRedis()
		const deletes: Array<[string, string]> = []
		const dependencies = createDependencies({
			fetchSettingsRecordOutcome: async () => ({ kind: 'absent' }),
			handleSettingsDelete: async (did, rkey, _dependencies, _resources, options) => {
				await runSettingsReconciliationForTest(
					options,
					() => undefined,
					() => {
						deletes.push([did, rkey])
					},
				)
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields(SETTINGS_DELETE_FAILURE_REASON), redis, dependencies)

		expect(deletes).toEqual([[DID, RKEY]])
		expect(acks).toEqual([MESSAGE_ID])
		expect(streamDeletes).toEqual([MESSAGE_ID])
	})

	test('restores a reappeared settings record instead of deleting it for an old failed delete', async () => {
		const { redis, acks, streamDeletes } = createRedis()
		let updates = 0
		let deletes = 0
		const dependencies = createDependencies({
			fetchSettingsRecord: async () => ({ record: reappearedSettings, cid: 'settings-cid' }),
			handleSettingsDelete: async (_did, _rkey, _dependencies, _resources, options) => {
				await runSettingsReconciliationForTest(
					options,
					() => {
						updates++
					},
					() => {
						deletes++
					},
				)
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields(SETTINGS_DELETE_FAILURE_REASON), redis, dependencies)

		expect(updates).toBe(1)
		expect(deletes).toBe(0)
		expect(acks).toEqual([MESSAGE_ID])
		expect(streamDeletes).toEqual([MESSAGE_ID])
	})

	test('leaves settings failures pending when reconciliation fails', async () => {
		const { redis, acks, streamDeletes } = createRedis()
		const dependencies = createDependencies({
			fetchSettingsRecord: async () => ({ record: reappearedSettings, cid: 'settings-cid' }),
			handleSettingsUpdate: async () => {
				throw new Error('settings database temporarily unavailable')
			},
		})

		await expect(
			processRevalidationMessage(MESSAGE_ID, messageFields(SETTINGS_UPDATE_FAILURE_REASON), redis, dependencies),
		).rejects.toThrow('settings database temporarily unavailable')

		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
	})
})

describe('ordinary revalidation', () => {
	test('uses no aggregate deadline or transfer cap for filesystem repair', async () => {
		const { redis, acks } = createRedis()
		let observedResources: Parameters<RevalidateWorkerDependencies['handleSiteCreateOrUpdate']>[4] extends infer Options
			? Options
			: never
		const dependencies = createDependencies({
			fetchSiteRecord: async () => ({ record: reappearedRecord, cid: 'cid' }),
			handleSiteCreateOrUpdate: async (_did, _rkey, _record, _cid, options) => {
				observedResources = options
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields('storage-miss:index.html'), redis, dependencies)

		expect(observedResources?.resources?.deadlineAt).toBeNull()
		expect(observedResources?.resources?.transferBudget.maxBytes).toBe(Number.POSITIVE_INFINITY)
		observedResources?.resources?.transferBudget.consume(1_000_000_000)
		expect(observedResources?.resources?.signal.aborted).toBe(false)
		expect(acks).toEqual([MESSAGE_ID])
	})

	test('acknowledges queued duplicates without repair while a DLQ fence exists', async () => {
		const { redis, acks, streamDeletes } = createRedis()
		;(redis as RevalidateRedisClient).get = async () => 'dlq-9'
		let lookups = 0
		const dependencies = createDependencies({
			fetchSiteRecord: async () => {
				lookups++
				return { record: reappearedRecord, cid: 'cid' }
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields('storage-miss:index.html'), redis, dependencies)

		expect(lookups).toBe(0)
		expect(acks).toEqual([MESSAGE_ID])
		expect(streamDeletes).toEqual([MESSAGE_ID])
	})

	test('leaves transient or invalid typed PDS outcomes pending', async () => {
		const { redis, acks, streamDeletes } = createRedis()
		const dependencies = createDependencies({
			fetchSiteRecordOutcome: async () => ({ kind: 'retryable', error: 'INVALID_RECORD' }),
		})
		await processRevalidationMessage(MESSAGE_ID, messageFields('storage-miss:index.html'), redis, dependencies)
		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
	})

	test('ACKs a missing non-delete record without invoking delete cleanup', async () => {
		const { redis, acks, streamDeletes } = createRedis()
		let deletes = 0
		const dependencies = createDependencies({
			handleSiteDelete: async () => {
				deletes++
			},
		})

		await processRevalidationMessage(MESSAGE_ID, messageFields('storage-miss:index.html'), redis, dependencies)

		expect(deletes).toBe(0)
		expect(acks).toEqual([MESSAGE_ID])
		expect(streamDeletes).toEqual([MESSAGE_ID])
	})

	test('uses one atomic completion command rather than separate ACK and delete calls', async () => {
		const { redis, acks, calls, streamDeletes } = createRedis()
		await processRevalidationMessage(MESSAGE_ID, messageFields('storage-miss:index.html'), redis, createDependencies())
		expect(acks).toEqual([MESSAGE_ID])
		expect(streamDeletes).toEqual([MESSAGE_ID])
		expect(calls).toEqual([`eval-complete:${MESSAGE_ID}`])
	})

	test('leaves an entry pending when atomic completion reports zero ACK', async () => {
		const { redis, acks, calls, streamDeletes } = createRedis(-1, [0, 0])
		await processRevalidationMessage(MESSAGE_ID, messageFields('storage-miss:index.html'), redis, createDependencies())
		expect(acks).toEqual([])
		expect(streamDeletes).toEqual([])
		expect(calls).toEqual([`eval-complete:${MESSAGE_ID}`])
	})

	test('propagates a disconnect-ambiguous completion response without claiming completion', async () => {
		const { redis, calls, streamDeletes } = createRedis(-1, new Error('connection dropped after script write'))
		await expect(
			processRevalidationMessage(MESSAGE_ID, messageFields('storage-miss:index.html'), redis, createDependencies()),
		).rejects.toThrow('connection dropped')
		expect(streamDeletes).toEqual([])
		expect(calls).toEqual([`eval-complete:${MESSAGE_ID}`])
	})

	test('rejects malformed atomic completion replies', async () => {
		const { redis } = createRedis()
		redis.eval = async () => ['bad']
		await expect(
			processRevalidationMessage(MESSAGE_ID, messageFields('storage-miss:index.html'), redis, createDependencies()),
		).rejects.toThrow('malformed')
	})
})

describe('stale revalidation delivery accounting', () => {
	const runtimeConfig: RevalidateWorkerRuntimeConfig = {
		batchSize: 10,
		claimIdleMs: 60_000,
		blockMs: 5_000,
		blockingGraceMs: 1_000,
		socketTimeoutMs: 16_000,
		failureBackoffSeconds: 600,
		reconnectMinMs: 10,
		reconnectMaxMs: 10,
		maxAttempts: 2,
		revalidationDeadlineMs: 5_000,
		transferBudgetBytes: 1_000_000,
		retryBackoffBaseMs: 100,
		retryBackoffMaxMs: 100,
	}

	test('uses JUSTID and does not consume deliveries while retry TTL is active', async () => {
		const id = '900001-0'
		const fake = new FakeClaimRedis(id, messageFields('storage-miss:index.html'))
		const dependencies = createDependencies({
			fetchSiteRecordOutcome: async () => {
				throw new Error('temporary PDS failure')
			},
		})

		await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
		expect(fake.deliveryCounts.get(id)).toBe(1)
		const autoClaimArgs = fake.calls.find((call) => call.command === 'XAUTOCLAIM')?.args ?? []
		expect(autoClaimArgs[autoClaimArgs.length - 1]).toBe('JUSTID')
		expect(fake.calls.filter((call) => call.command === 'XCLAIM')).toHaveLength(1)

		// A scan during backoff may claim ownership, but must not XCLAIM or read
		// XPENDING. This models repeated scans by this worker and after a restart.
		const pendingReadsBeforeBackoffScan = fake.calls.filter((call) => call.command === 'XPENDING').length
		await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
		expect(fake.deliveryCounts.get(id)).toBe(1)
		expect(fake.calls.filter((call) => call.command === 'XCLAIM')).toHaveLength(1)
		expect(fake.calls.filter((call) => call.command === 'XPENDING')).toHaveLength(pendingReadsBeforeBackoffScan)
	})

	test('suppresses site-backoff scans for processing failures and reappeared tombstones', async () => {
		const reasons = ['firehose-processing-failed:update', SITE_DELETE_TOMBSTONE_REASON]
		for (const [index, reason] of reasons.entries()) {
			const id = `90001${index}-0`
			const fake = new FakeClaimRedis(id, messageFields(reason))
			fake.siteBackoffTtlSeconds = 60
			const dependencies = createDependencies({
				fetchSiteRecordOutcome: async () => ({ kind: 'present' as const, record: reappearedRecord, cid: 'cid' }),
			})

			await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
			expect(fake.deliveryCounts.get(id)).toBe(1)
			expect(fake.calls.filter((call) => call.command === 'XCLAIM')).toHaveLength(1)
			expect(fake.retryTtlSeconds).toBe(60)

			// Fresh scans use a fresh cursor. These calls model repeated scans and a
			// worker restart; the suppression key is the durable Redis state.
			await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
			await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
			expect(fake.deliveryCounts.get(id)).toBe(1)
			expect(fake.calls.filter((call) => call.command === 'XCLAIM')).toHaveLength(1)
			expect(fake.calls.filter((call) => call.command === 'XPENDING')).toHaveLength(1)
			expect(fake.calls.filter((call) => call.command === 'PIPELINE_EXEC')).toHaveLength(3)
		}
	})

	test('persists suppression after blob backoff for tombstone and firehose failures', async () => {
		const reasons = [SITE_DELETE_TOMBSTONE_REASON, 'firehose-processing-failed:update']
		for (const [index, reason] of reasons.entries()) {
			const id = `90002${index}-0`
			const fake = new FakeClaimRedis(id, messageFields(reason))
			const dependencies = createDependencies({
				fetchSiteRecordOutcome: async () => ({ kind: 'present' as const, record: reappearedRecord, cid: 'cid' }),
				handleSiteCreateOrUpdate: async () => {
					throw new SiteBlobBackoffError(DID, RKEY, Date.now() + 60_000, 1)
				},
			})

			await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
			expect(fake.deliveryCounts.get(id)).toBe(1)
			expect(fake.calls.filter((call) => call.command === 'SET').map((call) => call.args[0])).toEqual([
				`revalidate:site:failure-backoff:${DID}:${RKEY}`,
				`revalidate:retry:${id}`,
			])
			expect(fake.retryTtlSeconds).toBeGreaterThan(0)
			expect(fake.siteBackoffTtlSeconds).toBe(fake.retryTtlSeconds)

			// The persisted per-message key suppresses both the TTL filter and
			// XPENDING/XCLAIM accounting until the site backoff expires.
			await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
			await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
			expect(fake.deliveryCounts.get(id)).toBe(1)
			expect(fake.calls.filter((call) => call.command === 'XCLAIM')).toHaveLength(1)
			expect(fake.calls.filter((call) => call.command === 'XPENDING')).toHaveLength(1)
		}
	})

	test('uses one bounded TTL pipeline and caps an oversized JUSTID response before XCLAIM', async () => {
		const ids = Array.from({ length: 150 }, (_, index) => `${910000 + index}-0`)
		const fake = new FakeClaimRedis(ids, messageFields('firehose-processing-failed:update'))
		for (const id of ids.slice(0, 50)) fake.retryTtlOverrides.set(id, 120)
		const boundedRuntime = { ...runtimeConfig, batchSize: 100 }

		await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, boundedRuntime)

		const pipelineExecutions = fake.calls.filter((call) => call.command === 'PIPELINE_EXEC')
		expect(pipelineExecutions).toHaveLength(1)
		expect(pipelineExecutions[0]?.args).toHaveLength(100)
		const xclaim = fake.calls.find((call) => call.command === 'XCLAIM')
		expect(xclaim?.args.slice(4)).toEqual(ids.slice(50, 100))
		expect(fake.deliveryCounts.get(ids[0] ?? '')).toBeUndefined()
		expect(fake.deliveryCounts.get(ids[50] ?? '')).toBe(1)
		expect(fake.deliveryCounts.get(ids[100] ?? '')).toBeUndefined()
	})

	test('fails closed on a malformed batched TTL response without XCLAIM', async () => {
		const ids = ['920000-0', '920001-0']
		const fake = new FakeClaimRedis(ids, messageFields('firehose-processing-failed:update'))
		fake.pipelineResultOverride = [[null, -1]]

		await expect(scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig)).rejects.toThrow(
			'pipeline returned',
		)
		expect(fake.calls.filter((call) => call.command === 'XCLAIM')).toHaveLength(0)
		expect(fake.deliveryCounts.size).toBe(0)
	})

	test('keeps compatibility with a minimal Redis seam without pipeline', async () => {
		const id = '920010-0'
		const fake = new FakeClaimRedis(id, messageFields('firehose-processing-failed:update'))
		;(fake as unknown as { pipeline?: unknown }).pipeline = undefined

		await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig)

		expect(fake.deliveryCounts.get(id)).toBe(1)
		expect(fake.calls.filter((call) => call.command === 'XCLAIM')).toHaveLength(1)
	})

	test('counts only real processing deliveries toward maxAttempts', async () => {
		const id = '900002-0'
		const fake = new FakeClaimRedis(id, messageFields('storage-miss:index.html'))
		const dependencies = createDependencies({
			fetchSiteRecordOutcome: async () => {
				throw new Error('temporary PDS failure')
			},
		})

		await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
		await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
		expect(fake.deliveryCounts.get(id)).toBe(1)

		// Let the retry become eligible. The second actual processing attempt is
		// the one that reaches the quarantine threshold.
		fake.retryTtlSeconds = 0
		await scanStaleRevalidationMessagesForTests(fake as unknown as Redis, runtimeConfig, dependencies)
		expect(fake.deliveryCounts.get(id)).toBe(2)
		expect(fake.quarantineAttempts).toEqual([2])
	})
})

describe('drained acknowledged-entry maintenance', () => {
	async function maintenance(result: unknown): Promise<{ scripts: string[] }> {
		const scripts: string[] = []
		await trimDrainedRevalidationEntries({
			eval: async (script) => {
				scripts.push(script)
				return result
			},
		})
		return { scripts }
	}

	test('does not trim when any consumer group has pending entries or lag', async () => {
		const { scripts } = await maintenance(0)
		const script = scripts[0] ?? ''
		expect(script).toContain('if pending ~= 0 or lag ~= 0 then return 0 end')
		expect(script).toContain('if not configuredFound then return 0 end')
		expect(script).toContain('XTRIM')
	})

	test('fails closed when any group omits safety metadata', async () => {
		const { scripts } = await maintenance(0)
		expect(scripts[0]).toContain('if not name or pending == nil or lag == nil then return 0 end')
	})

	test('does nothing when the configured group is absent', async () => {
		const { scripts } = await maintenance(0)
		expect(scripts[0]).toContain('return 0')
	})

	test('allows atomic cleanup only when every group is drained', async () => {
		const { scripts } = await maintenance(4)
		expect(scripts[0]).toContain('pending ~= 0 or lag ~= 0')
		expect(scripts[0]).toContain("'MAXLEN', '=', 0")
	})
})

describe('worker runtime configuration', () => {
	test('falls back for malformed, unsafe, and out-of-range values', () => {
		const defaults = resolveRevalidateWorkerRuntimeConfig({})
		expect(
			resolveRevalidateWorkerRuntimeConfig({
				WISP_REVALIDATE_BATCH_SIZE: '0',
				WISP_REVALIDATE_CLAIM_IDLE_MS: '1',
				WISP_REVALIDATE_BLOCK_MS: 'not-a-number',
				WISP_REVALIDATE_BLOCKING_GRACE_MS: '999999',
				WISP_REVALIDATE_SOCKET_TIMEOUT_MS: '-1',
				WISP_REVALIDATE_FAILURE_BACKOFF_SECONDS: '1.5',
			}),
		).toEqual(defaults)
	})

	test('uses bounded runtime values to configure Redis blocking and socket timeouts', () => {
		const runtimeConfig = resolveRevalidateWorkerRuntimeConfig({
			WISP_REVALIDATE_BATCH_SIZE: '50',
			WISP_REVALIDATE_CLAIM_IDLE_MS: '120000',
			WISP_REVALIDATE_BLOCK_MS: '10000',
			WISP_REVALIDATE_BLOCKING_GRACE_MS: '2000',
			WISP_REVALIDATE_SOCKET_TIMEOUT_MS: '25000',
			WISP_REVALIDATE_FAILURE_BACKOFF_SECONDS: '300',
		})

		expect(runtimeConfig).toEqual({
			batchSize: 50,
			claimIdleMs: 120000,
			blockMs: 10000,
			blockingGraceMs: 2000,
			socketTimeoutMs: 25000,
			failureBackoffSeconds: 300,
			reconnectMinMs: 250,
			reconnectMaxMs: 30_000,
		})
		expect(createRevalidateWorkerRedisOptions(runtimeConfig)).toEqual({
			maxRetriesPerRequest: 2,
			enableReadyCheck: true,
			blockingTimeout: 12000,
			blockingTimeoutGrace: 2000,
			socketTimeout: 25000,
		})
	})
})

describe('worker lifecycle', () => {
	const runtimeConfig: RevalidateWorkerRuntimeConfig = {
		batchSize: 10,
		claimIdleMs: 60_000,
		blockMs: 5_000,
		blockingGraceMs: 1_000,
		socketTimeoutMs: 16_000,
		failureBackoffSeconds: 600,
		reconnectMinMs: 10,
		reconnectMaxMs: 10,
	}

	test('disconnects a blocking XREADGROUP before awaiting the loop', async () => {
		const clients: FakeLifecycleRedis[] = []
		startRevalidateWorkerForTests(lifecycleFactory(clients), 'redis://worker-test', runtimeConfig)
		await flushAsyncWork()

		const client = clients[0]
		expect(client?.xreadArguments).toHaveLength(1)
		expect(client?.options).toEqual(createRevalidateWorkerRedisOptions(runtimeConfig))

		await stopRevalidateWorker()

		expect(client?.disconnected).toBe(true)
		expect(getRevalidateWorkerStateForTests()).toEqual({
			running: false,
			hasRedisClient: false,
			hasLoop: false,
		})
	})

	test('aborts an active handler before disconnect so the pending entry is left untouched', async () => {
		const clients: FakeLifecycleRedis[] = []
		const handlerStarted = deferred<void>()
		const dependencies = createDependencies({
			fetchSiteRecord: async (_did, _rkey, resources) => {
				handlerStarted.resolve()
				await new Promise<void>((resolve) =>
					resources?.signal.addEventListener('abort', () => resolve(), { once: true }),
				)
				throw resources?.signal.reason instanceof Error ? resources.signal.reason : new Error('aborted')
			},
		})
		const factory: RevalidateWorkerRedisFactory = (_redisUrl, redisOptions) => {
			const client = new FakeMessageRedis(redisOptions)
			clients.push(client)
			return client as unknown as Redis
		}

		startRevalidateWorkerForTests(factory, 'redis://worker-test', runtimeConfig, { dependencies })
		await handlerStarted.promise
		await stopRevalidateWorker()

		expect(clients[0]?.disconnected).toBe(true)
		expect(clients[0]?.evalCalls).toBe(0)
		expect(getRevalidateWorkerStateForTests()).toEqual({
			running: false,
			hasRedisClient: false,
			hasLoop: false,
		})
	})

	test('reports an unsafe stop when storage ignores lifecycle cancellation', async () => {
		const clients: FakeLifecycleRedis[] = []
		const handlerStarted = deferred<void>()
		const releaseHandler = deferred<void>()
		const dependencies = createDependencies({
			fetchSiteRecord: async () => {
				handlerStarted.resolve()
				await releaseHandler.promise
				return null
			},
		})
		const factory: RevalidateWorkerRedisFactory = (_redisUrl, redisOptions) => {
			const client = new FakeMessageRedis(redisOptions)
			clients.push(client)
			return client as unknown as Redis
		}

		startRevalidateWorkerForTests(factory, 'redis://worker-test', runtimeConfig, { dependencies })
		await handlerStarted.promise
		await expect(stopRevalidateWorker({ gracePeriodMs: 0 })).resolves.toEqual({ stopped: false, forced: true })
		expect(clients[0]?.disconnected).toBe(true)
		expect(getRevalidateWorkerStateForTests().hasLoop).toBe(true)

		// Release the fake handler so the detached loop can settle before the test
		// ends. A real caller must exit nonzero instead of releasing authority.
		releaseHandler.resolve()
		await stopRevalidateWorker()
		expect(getRevalidateWorkerStateForTests()).toMatchObject({ running: false, hasLoop: false })
	})

	test('supervises initial group failure and reconnects while reporting no live Redis client', async () => {
		const clients: FakeLifecycleRedis[] = []
		const failedFactory = lifecycleFactory(clients, { xgroupFailure: new Error('group unavailable') })
		startRevalidateWorkerForTests(failedFactory, 'redis://worker-test', runtimeConfig)
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(clients.length).toBeGreaterThan(1)
		expect(clients[0]?.disconnected).toBe(true)
		expect(getRevalidateWorkerStateForTests().running).toBe(true)
	})

	test('cancels retry backoff promptly when stop is requested', async () => {
		const clients: FakeLifecycleRedis[] = []
		startRevalidateWorkerForTests(
			lifecycleFactory(clients, { xautoclaimFailure: new Error('temporary Redis error') }),
			'redis://worker-test',
			runtimeConfig,
		)
		await flushAsyncWork()
		expect(clients[0]?.claimCalls).toBe(1)

		let stopped = false
		const stopping = stopRevalidateWorker().then(() => {
			stopped = true
		})
		await flushAsyncWork()

		expect(stopped).toBe(true)
		await stopping
	})

	test('resets reconnect backoff after a healthy read iteration', async () => {
		const clients: FakeLifecycleRedis[] = []
		const delays: number[] = []
		const releaseWaiters: Array<() => void> = []
		let resolveSecondDelay: (() => void) | undefined
		const secondDelaySeen = new Promise<void>((resolve) => {
			resolveSecondDelay = resolve
		})
		const reconnectRuntime: RevalidateWorkerRuntimeConfig = {
			...runtimeConfig,
			reconnectMinMs: 100,
			reconnectMaxMs: 500,
		}
		const factory: RevalidateWorkerRedisFactory = (_redisUrl, redisOptions) => {
			const client =
				clients.length === 0
					? new FakeLifecycleRedis(redisOptions, undefined, new Error('initial connection failed'))
					: new FakeHealthyThenFailureRedis(redisOptions)
			clients.push(client)
			return client as unknown as Redis
		}
		const waitForReconnect = (delayMs: number) =>
			new Promise<void>((resolve) => {
				delays.push(delayMs)
				releaseWaiters.push(resolve)
				if (delays.length === 2) resolveSecondDelay?.()
			})

		startRevalidateWorkerForTests(factory, 'redis://worker-test', reconnectRuntime, {
			random: () => 0.5,
			waitForReconnect,
		})
		await flushAsyncWork()
		expect(delays).toEqual([50])
		releaseWaiters.shift()?.()
		await secondDelaySeen
		expect(clients).toHaveLength(2)

		// Without the healthy-read reset this second failure would use attempt=1
		// and produce a 100ms delay; it should be the first 50ms delay again.
		expect(delays).toEqual([50, 50])
		releaseWaiters.shift()?.()
		await stopRevalidateWorker()
	})
})
