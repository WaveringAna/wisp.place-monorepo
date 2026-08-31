/**
 * Firehose Service - Ingests AT Protocol firehose events and caches sites to S3
 *
 * Modes:
 * - Normal: Watch firehose for place.wisp.fs events
 * - Backfill: Process existing sites discovered from known DIDs
 * - DB Fill Only: Legacy mode; no-op now that site_cache is the canonical projection
 */

import { type ServerType, serve } from '@hono/node-server'
import { createLogger, initializeGrafanaExporters, shutdownGrafanaExporters } from '@wispplace/observability'
import { observabilityErrorHandler, observabilityMiddleware } from '@wispplace/observability/middleware/hono'
import { safeFetchJson } from '@wispplace/safe-fetch'
import { Hono } from 'hono'
import { config } from './config'
import {
	BackfillAbortedError,
	runCancellableWindow,
	scanHydrantDids,
	throwIfBackfillAborted,
} from './lib/backfill-control'
import { closeCacheInvalidationPublisher } from './lib/cache-invalidation'
import { fetchSiteRecord, handleSiteCreateOrUpdate, listSiteRecordsForDid } from './lib/cache-writer'
import { closeDatabase, getSiteCache, listAllKnownDids } from './lib/db'
import {
	getActiveService,
	getCurrentSeq,
	getFirehoseHealth,
	startFirehose,
	stopAndDrainFirehose,
	stopFirehose,
} from './lib/firehose'
import { resolveRevalidationHealth } from './lib/health-policy'
import {
	closeLeaderRedis,
	getLeaderInfo,
	readCursor,
	releaseLeadership,
	runLeaderElection,
	saveDurableCursor,
} from './lib/leader'
import { createRevalidationResourceContext } from './lib/revalidate-resources'
import { getRevalidateWorkerState, startRevalidateWorker, stopRevalidateWorker } from './lib/revalidate-worker'
import { createStartupGate } from './lib/startup-gate'
import { getStorageStatsSnapshot, startStorageStatsRefresh, stopStorageStatsRefresh } from './lib/storage'
import { SupervisorClient } from './lib/supervisor-client'
import { assertSignallableWorkerPid } from './lib/supervisor-config'

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

// Lifecycle state is intentionally separate from the worker's health so the
// health endpoint can report an in-progress drain before the listener closes.
type ServiceLifecycle = 'starting' | 'running' | 'draining' | 'stopped'

let serviceLifecycle: ServiceLifecycle = 'starting'
let isShuttingDown = false
let shutdownPromise: Promise<void> | null = null
let healthServer: ServerType | null = null
let leaderAbortController: AbortController | null = null
let leaderElectionPromise: Promise<void> | null = null
let supervisorClient: SupervisorClient | null = null
let leadershipState: 'disabled' | 'starting' | 'standby' | 'acquired' | 'releasing' | 'released' | 'fatal' = 'disabled'
let cursorSaveTimer: ReturnType<typeof setInterval> | null = null
let cursorSaveInFlight: Promise<boolean> | null = null
let cursorSavingEnabled = false
let revalidateWorkerStartPromise: Promise<void> | null = null
let backfillPromise: Promise<void> | null = null
let backfillAbortController: AbortController | null = null
const firehoseStartGate = createStartupGate()
const BACKFILL_OPERATION_DEADLINE_MS = 5 * 60_000
const BACKFILL_TRANSFER_BUDGET_BYTES = 1024 * 1024 * 1024

function errorKind(error: unknown): string {
	return error instanceof Error && error.name ? error.name : 'UnknownError'
}

function cursorSaveIntervalMs(): number {
	const value = config.cursorSaveIntervalMs
	return Number.isSafeInteger(value) && value > 0 ? value : 5_000
}

