/**
 * Firehose Service - Ingests AT Protocol firehose events and caches sites to S3
 *
 * Modes:
 * - Normal: Watch firehose for place.wisp.fs events
 * - Backfill: Process existing sites from database
 * - DB Fill Only: Collect DIDs and backfill sites table (skip S3 writes)
 */

import { serve } from '@hono/node-server'
import {
	createLogger,
	errorTracker,
	initializeGrafanaExporters,
	logCollector,
	metricsCollector,
} from '@wispplace/observability'
import { observabilityErrorHandler, observabilityMiddleware } from '@wispplace/observability/middleware/hono'
import { Hono } from 'hono'
import { config } from './config'
import { closeCacheInvalidationPublisher } from './lib/cache-invalidation'
import { fetchSiteRecord, handleSiteCreateOrUpdate, listSiteRecordsForDid } from './lib/cache-writer'
import { closeDatabase, getSiteCache, listAllKnownDids, listAllSiteCaches, listAllSites, upsertSite } from './lib/db'
import { getFirehoseHealth, startFirehose, stopFirehose } from './lib/firehose'
import { startRevalidateWorker, stopRevalidateWorker } from './lib/revalidate-worker'
import { storage } from './lib/storage'

// Initialize Grafana exporters if configured
initializeGrafanaExporters({
	serviceName: 'firehose-service',
	serviceVersion: '1.0.0',
})

const logger = createLogger('firehose-service')

const app = new Hono()

// Add observability middleware
app.use('*', observabilityMiddleware('firehose-service'))

// Error handler
app.onError(observabilityErrorHandler('firehose-service'))

// Health endpoint
app.get('/health', async (c) => {
	const firehoseHealth = getFirehoseHealth()
	const storageStats = await storage.getStats()

	return c.json({
		status: firehoseHealth.healthy ? 'healthy' : 'degraded',
		mode: config.isDbFillOnly ? 'db-fill-only' : config.isBackfill ? 'backfill' : 'firehose',
		firehose: firehoseHealth,
		storage: storageStats,
	})
})

// Graceful shutdown
let isShuttingDown = false

