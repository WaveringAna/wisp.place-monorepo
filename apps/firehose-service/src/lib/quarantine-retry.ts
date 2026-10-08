/**
 * Retries sites fenced by the revalidation dead-letter queue after a transient
 * failure, and reports how many sites are fenced and why.
 *
 * A fence makes hosting fail closed on a cache miss until a newer record
 * version clears it. When a site's latest DLQ record is transient, this job
 * runs the operator's verified repair (site-repair.ts) on a long schedule:
 * fetch and verify every blob from the owner's PDS without writing anything,
 * then enqueue the repair and release the fence in one script that refuses if
 * the fence, reconciled version or quarantine generation moved. The worker
 * then materializes the current record under its lock, or quarantines it
 * again. Permanent or unreadable failures are never retried, and after the
 * last scheduled attempt the fence stays. Leader-only, like the worker.
 */
import { randomUUID } from 'node:crypto'
import { REVALIDATE_QUARANTINE_KEY_PREFIX } from '@wispplace/constants'
import {
	createLogger,
	metricsCollector,
	type RevalidateQuarantineClass,
	type RevalidateQuarantineRetryOutcome,
	type RevalidateQuarantineSnapshot,
} from '@wispplace/observability'
import Redis from 'ioredis'
import { config } from '../config'
import { preflightVerifiedRepair } from './cache-writer'
import {
	assertExactSite,
	assertVerifiedRepairWorker,
	type RepairRedis,
	type RepairTarget,
	readFenceSnapshot,
	releaseFenceAndEnqueueRepair,
} from './site-repair'
import {
	type VerifiedSitePreflight,
	verifiedRepairQuarantineGenerationKey,
	verifiedRepairReceiptKey,
} from './site-repair-protocol'

const logger = createLogger('firehose-service')

/** Delay before each attempt: the first counts from the dead-letter time, the rest from the previous attempt. */
export const QUARANTINE_RETRY_SCHEDULE_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]
export const QUARANTINE_RETRIES_PER_TICK = 5
/** One hash field per site under retry; the leader is its only writer. */
export const QUARANTINE_RETRY_STATE_KEY = 'wisp:revalidate:quarantine-retry'
const TICK_INTERVAL_MS = 5 * 60_000
const FIRST_TICK_DELAY_MS = 2 * 60_000
const SCAN_COUNT = 1_000
const MAX_SCAN_CALLS = 200
const MAX_INSPECTED_FENCES = 5_000
const MAX_RETRY_STATES = 5_000
const INSPECT_CHUNK = 200
const PREFLIGHT_DEADLINE_MS = 5 * 60_000
const PREFLIGHT_TRANSFER_BUDGET_BYTES = 1024 * 1024 * 1024

export interface DeadLetter {
	classification: string
	errorCode: string
	quarantinedAt: number
}

export interface RetryState {
	/** Fence value this schedule belongs to; a different fence without a repair in flight is a new incident. */
	fence: string
	attempts: number
	nextAt: number
	/** Verified-repair token of the attempt in flight. */
	token?: string
	gaveUp?: boolean
}

export interface FencedSite {
	field: string
	did: string
	rkey: string
	fence: string
	generation: string | null
	deadLetter: DeadLetter | null
	state: RetryState | null
}

export interface QuarantineRetryRedis extends RepairRedis {
	scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', limit: number): Promise<[string, string[]]>
	hmget(key: string, ...fields: string[]): Promise<Array<string | null>>
	hscan(key: string, cursor: string, count: 'COUNT', limit: number): Promise<[string, string[]]>
	hset(key: string, field: string, value: string): Promise<number>
	hdel(key: string, ...fields: string[]): Promise<number>
	xlen(key: string): Promise<number>
}

export interface QuarantineRetryDependencies {
	redis: QuarantineRetryRedis
	target: Omit<RepairTarget, 'did' | 'rkey'> & { dlqStream: string }
	/** False keeps the gauges but never touches a fence (WISP_QUARANTINE_RETRY=off). */
	retries: boolean
	preflight(did: string, rkey: string, signal: AbortSignal): Promise<VerifiedSitePreflight>
	classify(error: unknown): { classification: 'permanent' | 'transient'; code: string }
	recordRetry(outcome: RevalidateQuarantineRetryOutcome): void
	now(): number
	random(): number
}