/** Serialize periodic cursor writes so shutdown can wait for a stable final save. */
function saveLatestCursor(force = false): Promise<boolean> {
	if (!force && !cursorSavingEnabled) return Promise.resolve(true)
	if (cursorSaveInFlight) {
		const inFlight = cursorSaveInFlight
		if (!force) return inFlight
		// A forced save is the post-drain checkpoint. Wait for any earlier periodic
		// write, then take a fresh cursor snapshot instead of releasing on an old one.
		return inFlight.then(() => {
			if (cursorSaveInFlight === inFlight) cursorSaveInFlight = null
			return saveLatestCursor(true)
		})
	}

	const save = (async () => {
		const seq = getCurrentSeq()
		if (seq === undefined) return true
		return (await saveDurableCursor(seq, getActiveService())).kind === 'saved'
	})().catch((error) => {
		// Do not include the Redis endpoint or error message in application logs.
		logger.warn('[Shutdown] Cursor save failed', { errorKind: errorKind(error) })
		return false
	})

	cursorSaveInFlight = save
	void save.then(() => {
		if (cursorSaveInFlight === save) cursorSaveInFlight = null
	})
	return save
}

function startCursorSaving(): void {
	cursorSavingEnabled = true
	if (cursorSaveTimer) clearInterval(cursorSaveTimer)
	cursorSaveTimer = setInterval(() => {
		void saveLatestCursor()
	}, cursorSaveIntervalMs())
}

async function stopCursorSaving(): Promise<void> {
	cursorSavingEnabled = false
	if (cursorSaveTimer) {
		clearInterval(cursorSaveTimer)
		cursorSaveTimer = null
	}
	const inFlight = cursorSaveInFlight
	await inFlight
	if (cursorSaveInFlight === inFlight) cursorSaveInFlight = null
}

/** Stop accepting new health checks immediately; existing requests may finish. */
function closeHealthServer(): Promise<void> {
	const server = healthServer
	healthServer = null
	if (!server) return Promise.resolve()

	return new Promise((resolve) => {
		try {
			server.close((error) => {
				if (error) logger.warn('[Shutdown] Health server close failed', { errorKind: errorKind(error) })
				resolve()
			})
			// Health has no long-lived protocol. End existing HTTP/1 keep-alive
			// connections too, so close cannot delay resource teardown indefinitely.
			if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
				server.closeAllConnections()
			}
		} catch (error) {
			logger.warn('[Shutdown] Health server close failed', { errorKind: errorKind(error) })
			resolve()
		}
	})
}

// Health endpoint
app.get('/health', (c) => {
	const firehoseHealth = getFirehoseHealth()
	const storageStats = getStorageStatsSnapshot()
	const revalidationState = getRevalidateWorkerState()
	const revalidationConfigured = Boolean(config.redisUrl)
	const workerExpected = !config.leadershipSupervisorEnabled || leadershipState === 'acquired'
	const revalidation = resolveRevalidationHealth(workerExpected, revalidationConfigured, revalidationState)
	const draining = isShuttingDown || firehoseHealth.draining

	// Standby is healthy liveness, but it is never ready to serve as the active
	// ingest worker until the independent supervisor owns both authority locks.
	const standbyHealthy = config.leadershipSupervisorEnabled && leadershipState === 'standby'
	const activeLive = workerExpected && firehoseHealth.healthy && revalidation.live
	const activeReady = activeLive && revalidation.ready
	// Capacity-stat scans are diagnostic. A slow first S3 listing is not an
	// ingest liveness failure. A bounded revalidation reconnect is live but not ready.
	const healthy = !draining && (standbyHealthy || activeLive)
	const ready = !draining && activeReady
	const payload = {
		status: healthy ? ('healthy' as const) : ('degraded' as const),
		lifecycle: draining ? ('draining' as const) : serviceLifecycle,
		ready,
		readiness: ready ? ('ready' as const) : standbyHealthy ? ('standby' as const) : ('not-ready' as const),
		mode: config.isDbFillOnly
			? ('db-fill-only' as const)
			: config.isBackfill
				? ('backfill' as const)
				: ('firehose' as const),
		firehose: firehoseHealth,
		revalidation: {
			enabled: revalidationConfigured && workerExpected,
			configured: revalidationConfigured,
			healthy: revalidation.live,
			ready: revalidation.ready,
			reconnecting: revalidation.reconnecting,
			...revalidationState,
		},
		// Keep the former storage-stat fields at this level for existing callers.
		storage: {
			...(storageStats.stats ?? {}),
			lastSuccessAgeMs: storageStats.lastSuccessAgeMs,
			lastErrorKind: storageStats.lastErrorKind,
			stale: storageStats.stale,
			refreshing: storageStats.refreshing,
		},
		...(config.leaderElection &&
			!config.leadershipSupervisorEnabled && {
				leader: getLeaderInfo(),
			}),
		...(config.leadershipSupervisorEnabled && {
			leadership: {
				state: leadershipState,
				epoch: supervisorClient?.state?.epoch,
				supervisorPid: supervisorClient?.state?.pid,
			},
		}),
	}
	return c.json(payload, healthy ? 200 : 503)
})

