import { createLogger } from '@wispplace/observability'
import { deletePrivateSiteFiles } from './private-site-storage'
import { deletePrivateSite, listExpiredPrivateSites } from './private-sites-db'

const logger = createLogger('main-app')
export const REAPER_INTERVAL_MS = 15 * 60 * 1000
const BATCH_SIZE = 100
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
export const startPrivateSiteReaper = (): ReturnType<typeof setInterval> => {
	void reapExpiredPrivateSites()
	return setInterval(() => void reapExpiredPrivateSites(), REAPER_INTERVAL_MS)
}