export interface QuarantineRetryTickResult {
	snapshot: RevalidateQuarantineSnapshot
	scanComplete: boolean
	outcomes: Partial<Record<RevalidateQuarantineRetryOutcome, number>>
}

/** MAX_ATTEMPTS is recorded as permanent, but it only means deliveries ran out without a classified failure. */
export function quarantineClass(deadLetter: DeadLetter | null): RevalidateQuarantineClass {
	if (!deadLetter) return 'unknown'
	if (deadLetter.classification === 'transient' || deadLetter.errorCode === 'MAX_ATTEMPTS') return 'transient'
	return deadLetter.classification === 'permanent' ? 'permanent' : 'unknown'
}

/** Scheduled delay before attempt `attempts + 1`, jittered by ±10% so fenced sites spread out. */
export function retryDelayMs(attempts: number, random: () => number): number {
	const base = QUARANTINE_RETRY_SCHEDULE_MS[Math.min(attempts, QUARANTINE_RETRY_SCHEDULE_MS.length - 1)]!
	return Math.round(base * (0.9 + 0.2 * random()))
}

export function parseFenceField(field: string): { did: string; rkey: string } | null {
	const parts = field.split('/')
	if (parts.length !== 2) return null
	try {
		const did = decodeURIComponent(parts[0]!)
		const rkey = decodeURIComponent(parts[1]!)
		assertExactSite(did, rkey)
		return { did, rkey }
	} catch {
		return null
	}
}

function parseRetryState(raw: string | null): RetryState | null {
	if (!raw) return null
	try {
		const value = JSON.parse(raw) as Partial<RetryState>
		if (typeof value.fence !== 'string' || !Number.isSafeInteger(value.attempts) || !Number.isFinite(value.nextAt)) {
			return null
		}
		return value as RetryState
	} catch {
		return null
	}
}

function parseDeadLetter(entry: [string, string[]] | undefined): DeadLetter | null {
	if (!entry) return null
	const fields: Record<string, string> = {}
	for (let index = 0; index + 1 < entry[1].length; index += 2) fields[entry[1][index]!] = entry[1][index + 1]!
	const quarantinedAt = Number(fields.quarantinedAt)
	return {
		classification: fields.classification ?? '',
		errorCode: fields.errorCode ?? '',
		quarantinedAt: Number.isFinite(quarantinedAt) ? quarantinedAt : 0,
	}
}

/** Bounded SCAN of fence keys: at most MAX_SCAN_CALLS round trips of COUNT keys each. */
async function scanFenceFields(redis: QuarantineRetryRedis): Promise<{ fields: string[]; complete: boolean }> {
	const fields = new Set<string>()
	let cursor = '0'
	for (let calls = 0; calls < MAX_SCAN_CALLS; calls++) {
		const [next, keys] = await redis.scan(cursor, 'MATCH', `${REVALIDATE_QUARANTINE_KEY_PREFIX}*`, 'COUNT', SCAN_COUNT)
		for (const key of keys) fields.add(key.slice(REVALIDATE_QUARANTINE_KEY_PREFIX.length))
		cursor = next
		if (cursor === '0') return { fields: [...fields], complete: true }
	}
	return { fields: [...fields], complete: false }
}

async function inspectFences(
	redis: QuarantineRetryRedis,
	dlqStream: string,
	fields: string[],
): Promise<{ sites: FencedSite[]; invalid: number }> {
	const sites: FencedSite[] = []
	let invalid = 0
	for (let start = 0; start < fields.length; start += INSPECT_CHUNK) {
		const chunk = fields.slice(start, start + INSPECT_CHUNK).flatMap((field) => {
			const site = parseFenceField(field)
			if (!site) invalid++
			return site ? [{ field, ...site }] : []
		})
		if (chunk.length === 0) continue
		const [values, states] = await Promise.all([
			redis.mget(
				...chunk.flatMap(({ field, did, rkey }) => [
					REVALIDATE_QUARANTINE_KEY_PREFIX + field,
					verifiedRepairQuarantineGenerationKey(did, rkey),
				]),
			),
			redis.hmget(QUARANTINE_RETRY_STATE_KEY, ...chunk.map(({ field }) => field)),
		])
		const deadLetters = await Promise.all(
			chunk.map((_, index) => {
				const generation = values[index * 2 + 1]
				return generation ? redis.xrange(dlqStream, generation, generation, 'COUNT', 1) : Promise.resolve([])
			}),
		)
		chunk.forEach((site, index) => {
			const fence = values[index * 2]
			// Cleared between SCAN and MGET: no longer fenced.
			if (fence === null || fence === undefined) return
			sites.push({
				...site,
				fence,
				generation: values[index * 2 + 1] ?? null,
				deadLetter: parseDeadLetter(deadLetters[index]?.[0]),
				state: parseRetryState(states[index] ?? null),
			})
		})
	}
	return { sites, invalid }
}