async function runShutdownStep(name: string, operation: () => Promise<void>): Promise<void> {
	try {
		await operation()
	} catch (error) {
		// Avoid serializing dependency errors, which can contain endpoints or credentials.
		logger.error(`[Shutdown] ${name} failed`, undefined, { errorKind: errorKind(error) })
	}
}

async function settlesWithinShutdownGrace(work: Promise<void> | null): Promise<boolean> {
	if (!work) return true
	return await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), config.firehoseDrainGraceMs)
		void work.then(
			() => {
				clearTimeout(timer)
				resolve(true)
			},
			() => {
				clearTimeout(timer)
				resolve(false)
			},
		)
	})
}

async function shutdownInternal(signal: string): Promise<void> {
	isShuttingDown = true
	firehoseStartGate.cancel()
	serviceLifecycle = 'draining'
	leadershipState = config.leadershipSupervisorEnabled ? 'releasing' : leadershipState
	logger.info(`Received ${signal}; stopping intake and draining work`)
	stopStorageStatsRefresh()

	// Calling close() synchronously stops new accepts before any potentially long
	// drain. Its completion is awaited before process exit.
	const healthServerClosed = closeHealthServer()
	const firehoseDrain = stopAndDrainFirehose()
	// Stop admitting backfill work before waiting for its fixed worker pool. The
	// signal is also passed to network work that supports RequestInit.signal.
	backfillAbortController?.abort()
	const backfillDrain = settlesWithinShutdownGrace(backfillPromise)

	// No interval can race the final post-drain save. Wait for an already-started
	// save before taking the final cursor snapshot below.
	await stopCursorSaving()
	const [drain, backfillDrained] = await Promise.all([firehoseDrain, backfillDrain])

	// Revalidation is accepted work too. Stop it before releasing the supervisor,
	// so no callback can touch shared dependencies after authority is handed off.
	if (revalidateWorkerStartPromise) {
		await runShutdownStep('revalidation worker startup', () => revalidateWorkerStartPromise ?? Promise.resolve())
	}
	let revalidationWorkerDrained = true
	try {
		revalidationWorkerDrained = (await stopRevalidateWorker({ gracePeriodMs: config.firehoseDrainGraceMs })).stopped
	} catch (error) {
		revalidationWorkerDrained = false
		logger.error('[Shutdown] revalidation worker stop failed', undefined, { errorKind: errorKind(error) })
	}

	// The checkpoint is intentionally saved after accepted site work drains and
	// before we ask the independent supervisor to release either lock.
	const authorityEnabled = config.leaderElection || config.leadershipSupervisorEnabled
	const finalCursorSaved = !authorityEnabled || (await saveLatestCursor(true))

	// The old in-process election loop is retained only for local compatibility.
	// Production uses the child supervisor, which keeps renewing independently.
	leaderAbortController?.abort()
	if (leaderElectionPromise) {
		await leaderElectionPromise.catch((error) => {
			logger.error('[Leader] Election loop stopped with an error', undefined, { errorKind: errorKind(error) })
		})
	}

	if (drain.forced || !backfillDrained || !revalidationWorkerDrained || !finalCursorSaved) {
		logger.error(
			'[Shutdown] Work drain or final cursor save did not complete safely; terminating without closing shared dependencies',
			undefined,
			{
				remainingWork: drain.remainingWork,
				activeHandlers: drain.activeHandlers,
				pendingCursorEvents: drain.pendingCursorEvents,
				backfillDrained,
				revalidationWorkerDrained,
				finalCursorSaved,
			},
		)
		// Do not release the supervisor while a handler can still use shared
		// dependencies. The worker exits; the child observes EOF, fences the (now gone)
		// parent, and releases authority safely.
		serviceLifecycle = 'stopped'
		await runShutdownStep('observability final flush', shutdownGrafanaExporters)
		process.exitCode = 1
		process.exit(1)
		return
	}

	let supervisorReleased = true
	if (config.leadershipSupervisorEnabled && supervisorClient) {
		try {
			const acknowledged = await settlesWithinShutdownGrace(supervisorClient.requestRelease())
			if (!acknowledged) throw new Error('Leadership supervisor release acknowledgement timed out')
			leadershipState = 'released'
		} catch (error) {
			supervisorReleased = false
			logger.error('[Supervisor] Release acknowledgement failed', undefined, { errorKind: errorKind(error) })
		}
	} else if (config.leaderElection) {
		await runShutdownStep('leader release', releaseLeadership)
	}

	await healthServerClosed
	await runShutdownStep('cache publisher close', closeCacheInvalidationPublisher)
	await runShutdownStep('leader Redis close', closeLeaderRedis)
	await runShutdownStep('database close', closeDatabase)

	serviceLifecycle = 'stopped'
	logger.info('Shutdown complete')
	await runShutdownStep('observability final flush', shutdownGrafanaExporters)
	const exitCode = supervisorReleased ? 0 : 1
	process.exitCode = exitCode
	process.exit(exitCode)
}

