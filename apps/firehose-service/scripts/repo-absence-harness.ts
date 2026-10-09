/**
 * Before/after harness for the repo-absence check on a disposable Redis.
 *
 * Fences 25 sites the way production does (the real worker dead-letter script,
 * or a bare legacy fence with no generation) and simulates 48 hours of
 * 5-minute leader ticks on a fake clock with a mix of owner PDS behaviours:
 * repos that are gone, a tombstoned DID, migrations, a flaky PDS, a PDS outage,
 * a deactivated repo and a gone repo that comes back after 36 hours. Every
 * tick it asks what hosting would answer on a cache miss: 503 while fenced,
 * 404 once the site is marked absent or tombstoned. Without
 * src/lib/repo-absence.ts (origin/main) only the retry schedule runs.
 *
 * Usage: REDIS_URL=redis://127.0.0.1:6379/14 NODE_ENV=test bun run scripts/repo-absence-harness.ts
 * The database must be empty; it is flushed when the run ends.
 */
import { revalidationQuarantineKey } from '@wispplace/constants'
import Redis from 'ioredis'
import { config } from '../src/config'
import type { RepoProbeOutcome } from '../src/lib/cache-writer'
import type { QuarantineRetryDependencies, QuarantineRetryRedis } from '../src/lib/quarantine-retry'
import {
	classifyRevalidationError,
	processRevalidationMessage,
	type RevalidateRedisClient,
	type RevalidateWorkerDependencies,
	RevalidationProcessingError,
} from '../src/lib/revalidate-worker'
import { VERIFIED_REPAIR_PROTOCOL, verifiedRepairCapabilityKey } from '../src/lib/site-repair-protocol'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SIMULATED_MS = 48 * HOUR
const TICK_MS = 5 * MINUTE
const stream = config.revalidateStream
const group = config.revalidateGroup
const consumer = 'repo-absence-harness'
const OLD = 'https://pds.old.example'
const NEW = 'https://pds.new.example'

type Group =
	| 'gone'
	| 'gone-legacy'
	| 'tombstoned'
	| 'migrating'
	| 'migrating-slow'
	| 'flaky'
	| 'outage'
	| 'deactivated'
	| 'returns'
/** Sites per group, whether the fence is a legacy one, and whether the site has a cache row. */
const GROUPS: Record<Group, { count: number; legacy: boolean; gone: boolean }> = {
	gone: { count: 8, legacy: false, gone: true },
	'gone-legacy': { count: 4, legacy: true, gone: true },
	tombstoned: { count: 1, legacy: true, gone: true },
	migrating: { count: 3, legacy: false, gone: false },
	'migrating-slow': { count: 2, legacy: false, gone: false },
	flaky: { count: 3, legacy: false, gone: false },
	outage: { count: 2, legacy: true, gone: false },
	deactivated: { count: 1, legacy: false, gone: false },
	returns: { count: 1, legacy: false, gone: false },
}

const probeCalls = new Map<string, number>()
/** What the owner's PDS (through a fresh DID resolution) answers `did` at `at` ms into the run. */
function answer(did: string, at: number): RepoProbeOutcome {
	const name = groupOf(did)
	const gone = (pds = OLD): RepoProbeOutcome => ({ kind: 'repo-absent', pds })
	switch (name) {
		case 'gone':
		case 'gone-legacy':
			return gone()
		case 'tombstoned':
			return { kind: 'did-tombstoned' }
		case 'migrating':
			return at < 12 * HOUR ? gone() : { kind: 'present' }
		case 'migrating-slow':
			return at < 20 * HOUR ? gone() : at < 30 * HOUR ? gone(NEW) : { kind: 'present' }
		case 'flaky':
			// Every third answer from this site's PDS is RepoNotFound, the rest are 503s.
			probeCalls.set(did, (probeCalls.get(did) ?? 0) + 1)
			return probeCalls.get(did)! % 3 === 0 ? gone() : { kind: 'unavailable', reason: 'HTTP_503' }
		case 'outage':
			return { kind: 'unavailable', reason: 'FETCH_FAILED' }
		case 'deactivated':
			return { kind: 'unavailable', reason: 'RepoDeactivated' }
		case 'returns':
			return at < 36 * HOUR ? gone() : { kind: 'present' }
	}
}

const sites = (Object.keys(GROUPS) as Group[]).flatMap((name) =>
	Array.from({ length: GROUPS[name].count }, (_, index) => ({
		name,
		did: `did:plc:${name.replace('-', '')}${index}`.padEnd(32, 'a').slice(0, 32),
		rkey: 'site',
	})),
)
const groupOf = (did: string) => sites.find((site) => site.did === did)!.name

const redisUrl = process.env.REDIS_URL
if (!redisUrl) throw new Error('REDIS_URL must name an empty, disposable database')
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 0 })
if ((await redis.dbsize()) !== 0) throw new Error('REDIS_URL must name an empty, disposable database')

const retry = await import('../src/lib/quarantine-retry')
const repoAbsence = await import('../src/lib/repo-absence').catch(() => null)
const start = Date.now()
let clock = start

// Hosting's view of site_cache: a live row, a row marked absent, or a tombstone row.
const rows = new Map<string, 'live' | 'absent' | 'tombstone'>(
	sites.filter(({ name }) => name !== 'tombstoned').map(({ did, rkey }) => [`${did}/${rkey}`, 'live']),
)
const repairs: string[] = []