export function summarizeFences(
	sites: FencedSite[],
	uninspected: number,
	dlqEntries: number,
	now: number,
): RevalidateQuarantineSnapshot {
	const fenced: Record<RevalidateQuarantineClass, number> = { transient: 0, permanent: 0, unknown: uninspected }
	let oldest = 0
	for (const site of sites) {
		fenced[quarantineClass(site.deadLetter)]++
		if (site.deadLetter?.quarantinedAt) oldest = Math.max(oldest, now - site.deadLetter.quarantinedAt)
	}
	return { fenced, dlqEntries, oldestFenceAgeSeconds: Math.max(0, Math.floor(oldest / 1000)) }
}

type RecordOutcome = (
	outcome: RevalidateQuarantineRetryOutcome,
	site: { did: string; rkey: string },
	details?: Record<string, unknown>,
) => void

async function saveState(redis: QuarantineRetryRedis, field: string, state: RetryState | null): Promise<void> {
	if (state) await redis.hset(QUARANTINE_RETRY_STATE_KEY, field, JSON.stringify(state))
	else await redis.hdel(QUARANTINE_RETRY_STATE_KEY, field)
}

async function hasReceipt(deps: QuarantineRetryDependencies, token: string): Promise<boolean> {
	return (await deps.redis.get(verifiedRepairReceiptKey(deps.target.stream, token))) !== null
}

/** Resolve a finished attempt, start or end the schedule, and persist only what changed. */
async function advanceFencedSite(
	deps: QuarantineRetryDependencies,
	site: FencedSite,
	record: RecordOutcome,
): Promise<RetryState | null> {
	let state = site.state
	if (state?.token) {
		if (await hasReceipt(deps, state.token)) {
			// Repaired, then fenced again by a later failure: a new incident.
			record('recovered', site)
			state = null
		} else {
			// The worker quarantined the repair again. The attempt was counted when it was enqueued,
			// and the fence now holds the repair's version, so the schedule adopts it.
			record('failed', site, { attempts: state.attempts, errorCode: site.deadLetter?.errorCode })
			state = { fence: site.fence, attempts: state.attempts, nextAt: state.nextAt }
		}
	}
	const retryable = quarantineClass(site.deadLetter) === 'transient'
	if (!state || state.fence !== site.fence) {
		const since = site.deadLetter?.quarantinedAt || deps.now()
		state = retryable ? { fence: site.fence, attempts: 0, nextAt: since + retryDelayMs(0, deps.random) } : null
	} else if (!state.gaveUp && (!retryable || state.attempts >= QUARANTINE_RETRY_SCHEDULE_MS.length)) {
		state = { ...state, gaveUp: true }
		record('gave-up', site, { attempts: state.attempts, errorCode: site.deadLetter?.errorCode })
	}
	if (state !== site.state) await saveState(deps.redis, site.field, state)
	return state
}

/** Retry states whose fence is gone: a repair that completed, or a fence a newer record cleared. */
async function settleUnfencedStates(
	deps: QuarantineRetryDependencies,
	fenced: ReadonlySet<string>,
	record: RecordOutcome,
): Promise<void> {
	const entries: Array<{ field: string; site: { did: string; rkey: string } | null; state: RetryState | null }> = []
	let cursor = '0'
	do {
		const [next, flat] = await deps.redis.hscan(QUARANTINE_RETRY_STATE_KEY, cursor, 'COUNT', INSPECT_CHUNK)
		for (let index = 0; index + 1 < flat.length; index += 2) {
			const field = flat[index]!
			if (!fenced.has(field))
				entries.push({ field, site: parseFenceField(field), state: parseRetryState(flat[index + 1]!) })
		}
		cursor = next
	} while (cursor !== '0' && entries.length < MAX_RETRY_STATES)
	for (let start = 0; start < entries.length; start += INSPECT_CHUNK) {
		const chunk = entries.slice(start, start + INSPECT_CHUNK)
		const fences = await deps.redis.mget(...chunk.map(({ field }) => REVALIDATE_QUARANTINE_KEY_PREFIX + field))
		for (const [index, { field, site, state }] of chunk.entries()) {
			// Fenced beyond this tick's inspection cap: leave it for a later tick.
			if (fences[index] !== null) continue
			if (site && state?.token) {
				if (await hasReceipt(deps, state.token)) {
					record('recovered', site, { attempts: state.attempts })
				} else if (deps.now() < state.nextAt) {
					// Still in the worker; every delay after an attempt outlasts its retries.
					continue
				}
			}
			await saveState(deps.redis, field, null)
		}
	}
}