async function shutdown(signal: string) {
	if (isShuttingDown) return
	isShuttingDown = true

	logger.info(`Received ${signal}, shutting down...`)

	stopFirehose()
	await stopRevalidateWorker()
	await closeCacheInvalidationPublisher()
	await closeDatabase()

	logger.info('Shutdown complete')
	process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

/**
 * Backfill phase 1+2:
 * - Collect all known DIDs from DB
 * - Backfill each DID's place.wisp.fs records into the sites table
 */
async function backfillSitesTableFromKnownDids(): Promise<void> {
	logger.info('Phase 1/3: Collecting known DIDs')
	const dids = await listAllKnownDids()
	logger.info(`Collected ${dids.length} known DIDs`)

	if (dids.length === 0) {
		logger.warn('No known DIDs found; skipping sites table backfill')
		return
	}

	logger.info('Phase 2/3: Backfilling place.wisp.fs records into sites table')

	let didsProcessed = 0
	let didsFailed = 0
	let sitesSynced = 0
	let sitesFailed = 0

	for (const did of dids) {
		try {
			const records = await listSiteRecordsForDid(did)
			for (const row of records) {
				try {
					const siteName =
						typeof row.record.site === 'string' && row.record.site.length > 0 ? row.record.site : row.rkey
					await upsertSite(did, row.rkey, siteName)
					sitesSynced++
				} catch (err) {
					logger.error(`[Backfill:sites] Failed to upsert site ${did}/${row.rkey}`, err)
					sitesFailed++
				}
			}
			didsProcessed++
			logger.info(`[Backfill:sites] Progress ${didsProcessed + didsFailed}/${dids.length} DIDs`)
		} catch (err) {
			logger.error(`[Backfill:sites] Failed to list records for DID ${did}`, err)
			didsFailed++
		}
	}

	logger.info(
		`Phase 2/3 complete: ${didsProcessed} DIDs processed, ${didsFailed} DIDs failed, ${sitesSynced} sites synced, ${sitesFailed} sites failed`,
	)
}

/**
 * Backfill phase 3:
 * - process sites from database and backfill blobs into S3
 */
async function runBackfill(): Promise<void> {
	logger.info('Starting backfill mode')
	const startTime = Date.now()
	const forceRewriteHtml = process.env.BACKFILL_FORCE_REWRITE_HTML === 'true'
	const forceDownload = process.env.BACKFILL_FORCE_DOWNLOAD === 'true'

	if (forceRewriteHtml) {
		logger.info('Forcing HTML rewrite for all sites')
	}
	if (forceDownload) {
		logger.info('Forcing full file download/write for all backfilled sites')
	}

	await backfillSitesTableFromKnownDids()

	if (config.isDbFillOnly) {
		logger.info('DB fill only mode complete; skipping phase 3/3 S3 backfill')
		return
	}

	logger.info('Phase 3/3: Backfilling site blobs into S3')

	let sites = await listAllSites()
	if (sites.length === 0) {
		const cachedSites = await listAllSiteCaches()
		sites = cachedSites.map((site) => ({ did: site.did, rkey: site.rkey }))
		logger.info('Sites table empty; falling back to site_cache entries')
	}

	logger.info(`Found ${sites.length} sites in database`)

	let processed = 0
	let skipped = 0
	let failed = 0

	for (const site of sites) {
		try {
			// Fetch current record from PDS
			const result = await fetchSiteRecord(site.did, site.rkey)

			if (!result) {
				logger.info(`Site not found on PDS: ${site.did}/${site.rkey}`)
				skipped++
				continue
			}

			const existingCache = await getSiteCache(site.did, site.rkey)
			// Check if CID matches (already up to date)
			if (!forceRewriteHtml && !forceDownload && existingCache && result.cid === existingCache.record_cid) {
				logger.info(`Site already up to date: ${site.did}/${site.rkey}`)
				skipped++
				continue
			}

			// Process the site
			await handleSiteCreateOrUpdate(site.did, site.rkey, result.record, result.cid, {
				forceRewriteHtml,
				forceDownload,
			})
			processed++

			logger.info(`Progress: ${processed + skipped + failed}/${sites.length}`)
		} catch (err) {
			logger.error(`Failed to process ${site.did}/${site.rkey}`, err)
			failed++
		}
	}

	const elapsedMs = Date.now() - startTime
	const elapsedSec = Math.round(elapsedMs / 1000)
	const elapsedMin = Math.floor(elapsedSec / 60)
	const elapsedRemSec = elapsedSec % 60
	const elapsedLabel = elapsedMin > 0 ? `${elapsedMin}m ${elapsedRemSec}s` : `${elapsedSec}s`

	logger.info(`Complete: ${processed} processed, ${skipped} skipped, ${failed} failed (${elapsedLabel} elapsed)`)
}

// Internal observability endpoints (for admin panel)
app.get('/__internal__/observability/logs', (c) => {
	const query = c.req.query()
	const filter: any = {}
	if (query.level) filter.level = query.level
	if (query.service) filter.service = query.service
	if (query.search) filter.search = query.search
	if (query.eventType) filter.eventType = query.eventType
	if (query.limit) filter.limit = parseInt(query.limit as string, 10)
	return c.json({ logs: logCollector.getLogs(filter) })
})

app.get('/__internal__/observability/errors', (c) => {
	const query = c.req.query()
	const filter: any = {}
	if (query.service) filter.service = query.service
	if (query.limit) filter.limit = parseInt(query.limit as string, 10)
	return c.json({ errors: errorTracker.getErrors(filter) })
})

app.get('/__internal__/observability/metrics', (c) => {
	const query = c.req.query()
	const timeWindow = query.timeWindow ? parseInt(query.timeWindow as string, 10) : 3600000
	const stats = metricsCollector.getStats('firehose-service', timeWindow)
	return c.json({ stats, timeWindow })
})

// Main entry point
async function main() {
	logger.info('Starting firehose-service')
	logger.info(`Mode: ${config.isDbFillOnly ? 'db-fill-only' : config.isBackfill ? 'backfill' : 'firehose'}`)
	logger.info(`S3 Bucket: ${config.s3Bucket || '(disk fallback)'}`)

	// Start health server
	const _server = serve({
		fetch: app.fetch,
		port: config.healthPort,
	})

	logger.info(`Health endpoint: http://localhost:${config.healthPort}/health`)

	if (config.isBackfill) {
		// Run backfill and exit
		await runBackfill()
		await closeDatabase()
		process.exit(0)
	} else {
		// Start firehose
		startFirehose()
		await startRevalidateWorker()
	}
}

main().catch((err) => {
	logger.error('Fatal error', err)
	process.exit(1)
})
