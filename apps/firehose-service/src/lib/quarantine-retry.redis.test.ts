import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { enqueueSiteRevalidation, revalidationQuarantineKey, revalidationSiteVersionKey } from '@wispplace/constants'
import type { RevalidateQuarantineRetryOutcome } from '@wispplace/observability'
import Redis from 'ioredis'
import { config } from '../config'
import {
	QUARANTINE_RETRY_SCHEDULE_MS,
	QUARANTINE_RETRY_STATE_KEY,
	type QuarantineRetryDependencies,
	type QuarantineRetryRedis,
	runQuarantineRetryTick,
} from './quarantine-retry'
import {
	classifyRevalidationError,
	processRevalidationMessage,
	type RevalidateRedisClient,
	type RevalidateWorkerDependencies,
	RevalidationProcessingError,
} from './revalidate-worker'
import { VERIFIED_REPAIR_PROTOCOL, verifiedRepairCapabilityKey } from './site-repair-protocol'

// Either an isolated redis-server on a private socket, or an explicitly named
// disposable database (WISP_TEST_REDIS_URL) that must be empty when the suite starts.
const executable = Bun.which('redis-server') ?? Bun.which('valkey-server')
const externalUrl = process.env.WISP_TEST_REDIS_URL
const integration = executable || externalUrl ? describe : describe.skip

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const stream = config.revalidateStream
const group = config.revalidateGroup
const consumer = 'quarantine-retry-test'
const proof = { recordCid: 'bafyrecord', manifestFingerprint: 'f'.repeat(64), fileCount: 1, totalBytes: 1 }

