/**
 * Re-checks cached sites the owner's PDS reported as `RecordNotFound`.
 *
 * A mark only ever comes from a confirmed RecordNotFound on the owner's current
 * PDS (resolved through PLC). An unreachable, deactivated or taken-down PDS is a
 * retryable outcome and leaves the site untouched, so an account that is away
 * for months comes back to its site. Purging reuses `handleSiteDelete`, which
 * re-reads the record under the per-site lock before removing anything, and it
 * only ever removes cached files: domain claims are never touched here.
 */
import { createLogger } from '@wispplace/observability'
import { publishCacheInvalidation } from './cache-invalidation'
import { fetchSiteRecordOutcome, handleSiteDelete, type SiteRecordFetchOutcome } from './cache-writer'
import { type AbsentSiteMark, clearSiteAbsent, listAbsentSites, markSiteAbsent } from './db'
import { createRevalidationResourceContext } from './revalidate-resources'

const logger = createLogger('firehose-service')

export const ABSENT_SITE_PURGE_MIN_CHECKS = 3
export const ABSENT_SITE_PURGE_MIN_AGE_SECONDS = 30 * 24 * 60 * 60
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000
const SWEEP_BATCH = 100
const LOOKUP_DEADLINE_MS = 60_000
const LOOKUP_BYTE_BUDGET = 4 * 1024 * 1024

export type AbsentSiteAction = 'restore' | 'count' | 'purge' | 'skip'

/** What one confirmed or unconfirmed lookup means for a marked site. */
export function decideAbsentSiteAction(
	outcome: SiteRecordFetchOutcome,
	markAfterCount: Pick<AbsentSiteMark, 'absent_since' | 'absent_checks'> | null,
	nowSeconds: number,
): AbsentSiteAction {
	if (outcome.kind === 'present') return 'restore'
	if (outcome.kind !== 'absent' || outcome.confirmed !== true) return 'skip'
	if (!markAfterCount) return 'skip'
	const age = nowSeconds - Number(markAfterCount.absent_since)
	return markAfterCount.absent_checks >= ABSENT_SITE_PURGE_MIN_CHECKS && age >= ABSENT_SITE_PURGE_MIN_AGE_SECONDS
		? 'purge'
		: 'count'
}

export interface AbsentSiteSweeperDependencies {
	listAbsentSites: typeof listAbsentSites
	fetchSiteRecordOutcome: typeof fetchSiteRecordOutcome
	markSiteAbsent: typeof markSiteAbsent
	clearSiteAbsent: typeof clearSiteAbsent
	handleSiteDelete: (did: string, rkey: string) => Promise<void>
	publishCacheInvalidation: typeof publishCacheInvalidation
	now: () => number
}

const defaultDependencies: AbsentSiteSweeperDependencies = {
	listAbsentSites,
	fetchSiteRecordOutcome: (did, rkey) => {
		const resources = createRevalidationResourceContext(LOOKUP_DEADLINE_MS, LOOKUP_BYTE_BUDGET)
		return fetchSiteRecordOutcome(did, rkey, resources).finally(() => resources.close())
	},
	markSiteAbsent,
	clearSiteAbsent,
	handleSiteDelete: (did, rkey) => handleSiteDelete(did, rkey),
	publishCacheInvalidation,
	now: () => Math.floor(Date.now() / 1000),
}

export interface AbsentSiteSweepResult {
	checked: number
	restored: number
	counted: number
	purged: number
	skipped: number
}

/** One pass over marked sites, oldest first. Errors on one site never stop the pass. */
export async function sweepAbsentSites(
	signal?: AbortSignal,
	dependencies: AbsentSiteSweeperDependencies = defaultDependencies,
): Promise<AbsentSiteSweepResult> {
	const result: AbsentSiteSweepResult = { checked: 0, restored: 0, counted: 0, purged: 0, skipped: 0 }
	for (const site of await dependencies.listAbsentSites(SWEEP_BATCH)) {
		if (signal?.aborted) break
		result.checked++
		const { did, rkey } = site
		try {
			const outcome = await dependencies.fetchSiteRecordOutcome(did, rkey)
			const confirmedAbsent = outcome.kind === 'absent' && outcome.confirmed === true
			const mark = confirmedAbsent ? await dependencies.markSiteAbsent(did, rkey) : null
			const action = decideAbsentSiteAction(outcome, mark, dependencies.now())
			if (action === 'restore') {
				if (await dependencies.clearSiteAbsent(did, rkey)) {
					await dependencies.publishCacheInvalidation(did, rkey, 'update')
					logger.info(`[AbsentSites] Record is back; serving again: ${did}/${rkey}`)
				}
				result.restored++
			} else if (action === 'purge') {
				await dependencies.handleSiteDelete(did, rkey)
				logger.info(`[AbsentSites] Purged cached files after grace period: ${did}/${rkey}`, {
					absentChecks: mark?.absent_checks,
				})
				result.purged++
			} else if (action === 'count') {
				result.counted++
			} else {
				result.skipped++
			}
		} catch (error) {
			result.skipped++
			logger.warn(`[AbsentSites] Check failed; leaving ${did}/${rkey} as is`, {
				errorKind: error instanceof Error ? error.constructor.name || 'Error' : 'UnknownError',
			})
		}
	}
	return result
}

let timer: ReturnType<typeof setTimeout> | null = null
let controller: AbortController | null = null
let activeSweep: Promise<unknown> | null = null

/** Leader-only: started and stopped with the revalidation worker. */
export function startAbsentSiteSweeper(): void {
	if (controller) return
	const own = new AbortController()
	controller = own
	const schedule = (delayMs: number) => {
		timer = setTimeout(async () => {
			if (own.signal.aborted) return
			activeSweep = sweepAbsentSites(own.signal)
				.then((result) => {
					if (result.checked > 0) logger.info('[AbsentSites] Sweep complete', { ...result })
				})
				.catch(() => logger.warn('[AbsentSites] Sweep failed'))
			await activeSweep
			activeSweep = null
			if (!own.signal.aborted) schedule(SWEEP_INTERVAL_MS)
		}, delayMs)
		timer.unref?.()
	}
	schedule(FIRST_SWEEP_DELAY_MS)
}

export async function stopAbsentSiteSweeper(): Promise<void> {
	controller?.abort()
	controller = null
	if (timer) clearTimeout(timer)
	timer = null
	await activeSweep?.catch(() => undefined)
}