/** Idempotent signal entry point. Every caller observes the same teardown. */
function shutdown(signal: string): Promise<void> {
	if (!shutdownPromise) shutdownPromise = shutdownInternal(signal)
	return shutdownPromise
}

process.on('SIGINT', () => {
	void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
	void shutdown('SIGTERM')
})

/**
 * Enumerate DIDs from a hydrant indexer.
 *
 * Unlike listAllKnownDids(), which can only rediscover DIDs we already have a
 * row for, hydrant tracks every repo in the network that publishes a
 * place.wisp.* record, so this also surfaces sites we have never seen.
 */
async function listDidsFromHydrant(hydrantUrl: string, signal: AbortSignal): Promise<string[]> {
	const base = hydrantUrl.replace(/\/$/, '')
	return await scanHydrantDids(
		async (cursor, limit, requestSignal) => {
			const params = new URLSearchParams({ limit: String(limit) })
			if (cursor) params.set('cursor', cursor)
			return await safeFetchJson<Array<{ did?: string }>>(`${base}/repos?${params.toString()}`, {
				headers: { Accept: 'application/json' },
				signal: requestSignal,
			})
		},
		{ signal },
	)
}

/**
 * Backfill phase 1+2:
 * - Collect all known DIDs from DB
 * - Discover each DID's place.wisp.fs records directly from the PDS
 */