integration('quarantine retry against real Redis and the real worker scripts', () => {
	let directory: string | undefined
	let server: ReturnType<typeof Bun.spawn> | undefined
	let redis: Redis

	beforeAll(async () => {
		if (externalUrl) {
			redis = new Redis(externalUrl, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null })
			await redis.connect()
			if ((await redis.dbsize()) !== 0) throw new Error('WISP_TEST_REDIS_URL must name an empty, disposable database')
			return
		}
		directory = mkdtempSync('/tmp/wisp-quarantine-')
		const socket = `${directory}/redis.sock`
		server = Bun.spawn(
			[
				executable!,
				'--port',
				'0',
				'--unixsocket',
				socket,
				'--unixsocketperm',
				'700',
				'--save',
				'',
				'--appendonly',
				'no',
			],
			{ stdout: 'ignore', stderr: 'ignore' },
		)
		const deadline = Date.now() + 5_000
		while (!existsSync(socket)) {
			if (Date.now() >= deadline) throw new Error('Isolated Redis failed to start')
			await delay(10)
		}
		redis = new Redis({ path: socket, lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null })
		await redis.connect()
	})

	afterAll(async () => {
		if (redis) {
			await redis.flushdb()
			redis.disconnect()
		}
		if (server) {
			server.kill()
			await server.exited
		}
		if (directory) rmSync(directory, { recursive: true, force: true })
	})

	beforeEach(async () => {
		await redis.flushdb()
		await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
		await redis.xgroup('CREATECONSUMER', stream, group, consumer)
		await redis.set(verifiedRepairCapabilityKey(stream, group), `${VERIFIED_REPAIR_PROTOCOL}:${consumer}`)
	})

	const unexpected = async (): Promise<never> => {
		throw new Error('unexpected worker dependency call')
	}
	const workerDependencies = (overrides: Partial<RevalidateWorkerDependencies>): RevalidateWorkerDependencies => ({
		fetchSiteRecord: unexpected,
		fetchSettingsRecord: unexpected,
		handleSiteCreateOrUpdate: unexpected,
		handleSiteDelete: unexpected,
		handleSettingsUpdate: unexpected,
		handleSettingsDelete: unexpected,
		...overrides,
	})

	/** Deliver one stream entry to the worker as its final attempt. */
	async function deliverLast(fields: string[], dependencies: RevalidateWorkerDependencies, id?: string) {
		const entryId = id ?? (await redis.xadd(stream, '*', ...fields))!
		await redis.xreadgroup('GROUP', group, consumer, 'COUNT', 100, 'STREAMS', stream, '>')
		await processRevalidationMessage(entryId, fields, redis as unknown as RevalidateRedisClient, dependencies, {
			deliveryAttempt: 3,
			enforceAttemptPolicy: true,
		})
	}

	/** Fence a site the way production does: the worker dead-letters its last failed delivery. */
	async function fence(did: string, rkey: string, error: Error, sourceVersion = '') {
		await deliverLast(
			['did', did, 'rkey', rkey, 'reason', 'storage-miss', 'ts', '1', 'sourceVersion', sourceVersion],
			workerDependencies({
				fetchSiteRecord: async () => {
					throw error
				},
			}),
		)
		expect(await redis.exists(revalidationQuarantineKey(did, rkey))).toBe(1)
	}

	/** Run the verified repair entry the schedule enqueued, materializing successfully. */
	async function workerMaterializes() {
		const [[id, fields]] = (await redis.xrange(stream, '-', '+')) as [[string, string[]]]
		const recordCid = fields[fields.indexOf('repairRecordCid') + 1]!
		const manifestFingerprint = fields[fields.indexOf('repairManifestFingerprint') + 1]!
		await deliverLast(
			fields,
			workerDependencies({
				fetchSiteRecord: async () => ({ record: {} as never, cid: recordCid }),
				handleSiteCreateOrUpdate: async (_did, _rkey, _record, _cid, options) => {
					await options?.onVerifiedRepairComplete?.({ recordCid, manifestFingerprint, invalidationStreamId: '1-0' })
				},
			}),
			id,
		)
	}

	function harness(preflight: QuarantineRetryDependencies['preflight']) {
		const outcomes: RevalidateQuarantineRetryOutcome[] = []
		let clock = Date.now()
		let preflights = 0
		const deps: QuarantineRetryDependencies = {
			redis: redis as unknown as QuarantineRetryRedis,
			target: { stream, group, maxStreamLength: 1_000, dlqStream: config.revalidateDlqStream },
			retries: true,
			preflight: async (...args) => {
				preflights++
				return await preflight(...args)
			},
			classify: classifyRevalidationError,
			recordRetry: (outcome) => outcomes.push(outcome),
			now: () => clock,
			random: () => 0.5,
		}
		return {
			deps,
			outcomes,
			preflights: () => preflights,
			advance: (ms: number) => {
				clock += ms
			},
			tick: () => runQuarantineRetryTick(deps, new AbortController().signal),
		}
	}

	const transient = () => Object.assign(new Error('Failed to download files'), { code: 'FETCH_FAILED' })

	test('a transient fence is retried on the schedule and released only once the fetch works', async () => {
		const did = 'did:plc:transient'
		await fence(did, 'site', transient())
		let fetchWorks = false
		const h = harness(async () => {
			if (!fetchWorks) throw transient()
			return proof
		})

		const first = await h.tick()
		expect(first.snapshot.fenced).toEqual({ transient: 1, permanent: 0, unknown: 0 })
		expect(first.snapshot.dlqEntries).toBe(1)
		expect(h.preflights()).toBe(0)

		h.advance(QUARANTINE_RETRY_SCHEDULE_MS[0]! + MINUTE)
		await h.tick()
		expect(h.outcomes).toEqual(['failed'])
		expect(await redis.exists(revalidationQuarantineKey(did, 'site'))).toBe(1)
		expect(await redis.xlen(stream)).toBe(0)

		// Not due again until the second delay has passed.
		h.advance(30 * MINUTE)
		await h.tick()
		expect(h.preflights()).toBe(1)

		fetchWorks = true
		h.advance(QUARANTINE_RETRY_SCHEDULE_MS[1]!)
		await h.tick()
		expect(h.outcomes).toEqual(['failed', 'retrying'])
		expect(await redis.exists(revalidationQuarantineKey(did, 'site'))).toBe(0)
		expect(await redis.xlen(stream)).toBe(1)

		await workerMaterializes()
		const after = await h.tick()
		expect(h.outcomes).toEqual(['failed', 'retrying', 'recovered'])
		expect(after.snapshot.fenced).toEqual({ transient: 0, permanent: 0, unknown: 0 })
		expect(await redis.hlen(QUARANTINE_RETRY_STATE_KEY)).toBe(0)
		expect(await redis.exists(revalidationQuarantineKey(did, 'site'))).toBe(0)
		// Hosting can enqueue repairs for the site again.
		expect(
			await enqueueSiteRevalidation(redis, {
				stream: 'hosting-probe',
				maxLen: 10,
				dedupeTtlSeconds: 60,
				did,
				rkey: 'site',
				reason: 'storage-miss',
			}),
		).toBe('enqueued')
	})

	test('a permanent fence is never retried', async () => {
		const did = 'did:plc:permanent'
		await fence(did, 'site', new RevalidationProcessingError('INVALID_RECORD', 'permanent'))
		const h = harness(async () => proof)
		for (let elapsed = 0; elapsed < 48 * HOUR; elapsed += 5 * MINUTE) {
			const { snapshot } = await h.tick()
			expect(snapshot.fenced.permanent).toBe(1)
			h.advance(5 * MINUTE)
		}
		expect(h.preflights()).toBe(0)
		expect(h.outcomes).toEqual([])
		expect(await redis.exists(revalidationQuarantineKey(did, 'site'))).toBe(1)
		expect(await redis.hlen(QUARANTINE_RETRY_STATE_KEY)).toBe(0)
		expect(await redis.xlen(stream)).toBe(0)
	})

	test('gives up after the last scheduled attempt and leaves the fence', async () => {
		const did = 'did:plc:gives-up'
		await fence(did, 'site', transient())
		const h = harness(async () => {
			throw transient()
		})
		for (let elapsed = 0; elapsed < 72 * HOUR; elapsed += 5 * MINUTE) {
			await h.tick()
			h.advance(5 * MINUTE)
		}
		expect(h.preflights()).toBe(QUARANTINE_RETRY_SCHEDULE_MS.length)
		expect(h.outcomes).toEqual(['failed', 'failed', 'failed', 'gave-up'])
		expect(await redis.exists(revalidationQuarantineKey(did, 'site'))).toBe(1)
	})

	test('a permanent failure found by the retry ends the schedule at once', async () => {
		await fence('did:plc:turns-permanent', 'site', transient())
		const h = harness(async () => {
			throw new RevalidationProcessingError('BLOB_SIZE_MISMATCH', 'permanent')
		})
		for (let elapsed = 0; elapsed < 48 * HOUR; elapsed += 5 * MINUTE) {
			await h.tick()
			h.advance(5 * MINUTE)
		}
		expect(h.preflights()).toBe(1)
		expect(h.outcomes).toEqual(['gave-up'])
	})

	test('never releases a fence when a newer record version lands during the preflight', async () => {
		const did = 'did:plc:raced'
		await fence(did, 'site', transient())
		const h = harness(async () => {
			await redis.set(revalidationSiteVersionKey(did, 'site'), '3newerrevisio')
			return proof
		})
		h.advance(QUARANTINE_RETRY_SCHEDULE_MS[0]! + MINUTE)
		await h.tick()
		expect(h.outcomes).toEqual(['skipped'])
		expect(await redis.exists(revalidationQuarantineKey(did, 'site'))).toBe(1)
		expect(await redis.xlen(stream)).toBe(0)
	})

	test('a repair the worker dead-letters again counts as a failed attempt and keeps its schedule', async () => {
		const did = 'did:plc:fails-again'
		// The failed event was newer than the last reconciled version, so the repair is fenced again
		// under a different value; that must not restart the schedule.
		await redis.set(revalidationSiteVersionKey(did, 'site'), '3oldrevision2')
		await fence(did, 'site', transient(), '3newrevision2')
		const h = harness(async () => proof)
		h.advance(QUARANTINE_RETRY_SCHEDULE_MS[0]! + MINUTE)
		await h.tick()
		expect(h.outcomes).toEqual(['retrying'])
		const [[id, fields]] = (await redis.xrange(stream, '-', '+')) as [[string, string[]]]
		await deliverLast(
			fields,
			workerDependencies({
				fetchSiteRecord: async () => {
					throw transient()
				},
			}),
			id,
		)
		expect(await redis.get(revalidationQuarantineKey(did, 'site'))).toBe('3oldrevision2')
		await h.tick()
		expect(h.outcomes).toEqual(['retrying', 'failed'])
		const state = JSON.parse((await redis.hget(QUARANTINE_RETRY_STATE_KEY, `${encodeURIComponent(did)}/site`))!)
		expect(state.attempts).toBe(1)
		expect(state.token).toBeUndefined()
		expect(h.preflights()).toBe(1)
		h.advance(QUARANTINE_RETRY_SCHEDULE_MS[1]!)
		await h.tick()
		expect(h.preflights()).toBe(2)
	})

	test('defers without a preflight when no verified-repair worker is live', async () => {
		await fence('did:plc:no-worker', 'site', transient())
		await redis.del(verifiedRepairCapabilityKey(stream, group))
		const h = harness(async () => proof)
		h.advance(QUARANTINE_RETRY_SCHEDULE_MS[0]! + MINUTE)
		await h.tick()
		expect(h.outcomes).toEqual(['deferred'])
		expect(h.preflights()).toBe(0)
	})

	test('counts fences by class, the DLQ length and the oldest fence; retries off touches nothing', async () => {
		await fence('did:plc:a', 'one', transient())
		await fence('did:plc:b', 'two', new RevalidationProcessingError('INVALID_RECORD', 'permanent'))
		await redis.set(revalidationQuarantineKey('did:plc:c', 'legacy'), '')
		const h = harness(async () => proof)
		h.deps.retries = false
		h.advance(3 * HOUR)
		const { snapshot, scanComplete } = await h.tick()
		expect(scanComplete).toBe(true)
		expect(snapshot.fenced).toEqual({ transient: 1, permanent: 1, unknown: 1 })
		expect(snapshot.dlqEntries).toBe(2)
		expect(snapshot.oldestFenceAgeSeconds).toBeGreaterThanOrEqual(3 * 3600)
		expect(snapshot.oldestFenceAgeSeconds).toBeLessThan(3 * 3600 + 60)
		expect(await redis.exists(QUARANTINE_RETRY_STATE_KEY)).toBe(0)
		expect(h.preflights()).toBe(0)
	})
})
