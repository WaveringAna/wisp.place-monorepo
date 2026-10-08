/**
 * Before/after harness for the quarantine retry schedule on a disposable Redis.
 *
 * Fences two sites with the real worker dead-letter script: one after a
 * transient FETCH_FAILED whose owner PDS recovers after HARNESS_RECOVERS_AFTER_HOURS
 * (default 3; Infinity never recovers),
 * one after a permanent BLOB_SIZE_MISMATCH. Then simulates 48 hours of 5-minute
 * leader ticks on a fake clock, running the real worker on any repair the
 * schedule enqueues and probing each site the way hosting does on a cache miss.
 * Without src/lib/quarantine-retry.ts (origin/main) only the probes run.
 *
 * Usage: REDIS_URL=redis://127.0.0.1:6379/11 NODE_ENV=test bun run scripts/quarantine-retry-harness.ts
 * The database must be empty; it is flushed when the run ends.
 */
import { enqueueSiteRevalidation, revalidationQuarantineKey } from '@wispplace/constants'
import Redis from 'ioredis'
import { config } from '../src/config'
import {
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
const RECOVERS_AFTER_HOURS = Number(process.env.HARNESS_RECOVERS_AFTER_HOURS ?? 3)
const stream = config.revalidateStream
const group = config.revalidateGroup
const consumer = 'quarantine-harness'

const sites = {
	transient: { did: 'did:plc:harnesstransient', rkey: 'site' },
	permanent: { did: 'did:plc:harnesspermanent', rkey: 'site' },
} as const
type SiteName = keyof typeof sites

const redisUrl = process.env.REDIS_URL
if (!redisUrl) throw new Error('REDIS_URL must name an empty, disposable database')
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 0 })
if ((await redis.dbsize()) !== 0) throw new Error('REDIS_URL must name an empty, disposable database')

const retry = await import('../src/lib/quarantine-retry').catch(() => null)
const start = Date.now()
let clock = start
const pdsWorks = (name: SiteName) => name === 'transient' && clock - start >= RECOVERS_AFTER_HOURS * HOUR

const fail = async (): Promise<never> => {
	throw new Error('unexpected')
}
function worker(name: SiteName, recordCid = 'bafyrecord'): RevalidateWorkerDependencies {
	const fetchSiteRecord: RevalidateWorkerDependencies['fetchSiteRecord'] = async () => {
		if (name === 'permanent') throw new RevalidationProcessingError('BLOB_SIZE_MISMATCH', 'permanent')
		if (!pdsWorks(name)) throw Object.assign(new Error('Failed to download files'), { code: 'FETCH_FAILED' })
		return { record: {} as never, cid: recordCid }
	}
	return {
		fetchSiteRecord,
		fetchSettingsRecord: fail,
		handleSiteDelete: fail,
		handleSettingsUpdate: fail,
		handleSettingsDelete: fail,
		handleSiteCreateOrUpdate: async (_did, _rkey, _record, cid, options) => {
			const request = options?.verifiedRepair
			if (request) {
				await options?.onVerifiedRepairComplete?.({
					recordCid: cid,
					manifestFingerprint: request.manifestFingerprint,
					invalidationStreamId: '1-0',
				})
			}
		},
	}
}

async function deliverLast(id: string, fields: string[], name: SiteName) {
	await redis.xreadgroup('GROUP', group, consumer, 'COUNT', 100, 'STREAMS', stream, '>')
	const recordCid = fields[fields.indexOf('repairRecordCid') + 1]
	await processRevalidationMessage(id, fields, redis as unknown as RevalidateRedisClient, worker(name, recordCid), {
		deliveryAttempt: 3,
		enforceAttemptPolicy: true,
	})
}

const report = Object.fromEntries(
	(Object.keys(sites) as SiteName[]).map((name) => [
		name,
		{ probes: 0, failClosedProbes: 0, preflights: 0, repairsRun: 0, fenceClearedAfterHours: null as number | null },
	]),
) as Record<
	SiteName,
	{
		probes: number
		failClosedProbes: number
		preflights: number
		repairsRun: number
		fenceClearedAfterHours: number | null
	}
>
const outcomes: Record<string, number> = {}

try {
	await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
	await redis.xgroup('CREATECONSUMER', stream, group, consumer)
	for (const name of Object.keys(sites) as SiteName[]) {
		const { did, rkey } = sites[name]
		const fields = ['did', did, 'rkey', rkey, 'reason', 'storage-miss', 'ts', String(start)]
		await deliverLast((await redis.xadd(stream, '*', ...fields))!, fields, name)
	}
	const deps = retry && {
		redis: redis as unknown as import('../src/lib/quarantine-retry').QuarantineRetryRedis,
		target: { stream, group, maxStreamLength: 1_000, dlqStream: config.revalidateDlqStream },
		retries: true,
		preflight: async (did: string) => {
			const name = (Object.keys(sites) as SiteName[]).find((key) => sites[key].did === did)!
			report[name].preflights++
			if (!pdsWorks(name)) throw Object.assign(new Error('Failed to download files'), { code: 'FETCH_FAILED' })
			return { recordCid: 'bafyrecord', manifestFingerprint: 'f'.repeat(64), fileCount: 1, totalBytes: 1 }
		},
		classify: (await import('../src/lib/revalidate-worker')).classifyRevalidationError,
		recordRetry: (outcome: string) => {
			outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
		},
		now: () => clock,
		// Mid-range jitter keeps runs reproducible.
		random: () => 0.5,
	}

	for (; clock - start <= SIMULATED_MS; clock += TICK_MS) {
		// The worker capability lease is refreshed by the live worker loop every few seconds.
		await redis.set(verifiedRepairCapabilityKey(stream, group), `${VERIFIED_REPAIR_PROTOCOL}:${consumer}`, 'EX', 30)
		await redis.xgroup('CREATECONSUMER', stream, group, consumer)
		if (retry && deps) await retry.runQuarantineRetryTick(deps, new AbortController().signal)
		for (const [id, fields] of (await redis.xrange(stream, '-', '+')) as Array<[string, string[]]>) {
			const did = fields[fields.indexOf('did') + 1]
			const name = (Object.keys(sites) as SiteName[]).find((key) => sites[key].did === did)!
			report[name].repairsRun++
			await deliverLast(id, fields, name)
		}
		for (const name of Object.keys(sites) as SiteName[]) {
			const { did, rkey } = sites[name]
			const outcome = await enqueueSiteRevalidation(redis, {
				stream: 'harness:hosting-probe',
				maxLen: 1_000_000,
				dedupeTtlSeconds: 1,
				did,
				rkey,
				reason: 'storage-miss',
			})
			report[name].probes++
			if (outcome === 'quarantined') report[name].failClosedProbes++
			const fenced = (await redis.exists(revalidationQuarantineKey(did, rkey))) === 1
			if (!fenced && report[name].fenceClearedAfterHours === null) {
				report[name].fenceClearedAfterHours = Math.round(((clock - start) / HOUR) * 100) / 100
			}
		}
	}
	console.log(
		JSON.stringify(
			{
				mode: retry ? 'after (quarantine retry present)' : 'before (no quarantine retry)',
				simulatedHours: SIMULATED_MS / HOUR,
				tickMinutes: TICK_MS / MINUTE,
				pdsRecoversAfterHours: Number.isFinite(RECOVERS_AFTER_HOURS) ? RECOVERS_AFTER_HOURS : 'never',
				sites: report,
				retryOutcomes: outcomes,
				dlqEntries: await redis.xlen(config.revalidateDlqStream),
			},
			null,
			2,
		),
	)
} finally {
	await redis.flushdb()
	redis.disconnect()
}
