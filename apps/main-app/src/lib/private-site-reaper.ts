import { createLogger } from '@wispplace/observability'
import { startPeriodicSingleFlightTask } from './lifecycle'
import { cleanupClaimedPrivateSites } from './private-site-lifecycle'
import { deletePrivateSiteFiles } from './private-site-storage'
import { claimPrivateSitesForReaping, finalizePrivateSiteDeletion } from './private-sites-db'

const logger = createLogger('main-app')
export const REAPER_INTERVAL_MS = 15 * 60 * 1000
export const PRIVATE_SITE_REAPER_CLAIM_TTL_MS = REAPER_INTERVAL_MS
const BATCH_SIZE = 100

const errorKind = (error: unknown): string => {
	if (!(error instanceof Error)) return 'UnknownError'
	return error.constructor.name || 'Error'
}

/**
 * Claims work in the primary database before deleting objects. A failed pass
 * deliberately leaves a `deleting` row, which is invisible to every serving
 * query and becomes eligible again after the claim lease expires.
 */
export const reapExpiredPrivateSites = async (): Promise<{ sites: number; files: number }> => {
	let sites = 0
	let files = 0

	try {
		const claimed = await claimPrivateSitesForReaping(BATCH_SIZE, PRIVATE_SITE_REAPER_CLAIM_TTL_MS)
		const result = await cleanupClaimedPrivateSites(
			claimed,
			{
				removeStorage: deletePrivateSiteFiles,
				finalizeDeletion: finalizePrivateSiteDeletion,
			},
			(siteId, error) =>
				logger.error('[PrivateSite] Failed to reap private site', undefined, {
					siteId,
					errorKind: errorKind(error),
				}),
		)
		sites = result.sites
		files = result.files

		if (sites > 0) {
			logger.info('[PrivateSite] Reaped private sites', { sites, files })
		}
	} catch (error) {
		logger.error('[PrivateSite] Reaper pass failed', undefined, { errorKind: errorKind(error) })
	}

	return { sites, files }
}

export interface PrivateSiteReaper {
	stop(): Promise<void>
	waitForIdle(): Promise<void>
}

/** Starts a local single-flight periodic reaper; DB claims coordinate regions. */
export const startPrivateSiteReaper = (): PrivateSiteReaper => {
	const task = startPeriodicSingleFlightTask(reapExpiredPrivateSites, REAPER_INTERVAL_MS, () =>
		logger.error('[PrivateSite] Reaper task failed'),
	)

	return {
		stop: task.stop,
		waitForIdle: task.waitForIdle,
	}
}
