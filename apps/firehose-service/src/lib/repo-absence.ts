/**
 * Releases revalidation fences of sites whose owner's repo is gone from its PDS.
 *
 * A fence makes hosting fail closed with 503 on a cache miss, and only a newer
 * record or a verified repair clears it. When the owner's repo was deleted,
 * deactivated for good or moved without its data, neither ever comes, so the
 * site answers 503 forever. This check probes fenced sites that the retry
 * schedule is not working on (it gave up, the failure was permanent, or the
 * fence predates dead-letter generations) by resolving the DID afresh and
 * asking the PDS it names for the record.
 *
 * `RepoNotFound` counts only on separate probes of the same PDS, at least half
 * a probe interval apart, and confirms only after `minChecks` of them spanning
 * `minSpanMs`: a migration or PDS outage can look the same for a while. A
 * different PDS restarts the count, the repo answering resets it, and anything
 * else (5xx, timeouts, RepoDeactivated, RepoTakendown) neither counts nor
 * resets. A DID the PLC directory reports tombstoned (HTTP 410) confirms at
 * once. Confirming marks the site absent the way a confirmed `RecordNotFound`
 * does (hosting serves it like a deleted site), or tombstones a site with no
 * cache row, and then releases the exact fence it saw, so hosting answers 404.
 * Nothing here deletes files or touches domain claims.
 *
 * Confirmed sites stay watched every probe interval: if the repo answers again, the
 * absence mark is cleared and a storage-miss repair is enqueued, so the normal
 * revalidation path materializes the site again.
 */
import { revalidationQuarantineKey } from '@wispplace/constants'
import { createLogger, type RepoAbsenceAction, type RepoAbsenceProbe } from '@wispplace/observability'
import type { RepoProbeOutcome } from './cache-writer'
import type { RepairRedis } from './site-repair'
import { verifiedRepairQuarantineGenerationKey } from './site-repair-protocol'

const logger = createLogger('firehose-service')

const HOUR = 60 * 60_000
/** One hash field per probed site (`<did>/<rkey>`, as in the fence key); the leader is its only writer. */
export const REPO_ABSENCE_STATE_KEY = 'wisp:revalidate:repo-absence'
export const REPO_PROBES_PER_TICK = 10
const MAX_STATES = 5_000
const CHUNK = 200

export interface RepoAbsencePolicy {
	/** RepoNotFound answers needed before a repo counts as gone. */
	minChecks: number
	/** Minimum time between the first and the confirming RepoNotFound. */
	minSpanMs: number
	/** Delay between probes of a site that is not confirmed yet. */
	probeIntervalMs: number
}

export const DEFAULT_REPO_ABSENCE_POLICY: RepoAbsencePolicy = {
	minChecks: 3,
	minSpanMs: 24 * HOUR,
	probeIntervalMs: 8 * HOUR,
}

/**
 * WISP_REPO_ABSENCE_MIN_CHECKS, _MIN_HOURS and _PROBE_HOURS tune the policy.
 * Values below the floors (2 checks, 1 hour, 15 minutes) or unparsable ones
 * keep the default, so a typo can never make one answer enough.
 */
export function repoAbsencePolicyFromEnv(env: Record<string, string | undefined> = process.env): RepoAbsencePolicy {
	const read = (name: string, fallback: number, floor: number) => {
		const value = Number(env[name])
		return env[name] && Number.isFinite(value) && value >= floor ? value : fallback
	}
	return {
		minChecks: Math.floor(read('WISP_REPO_ABSENCE_MIN_CHECKS', DEFAULT_REPO_ABSENCE_POLICY.minChecks, 2)),
		minSpanMs: read('WISP_REPO_ABSENCE_MIN_HOURS', DEFAULT_REPO_ABSENCE_POLICY.minSpanMs / HOUR, 1) * HOUR,
		probeIntervalMs:
			read('WISP_REPO_ABSENCE_PROBE_HOURS', DEFAULT_REPO_ABSENCE_POLICY.probeIntervalMs / HOUR, 0.25) * HOUR,
	}
}