async function collectSitesFromKnownDids(signal: AbortSignal): Promise<Array<{ did: string; rkey: string }>> {
	let dids: string[]
	if (config.hydrantUrl) {
		logger.info('Phase 1/3: Collecting DIDs from configured hydrant')
		dids = await listDidsFromHydrant(config.hydrantUrl, signal)
		logger.info(`Collected ${dids.length} DIDs from hydrant`)
	} else {
		logger.info('Phase 1/3: Collecting known DIDs')
		dids = await listAllKnownDids()
		throwIfBackfillAborted(signal)
		logger.info(`Collected ${dids.length} known DIDs`)
	}

	if (dids.length === 0) {
		logger.warn('No known DIDs found; skipping site discovery')
		return []
	}

	logger.info('Phase 2/3: Discovering place.wisp.fs records from known DIDs')

	let didsProcessed = 0
	let didsFailed = 0
	let sitesDiscovered = 0
	let sitesFailed = 0
	const discoveredSites = new Map<string, { did: string; rkey: string }>()

	const concurrency = config.backfillConcurrency

	const processDid = async (did: string, workerSignal: AbortSignal) => {
		const resources = createRevalidationResourceContext(
			BACKFILL_OPERATION_DEADLINE_MS,
			BACKFILL_TRANSFER_BUDGET_BYTES,
			workerSignal,
		)
		try {
			throwIfBackfillAborted(workerSignal)
			const records = await listSiteRecordsForDid(did, undefined, resources)
			throwIfBackfillAborted(workerSignal)
			for (const row of records) {
				try {
					discoveredSites.set(`${did}:${row.rkey}`, { did, rkey: row.rkey })
					sitesDiscovered++
				} catch (err) {
					logger.error(`[Backfill:sites] Failed to register site ${did}/${row.rkey}`, undefined, {
						errorKind: errorKind(err),
					})
					sitesFailed++
				}
			}
			didsProcessed++
		} catch (err) {
			if (err instanceof BackfillAbortedError || workerSignal.aborted) return
			logger.error(`[Backfill:sites] Failed to list records for DID ${did}`, undefined, { errorKind: errorKind(err) })
			didsFailed++
		} finally {
			resources.close()
		}
		logger.info(
			`[Backfill:sites] Progress ${didsProcessed + didsFailed}/${dids.length} DIDs (${sitesDiscovered} sites discovered, ${sitesFailed} sites failed)`,
		)
	}

	await runCancellableWindow(dids, concurrency, signal, processDid)
	throwIfBackfillAborted(signal)

	logger.info(
		`Phase 2/3 complete: ${didsProcessed} DIDs processed, ${didsFailed} DIDs failed, ${discoveredSites.size} unique sites discovered, ${sitesFailed} sites failed`,
	)
	return [...discoveredSites.values()]
}

/**
 * Backfill phase 3:
 * - process discovered sites and backfill blobs into S3
 */
