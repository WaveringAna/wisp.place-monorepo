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
 * Bun's SQL client raises PostgresError both for server errors (SQLSTATE, e.g.
 * `40P01`) and for client-side failures (e.g. `ERR_POSTGRES_CONNECTION_CLOSED`),
 * so the class alone cannot tell a dropped connection from a bad query. Only a
 * short code-shaped value is logged; messages can echo query text.
 */
export const errorCode = (error: unknown): string | undefined => {
	const code = (error as { code?: unknown } | null)?.code
	return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined
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
					errorCode: errorCode(error),
				}),
		)
		sites = result.sites
		files = result.files

		if (sites > 0) {
			logger.info('[PrivateSite] Reaped private sites', { sites, files })
		}
	} catch (error) {
		logger.error('[PrivateSite] Reaper pass failed', undefined, {
			errorKind: errorKind(error),
			errorCode: errorCode(error),
		})
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
