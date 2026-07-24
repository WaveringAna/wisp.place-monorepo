/**
 * Deletion of expired private sites.
 *
 * Expiry is a promise about data lifetime, not just an access check: once a private site
 * expires, its bytes must actually leave storage rather than merely becoming unreachable.
 * Without this, "expired" sensitive content would persist indefinitely and stay readable
 * by its owner.
 */

import { createLogger } from '@wispplace/observability'
import { deletePrivateSiteFiles } from './private-site-storage'
import { deletePrivateSite, listExpiredPrivateSites } from './private-sites-db'

const logger = createLogger('main-app')

/** How often expired private sites are swept. */
export const REAPER_INTERVAL_MS = 15 * 60 * 1000

/** Maximum sites removed per pass, so one sweep cannot monopolise the process. */
const BATCH_SIZE = 100

/**
 * Delete every private site whose expiry has passed.
 *
 * Storage objects are removed before the database row, so a failure mid-way leaves a row
 * that will be retried on the next pass rather than orphaned bytes with no owner record.
 */
export const reapExpiredPrivateSites = async (): Promise<{ sites: number; files: number }> => {
	let sites = 0
	let files = 0

	try {
		const expired = await listExpiredPrivateSites(BATCH_SIZE)

		for (const site of expired) {
			try {
				files += await deletePrivateSiteFiles(site.siteId)
				await deletePrivateSite(site.siteId)
				sites += 1
			} catch (err) {
				// Leave the row in place; the next sweep retries it.
				logger.error('[PrivateSite] Failed to reap expired site', err, { siteId: site.siteId })
			}
		}

		if (sites > 0) {
			logger.info('[PrivateSite] Reaped expired sites', { sites, files })
		}
	} catch (err) {
		logger.error('[PrivateSite] Reaper pass failed', err)
	}

	return { sites, files }
}

/** Start the periodic sweep. Runs once immediately so a restart clears any backlog. */
export const startPrivateSiteReaper = (): ReturnType<typeof setInterval> => {
	void reapExpiredPrivateSites()
	return setInterval(() => void reapExpiredPrivateSites(), REAPER_INTERVAL_MS)
}
