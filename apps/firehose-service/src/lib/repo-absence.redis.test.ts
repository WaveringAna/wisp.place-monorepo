import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { enqueueSiteRevalidation, revalidationQuarantineKey } from '@wispplace/constants'
import type { RepoAbsenceAction } from '@wispplace/observability'
import Redis from 'ioredis'
import { config } from '../config'
import type { RepoProbeOutcome } from './cache-writer'
import { type QuarantineRetryDependencies, type QuarantineRetryRedis, runQuarantineRetryTick } from './quarantine-retry'
import { REPO_ABSENCE_STATE_KEY, type RepoAbsenceDependencies } from './repo-absence'
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
const consumer = 'repo-absence-test'
const OLD_PDS = 'https://pds.old.example'
const NEW_PDS = 'https://pds.new.example'

integration('repo-absence check against real Redis and the real worker scripts', () => {
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
		directory = mkdtempSync('/tmp/wisp-repo-absence-')
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

	async function deliverLast(fields: string[], dependencies: RevalidateWorkerDependencies, id?: string) {
		const entryId = id ?? (await redis.xadd(stream, '*', ...fields))!
		await redis.xreadgroup('GROUP', group, consumer, 'COUNT', 100, 'STREAMS', stream, '>')
		await processRevalidationMessage(entryId, fields, redis as unknown as RevalidateRedisClient, dependencies, {
			deliveryAttempt: 3,
			enforceAttemptPolicy: true,
		})
	}

	/** Fence a site the way production does: the worker dead-letters its last failed delivery. */
	async function fence(did: string, rkey = 'site') {
		await deliverLast(
			['did', did, 'rkey', rkey, 'reason', 'storage-miss', 'ts', '1', 'sourceVersion', ''],
			workerDependencies({
				fetchSiteRecord: async () => {
					throw Object.assign(new Error('Failed to download files'), { code: 'FETCH_FAILED' })
				},
			}),
		)
		expect(await redis.exists(revalidationQuarantineKey(did, rkey))).toBe(1)
	}

	/** What hosting gets on a cache miss for the site. */
	const hostingProbe = (did: string, rkey = 'site') =>
		enqueueSiteRevalidation(redis, {
			stream: 'hosting-probe',
			maxLen: 1_000,
			dedupeTtlSeconds: 1,
			did,
			rkey,
			reason: 'storage-miss',
		})

	function harness(answer: (did: string, at: number) => RepoProbeOutcome, cachedRows = true) {
		let clock = Date.now()
		const start = clock
		const db = {
			absent: new Map<string, number>(),
			tombstoned: new Set<string>(),
			cleared: [] as string[],
			invalidations: [] as string[],
		}
		const probes: string[] = []
		const actions: RepoAbsenceAction[] = []
		const repoAbsence: RepoAbsenceDependencies = {
			policy: { minChecks: 3, minSpanMs: 24 * HOUR, probeIntervalMs: 8 * HOUR },
			probe: async (did) => {
				probes.push(did)
				return answer(did, clock - start)
			},
			markSiteAbsent: async (did, rkey) => {
				if (!cachedRows) return null
				const key = `${did}/${rkey}`
				db.absent.set(key, (db.absent.get(key) ?? 0) + 1)
				return { did, rkey }
			},
			insertMissingSiteTombstone: async (did, rkey) => {
				db.tombstoned.add(`${did}/${rkey}`)
				return true
			},
			clearSiteAbsent: async (did, rkey) => {
				db.cleared.push(`${did}/${rkey}`)
				return db.absent.delete(`${did}/${rkey}`)
			},
			publishCacheInvalidation: async (did, rkey) => {
				db.invalidations.push(`${did}/${rkey}`)
			},
			enqueueRepair: (did, rkey) =>
				enqueueSiteRevalidation(redis, {
					stream,
					maxLen: 1_000,
					dedupeTtlSeconds: 60,
					did,
					rkey,
					reason: 'storage-miss:repo-returned',
				}),
			record: (_probe, action) => actions.push(action),
		}
		const deps: QuarantineRetryDependencies = {
			redis: redis as unknown as QuarantineRetryRedis,
			target: { stream, group, maxStreamLength: 1_000, dlqStream: config.revalidateDlqStream },
			retries: true,
			// The owner's PDS answers RepoNotFound, which the retry classifies as a permanent HTTP_400.
			preflight: async () => {
				throw new RevalidationProcessingError('HTTP_400', 'permanent')
			},
			classify: classifyRevalidationError,
			recordRetry: () => {},
			repoAbsence,
			now: () => clock,
			random: () => 0.5,
		}
		const tick = () => runQuarantineRetryTick(deps, new AbortController().signal)
		return {
			deps,
			db,
			probes,
			actions,
			tick,
			elapsed: () => clock - start,
			/** Tick every five minutes for `ms`, calling `each` after every tick. */
			async runFor(ms: number, each?: () => Promise<void>) {
				for (const end = clock + ms; clock < end; clock += 5 * MINUTE) {
					await tick()
					await each?.()
				}
			},
		}
	}

	const fenced = async (did: string, rkey = 'site') => (await redis.exists(revalidationQuarantineKey(did, rkey))) === 1

	test('a gone repo is confirmed after 24 h of RepoNotFound and its fence released', async () => {
		const did = 'did:plc:gone'
		await fence(did)
		// A fence from before dead-letter generations has no classification and is never retried.
		await redis.set(revalidationQuarantineKey(did, 'legacy'), '')
		const h = harness(() => ({ kind: 'repo-absent', pds: OLD_PDS }))
		let releasedAt: number | null = null
		await h.runFor(48 * HOUR, async () => {
			if (releasedAt === null && !(await fenced(did)) && !(await fenced(did, 'legacy'))) releasedAt = h.elapsed()
		})
		expect(releasedAt).not.toBeNull()
		expect(releasedAt!).toBeGreaterThanOrEqual(24 * HOUR)
		expect(releasedAt!).toBeLessThan(25 * HOUR)
		expect([...h.db.absent.keys()].sort()).toEqual([`${did}/legacy`, `${did}/site`])
		expect(h.db.invalidations.sort()).toEqual([`${did}/legacy`, `${did}/site`])
		expect(await hostingProbe(did)).toBe('enqueued')
		expect(await hostingProbe(did, 'legacy')).toBe('enqueued')
		// Four probes each to confirm, then a watch probe every 8 h (32 h and 40 h).
		expect(h.probes.length).toBe(2 * 6)
		expect(h.actions.filter((action) => action === 'confirmed')).toHaveLength(2)
	})

	test('a repo that migrated to another PDS is never confirmed', async () => {
		const did = 'did:plc:migrating'
		await fence(did)
		const h = harness((_did, at) =>
			at < 10 * HOUR
				? { kind: 'repo-absent', pds: OLD_PDS }
				: at < 20 * HOUR
					? { kind: 'repo-absent', pds: NEW_PDS }
					: { kind: 'present' },
		)
		await h.runFor(48 * HOUR)
		expect(await fenced(did)).toBe(true)
		expect(h.db.absent.size).toBe(0)
		expect(h.actions).toContain('reset')
		expect(h.actions).not.toContain('confirmed')
	})

	test('a flaky PDS (5xx with the odd RepoNotFound) never confirms', async () => {
		const did = 'did:plc:flaky'
		await fence(did)
		let calls = 0
		const h = harness(() =>
			++calls % 3 === 0 ? { kind: 'repo-absent', pds: OLD_PDS } : { kind: 'unavailable', reason: 'HTTP_503' },
		)
		await h.runFor(48 * HOUR)
		expect(await fenced(did)).toBe(true)
		expect(h.db.absent.size).toBe(0)
		expect(h.probes.length).toBeLessThanOrEqual(8)
	})

	test('a deactivated or taken-down repo keeps its fence', async () => {
		await fence('did:plc:deactivated')
		await fence('did:plc:takendown')
		const h = harness((did) => ({
			kind: 'unavailable',
			reason: did.endsWith('deactivated') ? 'RepoDeactivated' : 'RepoTakendown',
		}))
		await h.runFor(48 * HOUR)
		expect(await fenced('did:plc:deactivated')).toBe(true)
		expect(await fenced('did:plc:takendown')).toBe(true)
		expect(h.actions.every((action) => action === 'unchanged')).toBe(true)
	})

	test('a tombstoned DID is released on its first probe; a site with no cache row is tombstoned', async () => {
		const did = 'did:plc:tombstoned'
		await fence(did)
		const h = harness(() => ({ kind: 'did-tombstoned' }), false)
		await h.runFor(30 * MINUTE)
		expect(await fenced(did)).toBe(false)
		expect([...h.db.tombstoned]).toEqual([`${did}/site`])
	})

	test('a confirmed site whose repo comes back is restored through a normal repair', async () => {
		const did = 'did:plc:returns'
		await fence(did)
		let back = false
		const h = harness(() => (back ? { kind: 'present' } : { kind: 'repo-absent', pds: OLD_PDS }))
		await h.runFor(25 * HOUR)
		expect(await fenced(did)).toBe(false)
		expect(h.db.absent.has(`${did}/site`)).toBe(true)

		back = true
		await h.runFor(25 * HOUR)
		expect(h.db.cleared).toEqual([`${did}/site`])
		expect(h.db.absent.size).toBe(0)
		// Nothing is fenced or watched any more.
		expect(await redis.hlen(REPO_ABSENCE_STATE_KEY)).toBe(0)
		const entries = (await redis.xrange(stream, '-', '+')) as Array<[string, string[]]>
		const [id, fields] = entries[entries.length - 1]!
		expect(fields[fields.indexOf('reason') + 1]).toBe('storage-miss:repo-returned')
		// The real worker materializes the current record, which serves the site again.
		const materialized: string[] = []
		await deliverLast(
			fields,
			workerDependencies({
				fetchSiteRecord: async () => ({ record: {} as never, cid: 'bafyrecord' }),
				handleSiteCreateOrUpdate: async (siteDid, rkey) => {
					materialized.push(`${siteDid}/${rkey}`)
				},
			}),
			id,
		)
		expect(materialized).toEqual([`${did}/site`])
	})

	test('never releases a fence that changed after the probe', async () => {
		const did = 'did:plc:raced'
		await fence(did)
		const h = harness((_did, at) => {
			if (at >= 24 * HOUR) void redis.set(revalidationQuarantineKey(did, 'site'), '3newerrevisio')
			return { kind: 'repo-absent', pds: OLD_PDS }
		})
		await h.runFor(25 * HOUR)
		expect(await redis.get(revalidationQuarantineKey(did, 'site'))).toBe('3newerrevisio')
		expect(h.actions).toContain('refused')
		expect(h.db.absent.size).toBe(0)
	})

	test('WISP_REPO_ABSENCE=off leaves every fence alone', async () => {
		const did = 'did:plc:switched-off'
		await fence(did)
		const h = harness(() => ({ kind: 'repo-absent', pds: OLD_PDS }))
		h.deps.repoAbsence = undefined
		await h.runFor(48 * HOUR)
		expect(await fenced(did)).toBe(true)
		expect(h.probes).toHaveLength(0)
		expect(await redis.exists(REPO_ABSENCE_STATE_KEY)).toBe(0)
	})
})