async function runBackfill(signal: AbortSignal): Promise<void> {
	throwIfBackfillAborted(signal)
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

	const sites = await collectSitesFromKnownDids(signal)
	throwIfBackfillAborted(signal)

	if (config.isDbFillOnly) {
		logger.info('DB fill only mode enabled; skipping phase 3/3 cache backfill')
		return
	}

	logger.info('Phase 3/3: Backfilling site blobs into S3')

	const concurrency = config.backfillConcurrency
	logger.info(`Found ${sites.length} sites to process (concurrency: ${concurrency})`)

	let processed = 0
	let skipped = 0
	let failed = 0

	const processSite = async (site: { did: string; rkey: string }, workerSignal: AbortSignal) => {
		const resources = createRevalidationResourceContext(
			BACKFILL_OPERATION_DEADLINE_MS,
			BACKFILL_TRANSFER_BUDGET_BYTES,
			workerSignal,
		)
		try {
			throwIfBackfillAborted(workerSignal)
			const result = await fetchSiteRecord(site.did, site.rkey, resources)
			throwIfBackfillAborted(workerSignal)

			if (!result) {
				logger.info(`Site not found on PDS: ${site.did}/${site.rkey}`)
				skipped++
				return
			}

			const existingCache = await getSiteCache(site.did, site.rkey)
			throwIfBackfillAborted(workerSignal)
			if (
				!forceRewriteHtml &&
				!forceDownload &&
				existingCache &&
				result.cid === existingCache.record_cid &&
				existingCache.cold_synced === true
			) {
				logger.info(`Site already up to date: ${site.did}/${site.rkey}`)
				skipped++
				return
			}

			throwIfBackfillAborted(workerSignal)
			await handleSiteCreateOrUpdate(site.did, site.rkey, result.record, result.cid, {
				forceRewriteHtml,
				forceDownload,
				resources,
			})
			throwIfBackfillAborted(workerSignal)
			processed++
		} catch (err) {
			if (err instanceof BackfillAbortedError || workerSignal.aborted) return
			logger.error(`Failed to process ${site.did}/${site.rkey}`, undefined, { errorKind: errorKind(err) })
			failed++
		} finally {
			resources.close()
		}

		logger.info(
			`Progress: ${processed + skipped + failed}/${sites.length} (${processed} processed, ${skipped} skipped, ${failed} failed)`,
		)
	}

	await runCancellableWindow(sites, concurrency, signal, processSite)
	if (signal.aborted) {
		logger.info('Backfill cancelled after admitted work drained')
		return
	}

	const elapsedMs = Date.now() - startTime
	const elapsedSec = Math.round(elapsedMs / 1000)
	const elapsedMin = Math.floor(elapsedSec / 60)
	const elapsedRemSec = elapsedSec % 60
	const elapsedLabel = elapsedMin > 0 ? `${elapsedMin}m ${elapsedRemSec}s` : `${elapsedSec}s`

	logger.info(`Complete: ${processed} processed, ${skipped} skipped, ${failed} failed (${elapsedLabel} elapsed)`)
}

/**
 * Start worker-side intervals only after the supervisor/election callback grants
 * authority. The optional term guard fences an in-flight cursor read or worker
 * startup from a lease which was lost before the await completed.
 */
async function startProtectedWork(
	cursor: number | undefined,
	onFailure: () => void,
	isActive: () => boolean = () => true,
): Promise<boolean> {
	if (isShuttingDown || !isActive()) return false
	revalidateWorkerStartPromise = startRevalidateWorker()
	await revalidateWorkerStartPromise
	if (isShuttingDown || !isActive()) {
		await stopRevalidateWorker({ gracePeriodMs: config.firehoseDrainGraceMs })
		return false
	}
	if (config.leaderElection || config.leadershipSupervisorEnabled) {
		if (!isActive()) {
			await stopRevalidateWorker({ gracePeriodMs: config.firehoseDrainGraceMs })
			return false
		}
		startCursorSaving()
	}
	if (!isActive()) {
		await stopCursorSaving()
		await stopRevalidateWorker({ gracePeriodMs: config.firehoseDrainGraceMs })
		return false
	}
	startFirehose(cursor, onFailure)
	firehoseStartGate.open()
	return true
}

