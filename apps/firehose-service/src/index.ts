/**
 * Firehose Service - Ingests AT Protocol firehose events and caches sites to S3
 *
 * Modes:
 * - Normal: Watch firehose for place.wisp.fs events
 * - Backfill: Process existing sites from database
 * - DB Fill Only: Collect DIDs and backfill sites table (skip S3 writes)
 */

import { serve } from '@hono/node-server'
import { createLogger, initializeGrafanaExporters } from '@wispplace/observability'
import { observabilityErrorHandler, observabilityMiddleware } from '@wispplace/observability/middleware/hono'
import { Hono } from 'hono'
import { config } from './config'
import { closeCacheInvalidationPublisher } from './lib/cache-invalidation'
import { fetchSiteRecord, handleSiteCreateOrUpdate, listSiteRecordsForDid } from './lib/cache-writer'
import { closeDatabase, getSiteCache, listAllKnownDids, listAllSiteCaches, listAllSites, upsertSite } from './lib/db'
import { getActiveService, getCurrentSeq, getFirehoseHealth, startFirehose, stopFirehose } from './lib/firehose'
import { closeLeaderRedis, getLeaderInfo, releaseLeadership, runLeaderElection, saveCursor } from './lib/leader'
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
		...(config.leaderElection && { leader: getLeaderInfo() }),
	})
})

// Graceful shutdown
let isShuttingDown = false
let leaderAbortController: AbortController | null = null
let cursorSaveTimer: ReturnType<typeof setInterval> | null = null

async function shutdown(signal: string) {
	if (isShuttingDown) return
	isShuttingDown = true

	logger.info(`Received ${signal}, shutting down...`)

	if (cursorSaveTimer) clearInterval(cursorSaveTimer)
	leaderAbortController?.abort()
	stopFirehose()
	if (config.leaderElection) await releaseLeadership()
	await stopRevalidateWorker()
	await closeCacheInvalidationPublisher()
	await closeLeaderRedis()
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

	const concurrency = config.backfillConcurrency

	const processDid = async (did: string) => {
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
		} catch (err) {
			logger.error(`[Backfill:sites] Failed to list records for DID ${did}`, err)
			didsFailed++
		}
		logger.info(
			`[Backfill:sites] Progress ${didsProcessed + didsFailed}/${dids.length} DIDs (${sitesSynced} sites synced, ${sitesFailed} sites failed)`,
		)
	}

	const inFlight = new Set<Promise<void>>()
	for (const did of dids) {
		const task = processDid(did).then(() => {
			inFlight.delete(task)
		})
		inFlight.add(task)
		if (inFlight.size >= concurrency) {
			await Promise.race(inFlight)
		}
	}
	await Promise.all(inFlight)

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

	const concurrency = config.backfillConcurrency
	logger.info(`Found ${sites.length} sites in database (concurrency: ${concurrency})`)

	let processed = 0
	let skipped = 0
	let failed = 0

	const processSite = async (site: { did: string; rkey: string }) => {
		try {
			const result = await fetchSiteRecord(site.did, site.rkey)

			if (!result) {
				logger.info(`Site not found on PDS: ${site.did}/${site.rkey}`)
				skipped++
				return
			}

			const existingCache = await getSiteCache(site.did, site.rkey)
			if (!forceRewriteHtml && !forceDownload && existingCache && result.cid === existingCache.record_cid) {
				logger.info(`Site already up to date: ${site.did}/${site.rkey}`)
				skipped++
				return
			}

			await handleSiteCreateOrUpdate(site.did, site.rkey, result.record, result.cid, {
				forceRewriteHtml,
				forceDownload,
			})
			processed++
		} catch (err) {
			logger.error(`Failed to process ${site.did}/${site.rkey}`, err)
			failed++
		}

		logger.info(
			`Progress: ${processed + skipped + failed}/${sites.length} (${processed} processed, ${skipped} skipped, ${failed} failed)`,
		)
	}

	// Sliding window: keep `concurrency` tasks in flight at all times
	const inFlight = new Set<Promise<void>>()
	for (const site of sites) {
		const task = processSite(site).then(() => {
			inFlight.delete(task)
		})
		inFlight.add(task)
		if (inFlight.size >= concurrency) {
			await Promise.race(inFlight)
		}
	}
	await Promise.all(inFlight)

	const elapsedMs = Date.now() - startTime
	const elapsedSec = Math.round(elapsedMs / 1000)
	const elapsedMin = Math.floor(elapsedSec / 60)
	const elapsedRemSec = elapsedSec % 60
	const elapsedLabel = elapsedMin > 0 ? `${elapsedMin}m ${elapsedRemSec}s` : `${elapsedSec}s`

	logger.info(`Complete: ${processed} processed, ${skipped} skipped, ${failed} failed (${elapsedLabel} elapsed)`)
}

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

	await startRevalidateWorker()

	if (config.leaderElection) {
		logger.info('Leader election enabled, waiting to win leadership before starting firehose')
		leaderAbortController = new AbortController()

		// Save cursor to Redis periodically so a new leader can resume from it.
		// Namespaced by the currently-active relay — seq is relay-local.
		cursorSaveTimer = setInterval(async () => {
			const seq = getCurrentSeq()
			if (seq !== undefined) await saveCursor(seq, getActiveService())
		}, config.cursorSaveIntervalMs)

		// Run election loop (non-blocking)
		runLeaderElection(
			(cursor) =>
				startFirehose(cursor, () => {
					logger.warn('Firehose failed 3 times, stepping down from leadership')
					releaseLeadership().finally(() => leaderAbortController?.abort())
				}),
			() => stopFirehose(),
			leaderAbortController.signal,
			config.firehoseService,
		).catch((err) => logger.error('[Leader] Election loop fatal error', err))
	} else {
		// Single-instance mode: start firehose directly
		startFirehose(undefined, () => {
			logger.warn('Firehose failed 3 times, stopping service')
		})
	}

	if (config.isBackfill) {
		// Run backfill while firehose is already consuming events
		logger.info('Running backfill with firehose active')
		await runBackfill()
		logger.info('Backfill complete, continuing firehose consumption')
	}
}

main().catch((err) => {
	logger.error('Fatal error', err)
	process.exit(1)
})