export interface RepoAbsenceState {
	/** PDS that answered every counted RepoNotFound; null before the first, or for a tombstoned DID. */
	pds: string | null
	checks: number
	firstAt: number
	lastAt: number
	nextAt: number
	/** Set once the site was marked absent and its fence released. */
	confirmedAt?: number
}

export interface RepoAbsenceDecision {
	action: RepoAbsenceAction
	state: RepoAbsenceState
}

/** What one probe answer means for a site's absence count. Pure; the caller applies the effects. */
export function decideRepoAbsence(
	state: RepoAbsenceState | null,
	probe: RepoProbeOutcome,
	now: number,
	policy: RepoAbsencePolicy,
): RepoAbsenceDecision {
	const confirmed = state?.confirmedAt !== undefined
	const nextAt = now + policy.probeIntervalMs
	const cleared: RepoAbsenceState = { pds: null, checks: 0, firstAt: 0, lastAt: 0, nextAt }
	const counting = (state?.checks ?? 0) > 0
	switch (probe.kind) {
		case 'present':
			return { action: confirmed ? 'restored' : counting ? 'reset' : 'unchanged', state: cleared }
		case 'record-absent':
			// The repo exists, so it is not gone; a missing record is the absent-site sweeper's business.
			return { action: counting || confirmed ? 'reset' : 'unchanged', state: cleared }
		case 'unavailable':
			return { action: 'unchanged', state: { ...(state ?? cleared), nextAt } }
		case 'did-tombstoned':
			if (confirmed) return { action: 'unchanged', state: { ...state, nextAt } }
			return {
				action: 'confirmed',
				state: {
					pds: null,
					checks: (state?.checks ?? 0) + 1,
					firstAt: state?.firstAt || now,
					lastAt: now,
					nextAt,
					confirmedAt: now,
				},
			}
		case 'repo-absent': {
			if (confirmed) return { action: 'unchanged', state: { ...state, nextAt } }
			if (!state || !counting || state.pds !== probe.pds) {
				return {
					action: counting ? 'reset' : 'counted',
					state: { pds: probe.pds, checks: 1, firstAt: now, lastAt: now, nextAt },
				}
			}
			if (now - state.lastAt < policy.probeIntervalMs / 2) return { action: 'unchanged', state: { ...state, nextAt } }
			const counted = { ...state, checks: state.checks + 1, lastAt: now, nextAt }
			if (counted.checks >= policy.minChecks && now - counted.firstAt >= policy.minSpanMs) {
				return {
					action: 'confirmed',
					state: { ...counted, confirmedAt: now },
				}
			}
			return { action: 'counted', state: counted }
		}
	}
}

export interface RepoAbsenceDependencies {
	policy: RepoAbsencePolicy
	probe(did: string, rkey: string, signal: AbortSignal): Promise<RepoProbeOutcome>
	/** The confirmed-RecordNotFound mark; null when the site has no live cache row. */
	markSiteAbsent(did: string, rkey: string): Promise<unknown | null>
	insertMissingSiteTombstone(did: string, rkey: string): Promise<boolean>
	clearSiteAbsent(did: string, rkey: string): Promise<boolean>
	publishCacheInvalidation(did: string, rkey: string): Promise<void>
	/** Enqueue a storage-miss revalidation through the fence-aware producer script. */
	enqueueRepair(did: string, rkey: string): Promise<string>
	record(probe: RepoAbsenceProbe, action: RepoAbsenceAction): void
}

export interface RepoAbsenceRedis extends Pick<RepairRedis, 'mget' | 'eval'> {
	hmget(key: string, ...fields: string[]): Promise<Array<string | null>>
	hscan(key: string, cursor: string, count: 'COUNT', limit: number): Promise<[string, string[]]>
	hset(key: string, field: string, value: string): Promise<number>
	hdel(key: string, ...fields: string[]): Promise<number>
}