// Main entry point
async function main() {
	logger.info('Starting firehose-service')
	logger.info(`Mode: ${config.isDbFillOnly ? 'db-fill-only' : config.isBackfill ? 'backfill' : 'firehose'}`)
	logger.info('Storage configured', { usingDiskFallback: !config.s3Bucket })

	// Keep the returned Node server so shutdown can stop accepting health checks
	// before it starts its potentially long worker drain.
	healthServer = serve({
		fetch: app.fetch,
		port: config.healthPort,
	})
	startStorageStatsRefresh()
	logger.info('Health server listening', { port: config.healthPort })

	if (config.leadershipSupervisorEnabled) {
		assertSignallableWorkerPid(process.pid)
		leadershipState = 'starting'
		supervisorClient = new SupervisorClient({
			executable: config.supervisorPath,
			onState: (message) => {
				leadershipState = message.state
				if (message.state === 'standby' && !isShuttingDown) serviceLifecycle = 'running'
				if (message.state === 'acquired') {
					logger.info('[Supervisor] Acquired firehose authority', { epoch: message.epoch })
				}
				if (message.state === 'fatal' && !isShuttingDown) void shutdown('leadership supervisor failure')
			},
			onFailure: () => {
				leadershipState = 'fatal'
				if (!isShuttingDown) void shutdown('leadership supervisor process failure')
			},
		})
		await supervisorClient.start()
		const acquired = await supervisorClient.waitForAcquired()
		if (isShuttingDown) return
		let cursor: number | undefined
		try {
			cursor = await readCursor(config.firehoseService)
		} catch (error) {
			logger.error('[Supervisor] Durable cursor read failed', undefined, { errorKind: errorKind(error) })
			void shutdown('durable cursor read failed')
			return
		}
		await startProtectedWork(cursor, () => {
			logger.warn('[Supervisor] Firehose failure threshold reached; draining before release')
			void shutdown('firehose failure threshold reached')
		})
		// Keep the epoch visible in logs without passing authority into worker code.
		logger.info('[Supervisor] Protected worker started', { epoch: acquired.epoch })
	} else if (config.leaderElection) {
		logger.info('In-process leader election enabled; waiting for leadership before starting firehose')
		leaderAbortController = new AbortController()

		leaderElectionPromise = runLeaderElection(
			async (cursor, stepDown, isActive) => {
				await startProtectedWork(
					cursor,
					() => {
						logger.warn('[Leader] Firehose failure threshold reached; requesting drain-aware step-down')
						void stepDown()
					},
					isActive,
				)
			},
			async () => {
				const drain = await stopFirehose()
				const workerStop = await stopRevalidateWorker({ gracePeriodMs: config.firehoseDrainGraceMs })
				await stopCursorSaving()
				if (drain.forced || workerStop.forced) {
					// Do not leave a force-drained process alive with handlers that may
					// still use shared dependencies. shutdown() preserves the safe cursor,
					// lets the lease expire, flushes telemetry, and exits nonzero.
					void shutdown('firehose drain grace period expired')
					return false
				}
				// The in-process election owns its lease until this callback settles.
				return await saveLatestCursor(true)
			},
			leaderAbortController.signal,
			config.firehoseService,
		)
		void leaderElectionPromise.catch((error) => {
			logger.error('[Leader] Election loop fatal error', undefined, { errorKind: errorKind(error) })
			firehoseStartGate.cancel()
			void shutdown('leader election fatal error')
		})
	} else {
		// Single-instance mode: start firehose directly. There is no authority
		// interval to start in this mode.
		await startProtectedWork(undefined, () => {
			logger.warn('[Firehose] Failure threshold reached; draining service')
			void stopAndDrainFirehose().then((drain) => {
				if (drain.forced) void shutdown('firehose drain grace period expired')
			})
		})
	}

	// A standby must not perform the production backfill or claim that the
	// firehose is active before it has acquired leadership and started intake.
	const firehoseStarted = await firehoseStartGate.wait()
	if (!firehoseStarted || isShuttingDown) return
	serviceLifecycle = 'running'

	if (config.isBackfill) {
		// Keep the promise visible to shutdown so DB resources cannot close under it.
		logger.info('Running backfill after firehose intake started')
		backfillAbortController = new AbortController()
		backfillPromise = runBackfill(backfillAbortController.signal).catch((error) => {
			if (backfillAbortController?.signal.aborted && error instanceof BackfillAbortedError) return
			throw error
		})
		await backfillPromise
		backfillAbortController = null
		if (!isShuttingDown) logger.info('Backfill complete; continuing firehose consumption')
	}
}

main().catch((error) => {
	logger.error('Fatal startup error', undefined, { errorKind: errorKind(error) })
	process.exit(1)
})