async function attemptRepair(
	deps: QuarantineRetryDependencies,
	site: FencedSite,
	state: RetryState,
	signal: AbortSignal,
	record: RecordOutcome,
): Promise<void> {
	const { redis } = deps
	const target: RepairTarget = { ...deps.target, did: site.did, rkey: site.rkey }
	const defer = async (details: Record<string, unknown>) => {
		await saveState(redis, site.field, { ...state, nextAt: deps.now() + retryDelayMs(0, deps.random) })
		record('deferred', site, details)
	}
	try {
		await assertVerifiedRepairWorker(redis, target)
	} catch {
		return await defer({ refusal: 'refused-worker' })
	}
	const snapshot = await readFenceSnapshot(redis, site.did, site.rkey)
	if (snapshot.quarantine !== site.fence || snapshot.generation !== site.generation) {
		return record('skipped', site, { refusal: 'changed-fence' })
	}
	const attempts = state.attempts + 1
	let verified: VerifiedSitePreflight
	try {
		verified = await deps.preflight(site.did, site.rkey, signal)
	} catch (error) {
		// A stopping leader is not a failed attempt.
		if (signal.aborted) return
		const failure = deps.classify(error)
		const gaveUp = failure.classification === 'permanent' || attempts >= QUARANTINE_RETRY_SCHEDULE_MS.length
		const next: RetryState = { fence: state.fence, attempts, nextAt: deps.now() + retryDelayMs(attempts, deps.random) }
		await saveState(redis, site.field, gaveUp ? { ...next, gaveUp } : next)
		return record(gaveUp ? 'gave-up' : 'failed', site, { attempts, errorCode: failure.code, stage: 'preflight' })
	}
	if (signal.aborted) return
	const token = randomUUID()
	// Written before the release so a lost reply still counts the attempt and its receipt still proves recovery.
	await saveState(redis, site.field, {
		fence: state.fence,
		attempts,
		nextAt: deps.now() + retryDelayMs(attempts, deps.random),
		token,
	})
	let result: unknown
	try {
		result = await releaseFenceAndEnqueueRepair(redis, target, snapshot, {
			token,
			recordCid: verified.recordCid,
			manifestFingerprint: verified.manifestFingerprint,
		})
	} catch (error) {
		logger.warn(`[QuarantineRetry] Repair enqueue outcome unknown for ${site.did}/${site.rkey}`, {
			errorKind: error instanceof Error ? error.name : 'UnknownError',
		})
		return
	}
	const [status, streamId] = Array.isArray(result) ? result : ['invalid', '']
	if (status === 'enqueued') return record('retrying', site, { attempts, streamId })
	if (typeof status === 'string' && status.startsWith('changed-')) {
		// A newer record or quarantine won the race; leave the fence to it.
		await saveState(redis, site.field, state)
		return record('skipped', site, { refusal: status })
	}
	await defer({ refusal: String(status) })
}