const fail = async (): Promise<never> => {
	throw new Error('unexpected')
}
async function deadLetter(did: string, rkey: string) {
	const fields = ['did', did, 'rkey', rkey, 'reason', 'storage-miss', 'ts', String(start)]
	const id = (await redis.xadd(stream, '*', ...fields))!
	await redis.xreadgroup('GROUP', group, consumer, 'COUNT', 100, 'STREAMS', stream, '>')
	const worker: RevalidateWorkerDependencies = {
		fetchSiteRecord: async () => {
			throw Object.assign(new Error('Failed to download files'), { code: 'FETCH_FAILED' })
		},
		fetchSettingsRecord: fail,
		handleSiteDelete: fail,
		handleSiteCreateOrUpdate: fail,
		handleSettingsUpdate: fail,
		handleSettingsDelete: fail,
	}
	await processRevalidationMessage(id, fields, redis as unknown as RevalidateRedisClient, worker, {
		deliveryAttempt: 3,
		enforceAttemptPolicy: true,
	})
}

const report = Object.fromEntries(
	(Object.keys(GROUPS) as Group[]).map((name) => [
		name,
		{
			sites: GROUPS[name].count,
			probes: 0,
			failClosed503: 0,
			fencedAtEnd: 0,
			notFoundAtEnd: 0,
			firstReleaseHours: null as number | null,
		},
	]),
) as Record<
	Group,
	{
		sites: number
		probes: number
		failClosed503: number
		fencedAtEnd: number
		notFoundAtEnd: number
		firstReleaseHours: number | null
	}
>
const fencedByHour: Record<string, number> = {}

try {
	await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
	await redis.xgroup('CREATECONSUMER', stream, group, consumer)
	for (const { name, did, rkey } of sites) {
		if (GROUPS[name].legacy) await redis.set(revalidationQuarantineKey(did, rkey), '')
		else await deadLetter(did, rkey)
	}
	const deps = {
		redis: redis as unknown as QuarantineRetryRedis,
		target: { stream, group, maxStreamLength: 1_000, dlqStream: config.revalidateDlqStream },
		retries: true,
		// The verified preflight fails the way each PDS fails: RepoNotFound is HTTP_400 (permanent).
		preflight: async (did: string) => {
			const outcome = answer(did, clock - start)
			if (outcome.kind === 'unavailable')
				throw Object.assign(new Error('Failed to download files'), { code: 'FETCH_FAILED' })
			throw new RevalidationProcessingError('HTTP_400', 'permanent')
		},
		classify: classifyRevalidationError,
		recordRetry: () => {},
		repoAbsence: repoAbsence
			? {
					policy: repoAbsence.DEFAULT_REPO_ABSENCE_POLICY,
					probe: async (did: string) => {
						report[groupOf(did)].probes++
						return answer(did, clock - start)
					},
					markSiteAbsent: async (did: string, rkey: string) => {
						const key = `${did}/${rkey}`
						if (rows.get(key) === undefined || rows.get(key) === 'tombstone') return null
						rows.set(key, 'absent')
						return { did, rkey }
					},
					insertMissingSiteTombstone: async (did: string, rkey: string) => {
						if (rows.has(`${did}/${rkey}`)) return false
						rows.set(`${did}/${rkey}`, 'tombstone')
						return true
					},
					clearSiteAbsent: async (did: string, rkey: string) => {
						if (rows.get(`${did}/${rkey}`) !== 'absent') return false
						rows.set(`${did}/${rkey}`, 'live')
						return true
					},
					publishCacheInvalidation: async () => {},
					enqueueRepair: async (did: string, rkey: string) => {
						repairs.push(`${did}/${rkey}`)
						return 'enqueued'
					},
					record: () => {},
				}
			: undefined,
		now: () => clock,
		// Mid-range jitter keeps runs reproducible.
		random: () => 0.5,
	} satisfies QuarantineRetryDependencies

	for (; clock - start <= SIMULATED_MS; clock += TICK_MS) {
		await redis.set(verifiedRepairCapabilityKey(stream, group), `${VERIFIED_REPAIR_PROTOCOL}:${consumer}`, 'EX', 30)
		await redis.xgroup('CREATECONSUMER', stream, group, consumer)
		await retry.runQuarantineRetryTick(deps, new AbortController().signal)
		let fencedNow = 0
		for (const { name, did, rkey } of sites) {
			const fenced = (await redis.exists(revalidationQuarantineKey(did, rkey))) === 1
			if (fenced) {
				fencedNow++
				report[name].failClosed503++
			} else if (report[name].firstReleaseHours === null) {
				report[name].firstReleaseHours = Math.round(((clock - start) / HOUR) * 100) / 100
			}
		}
		const elapsed = clock - start
		if (elapsed % (6 * HOUR) === 0) fencedByHour[`${elapsed / HOUR}h`] = fencedNow
	}
	for (const { name, did, rkey } of sites) {
		const key = `${did}/${rkey}`
		if ((await redis.exists(revalidationQuarantineKey(did, rkey))) === 1) report[name].fencedAtEnd++
		else if (rows.get(key) === 'absent' || rows.get(key) === 'tombstone') report[name].notFoundAtEnd++
	}
	const wronglyReleased = sites.filter(
		({ name, did, rkey }) => !GROUPS[name].gone && name !== 'returns' && rows.get(`${did}/${rkey}`) !== 'live',
	).length
	console.log(
		JSON.stringify(
			{
				mode: repoAbsence ? 'after (repo-absence check present)' : 'before (origin/main)',
				simulatedHours: SIMULATED_MS / HOUR,
				tickMinutes: TICK_MS / MINUTE,
				policy: repoAbsence?.DEFAULT_REPO_ABSENCE_POLICY ?? null,
				fencedSites: fencedByHour,
				groups: report,
				notGoneSitesMarkedAbsent: wronglyReleased,
				repairsEnqueuedForReturnedRepos: repairs.length,
			},
			null,
			2,
		),
	)
} finally {
	await redis.flushdb()
	redis.disconnect()
}