/** A fenced site the retry schedule is not working on, or (fence null) a confirmed site under watch. */
export interface RepoAbsenceSite {
	field: string
	did: string
	rkey: string
	fence: string | null
	generation: string | null
}

/** Delete the fence only if it and its quarantine generation are still exactly what was probed. */
export const RELEASE_ABSENT_REPO_FENCE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local generation = redis.call('GET', KEYS[2])
if (ARGV[2] == '0' and generation ~= false) or (ARGV[2] == '1' and generation ~= ARGV[3]) then return 0 end
redis.call('DEL', KEYS[1])
return 1
`

function parseState(raw: string | null | undefined): RepoAbsenceState | null {
	if (!raw) return null
	try {
		const value = JSON.parse(raw) as Partial<RepoAbsenceState>
		if (!Number.isSafeInteger(value.checks) || !Number.isFinite(value.nextAt) || !Number.isFinite(value.firstAt)) {
			return null
		}
		return value as RepoAbsenceState
	} catch {
		return null
	}
}

async function releaseFence(redis: RepoAbsenceRedis, site: RepoAbsenceSite): Promise<boolean> {
	if (site.fence === null) return true
	const released = await redis.eval(
		RELEASE_ABSENT_REPO_FENCE_SCRIPT,
		2,
		revalidationQuarantineKey(site.did, site.rkey),
		verifiedRepairQuarantineGenerationKey(site.did, site.rkey),
		site.fence,
		site.generation === null ? '0' : '1',
		site.generation ?? '',
	)
	return released === 1
}

/** Mark the site absent (or tombstone a missing row), tell hosting, then release the fence it was probed under. */
async function confirmAbsence(redis: RepoAbsenceRedis, deps: RepoAbsenceDependencies, site: RepoAbsenceSite) {
	const [current] = await redis.mget(revalidationQuarantineKey(site.did, site.rkey))
	if ((current ?? null) !== site.fence) return false
	if ((await deps.markSiteAbsent(site.did, site.rkey)) === null) {
		await deps.insertMissingSiteTombstone(site.did, site.rkey)
	}
	await deps.publishCacheInvalidation(site.did, site.rkey)
	return await releaseFence(redis, site)
}

/** Confirmed states without a fence, and unconfirmed states whose fence is gone (cleared by a newer record). */
async function collectUnfencedStates(
	redis: RepoAbsenceRedis,
	fenced: ReadonlySet<string>,
	parse: (field: string) => { did: string; rkey: string } | null,
): Promise<Array<{ site: RepoAbsenceSite; state: RepoAbsenceState }>> {
	const entries: Array<{ site: RepoAbsenceSite; state: RepoAbsenceState | null }> = []
	let cursor = '0'
	do {
		const [next, flat] = await redis.hscan(REPO_ABSENCE_STATE_KEY, cursor, 'COUNT', CHUNK)
		for (let index = 0; index + 1 < flat.length; index += 2) {
			const field = flat[index]!
			if (fenced.has(field)) continue
			const site = parse(field)
			if (!site) await redis.hdel(REPO_ABSENCE_STATE_KEY, field)
			else entries.push({ site: { field, ...site, fence: null, generation: null }, state: parseState(flat[index + 1]) })
		}
		cursor = next
	} while (cursor !== '0' && entries.length < MAX_STATES)
	const watched: Array<{ site: RepoAbsenceSite; state: RepoAbsenceState }> = []
	for (let start = 0; start < entries.length; start += CHUNK) {
		const chunk = entries.slice(start, start + CHUNK)
		const fences = await redis.mget(...chunk.map(({ site }) => revalidationQuarantineKey(site.did, site.rkey)))
		for (const [index, { site, state }] of chunk.entries()) {
			// Fenced beyond this tick's inspection cap: leave it for a later tick.
			if (fences[index] !== null && fences[index] !== undefined) continue
			if (state?.confirmedAt !== undefined) watched.push({ site, state })
			else await redis.hdel(REPO_ABSENCE_STATE_KEY, site.field)
		}
	}
	return watched
}

export type RepoAbsenceTickOutcomes = Partial<Record<RepoAbsenceAction, number>>

/**
 * One bounded pass: probe at most REPO_PROBES_PER_TICK due sites among `fenced`
 * (sites the retry schedule is not working on) and confirmed sites under watch.
 */
export async function runRepoAbsenceChecks(
	redis: RepoAbsenceRedis,
	deps: RepoAbsenceDependencies,
	fenced: RepoAbsenceSite[],
	parse: (field: string) => { did: string; rkey: string } | null,
	now: () => number,
	signal: AbortSignal,
): Promise<RepoAbsenceTickOutcomes> {
	const outcomes: RepoAbsenceTickOutcomes = {}
	const candidates: Array<{ site: RepoAbsenceSite; state: RepoAbsenceState | null }> = []
	for (let start = 0; start < fenced.length; start += CHUNK) {
		const chunk = fenced.slice(start, start + CHUNK)
		const states = await redis.hmget(REPO_ABSENCE_STATE_KEY, ...chunk.map(({ field }) => field))
		candidates.push(...chunk.map((site, index) => ({ site, state: parseState(states[index]) })))
	}
	candidates.push(...(await collectUnfencedStates(redis, new Set(fenced.map(({ field }) => field)), parse)))
	const due = candidates
		.filter(({ state }) => !state || state.nextAt <= now())
		.sort((left, right) => (left.state?.nextAt ?? 0) - (right.state?.nextAt ?? 0))
		.slice(0, REPO_PROBES_PER_TICK)

	for (const { site, state } of due) {
		if (signal.aborted) break
		const probe = await deps.probe(site.did, site.rkey, signal)
		if (signal.aborted) break
		const decision = decideRepoAbsence(state, probe, now(), deps.policy)
		let { action, state: next } = decision
		const gone = probe.kind === 'repo-absent' || probe.kind === 'did-tombstoned'
		const retryAt = now() + deps.policy.probeIntervalMs
		let errorKind: string | undefined
		if (action === 'confirmed' || (gone && next.confirmedAt !== undefined && site.fence !== null)) {
			// Also re-releases a confirmed site that was fenced again.
			const released = await confirmAbsence(redis, deps, site).catch((error: unknown) => {
				errorKind = error instanceof Error ? error.name : 'UnknownError'
				return false
			})
			action = released ? 'confirmed' : 'refused'
			// Keep the count but not the confirmation, so the next absent answer confirms again.
			if (!released) next = { ...next, confirmedAt: undefined, nextAt: retryAt }
		} else if (action === 'restored') {
			try {
				await deps.clearSiteAbsent(site.did, site.rkey)
				await deps.publishCacheInvalidation(site.did, site.rkey)
				const enqueued = await deps.enqueueRepair(site.did, site.rkey)
				logger.info(`[RepoAbsence] Repo answers again; repair enqueued: ${site.did}/${site.rkey}`, { enqueued })
			} catch (error) {
				errorKind = error instanceof Error ? error.name : 'UnknownError'
				// Stay confirmed so the next probe restores again.
				next = { ...(state ?? next), nextAt: retryAt }
				action = 'refused'
			}
		}
		outcomes[action] = (outcomes[action] ?? 0) + 1
		deps.record(probe.kind, action)
		if (action !== 'unchanged') {
			const log = action === 'refused' ? logger.warn : logger.info
			log.call(logger, `[RepoAbsence] ${action}: ${site.did}/${site.rkey}`, {
				probe: probe.kind,
				checks: next.checks,
				...(errorKind ? { errorKind } : {}),
				...(probe.kind === 'unavailable' ? { reason: probe.reason } : {}),
				...(probe.kind === 'repo-absent' || probe.kind === 'record-absent' ? { pds: probe.pds } : {}),
			})
		}
		await redis.hset(REPO_ABSENCE_STATE_KEY, site.field, JSON.stringify(next))
	}
	return outcomes
}