/** One bounded pass: count fences, settle finished repairs, and attempt at most QUARANTINE_RETRIES_PER_TICK sites. */
export async function runQuarantineRetryTick(
	deps: QuarantineRetryDependencies,
	signal: AbortSignal,
): Promise<QuarantineRetryTickResult> {
	const outcomes: QuarantineRetryTickResult['outcomes'] = {}
	const record: RecordOutcome = (outcome, site, details = {}) => {
		outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
		deps.recordRetry(outcome)
		const log = outcome === 'gave-up' || outcome === 'failed' ? logger.warn : logger.info
		log.call(logger, `[QuarantineRetry] ${outcome}: ${site.did}/${site.rkey}`, {
			did: site.did,
			rkey: site.rkey,
			...details,
		})
	}
	const scan = await scanFenceFields(deps.redis)
	const inspected = scan.fields.slice(0, MAX_INSPECTED_FENCES)
	const { sites, invalid } = await inspectFences(deps.redis, deps.target.dlqStream, inspected)
	const snapshot = summarizeFences(
		sites,
		invalid + scan.fields.length - inspected.length,
		await deps.redis.xlen(deps.target.dlqStream),
		deps.now(),
	)
	if (!scan.complete) logger.warn('[QuarantineRetry] Fence scan stopped at its bound; counts are partial')
	if (!deps.retries || signal.aborted) return { snapshot, scanComplete: scan.complete, outcomes }

	await settleUnfencedStates(deps, new Set(sites.map(({ field }) => field)), record)
	const due: Array<{ site: FencedSite; state: RetryState }> = []
	for (const site of sites) {
		const state = await advanceFencedSite(deps, site, record)
		if (state && !state.gaveUp && deps.now() >= state.nextAt) due.push({ site, state })
	}
	due.sort((left, right) => left.state.nextAt - right.state.nextAt)
	for (const { site, state } of due.slice(0, QUARANTINE_RETRIES_PER_TICK)) {
		if (signal.aborted) break
		try {
			await attemptRepair(deps, site, state, signal, record)
		} catch (error) {
			logger.warn(`[QuarantineRetry] Attempt failed before release for ${site.did}/${site.rkey}`, {
				errorKind: error instanceof Error ? error.name : 'UnknownError',
			})
		}
	}
	return { snapshot, scanComplete: scan.complete, outcomes }
}

let timer: ReturnType<typeof setTimeout> | null = null
let controller: AbortController | null = null
let activeTick: Promise<unknown> | null = null
let client: Redis | null = null

/** Leader-only: started and stopped with the revalidation worker, which supplies its failure classifier. */
export function startQuarantineRetry(classify: QuarantineRetryDependencies['classify']): void {
	if (controller || !config.redisUrl) return
	const own = new AbortController()
	controller = own
	const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true, commandTimeout: 5_000 })
	redis.on('error', (error) =>
		logger.warn('[QuarantineRetry] Redis error', { errorKind: error instanceof Error ? error.name : 'UnknownError' }),
	)
	client = redis
	const deps: QuarantineRetryDependencies = {
		redis: redis as unknown as QuarantineRetryRedis,
		target: {
			stream: config.revalidateStream,
			group: config.revalidateGroup,
			maxStreamLength: config.revalidateStreamMaxLen,
			dlqStream: config.revalidateDlqStream,
		},
		retries: process.env.WISP_QUARANTINE_RETRY !== 'off',
		preflight: (did, rkey, signal) =>
			preflightVerifiedRepair(did, rkey, signal, PREFLIGHT_DEADLINE_MS, PREFLIGHT_TRANSFER_BUDGET_BYTES),
		classify,
		recordRetry: (outcome) => metricsCollector.recordRevalidateQuarantineRetry(outcome),
		now: Date.now,
		random: Math.random,
	}
	const schedule = (delayMs: number) => {
		timer = setTimeout(async () => {
			if (own.signal.aborted) return
			activeTick = runQuarantineRetryTick(deps, own.signal)
				.then(({ snapshot, outcomes }) => {
					if (!own.signal.aborted) metricsCollector.setRevalidateQuarantineSnapshot(snapshot)
					if (Object.keys(outcomes).length > 0) logger.info('[QuarantineRetry] Tick complete', { ...outcomes })
				})
				.catch(() => logger.warn('[QuarantineRetry] Tick failed'))
			await activeTick
			activeTick = null
			if (!own.signal.aborted) schedule(TICK_INTERVAL_MS * (0.9 + 0.2 * Math.random()))
		}, delayMs)
		timer.unref?.()
	}
	schedule(FIRST_TICK_DELAY_MS)
}

export async function stopQuarantineRetry(): Promise<void> {
	controller?.abort()
	controller = null
	if (timer) clearTimeout(timer)
	timer = null
	// Disconnect first so a tick waiting on Redis ends now instead of holding up the leader handoff.
	client?.disconnect()
	client = null
	await activeTick?.catch(() => undefined)
	metricsCollector.setRevalidateQuarantineSnapshot(null)
}
