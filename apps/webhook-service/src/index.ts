import { onceAsync, remainingShutdownTimeout, settleBeforeDeadline } from '@wispplace/graceful-shutdown'
import { createLogger, shutdownGrafanaExporters } from '@wispplace/observability'
import { config } from './config'
import {
	createReconciliationRetryScheduler,
	type ReconciliationRetryScheduler,
	runStartupBackfill,
} from './lib/backfill'
import * as database from './lib/db'
import * as delivery from './lib/delivery'
import {
	drainFirehose,
	getFirehoseHealth,
	refreshRegistryFromDatabase,
	refreshRegistryOwnerFromDatabase,
	startFirehose,
	stopFirehose,
} from './lib/firehose'
import { isWebhookServingReady } from './lib/readiness'
import { closeRedisPublisher, getRedisPublisherHealth } from './lib/redis'
import { canCloseSharedClients } from './lib/shutdown-policy'

const logger = createLogger('webhook-service')

type LifecyclePhase = 'starting' | 'reconciling-live' | 'live' | 'stopping' | 'stopped' | 'failed'

type HealthServer = ReturnType<typeof Bun.serve>

let healthServer: HealthServer | null = null
let startupPromise: Promise<void> | null = null
let phase: LifecyclePhase = 'starting'
let startupBackfill = { found: 0, failed: 0 }
let reconciliationRetryScheduler: ReconciliationRetryScheduler | null = null
let reconciliationSchedulerStartPromise: Promise<void> | null = null
let lastReconciliationSuccessAt: number | undefined
let initialBackfillRunning = false
let initialBackfillPromise: Promise<void> | null = null
// The bounded DB registry bootstrap can still be in flight before the detached
// initial PDS reconciliation promise exists.
let registryBootstrapPromise: Promise<void> | null = null
// Delivery/firehose startup has asynchronous cursor and transport work too.
let intakeStartupPromise: Promise<void> | null = null
let backfillInfrastructureHealthy = true
let backgroundBackfillStopped = false
let reconciliationAbortController: AbortController | null = null
let reconciliationGeneration = 0
let initialBackfillContinuationPending = false
let initialBackfillPasses = 0
let initialBackfillScanned = 0
let lastInitialBackfillCompletedAt: number | undefined
let initialBackfillRetryAttempt = 0

function cursorAgeSeconds(value: number | undefined): number | undefined {
	return value === undefined ? undefined : boundedNumber(Math.floor(value / 1000))
}

function boundedNumber(value: unknown): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0
}

async function reconciliationHealth(): Promise<{
	scanning: number
	failed: number
	retryInfrastructureHealthy: boolean
}> {
	const retryHealth = reconciliationRetryScheduler?.health
	// A pending or stopped scheduler is not ready. This prevents the
	// reconciling-live phase from briefly masking a stuck scheduler startup.
	const retryInfrastructureHealthy = retryHealth?.running === true && retryHealth.infrastructureHealthy
	const api = database as typeof database & {
		getWebhookOwnerReconciliationHealth?: () => Promise<{ scanning: number; failed: number }>
	}
	if (!api.getWebhookOwnerReconciliationHealth) {
		return { scanning: 0, failed: startupBackfill.failed, retryInfrastructureHealthy }
	}
	try {
		const status = await api.getWebhookOwnerReconciliationHealth()
		return {
			scanning: boundedNumber(status.scanning),
			failed: boundedNumber(status.failed),
			retryInfrastructureHealthy,
		}
	} catch {
		// A DB outage makes readiness degraded without disclosing its error.
		return { scanning: 1, failed: Math.max(1, startupBackfill.failed), retryInfrastructureHealthy: false }
	}
}

async function healthResponse(): Promise<Response> {
	const intake = getFirehoseHealth()
	const redis = getRedisPublisherHealth()
	const reconciliation = await reconciliationHealth()
	// A single owner may be unavailable or still retrying without making the
	// whole service unable to serve other tenants. Keep those counts visible in
	// the response, but gate readiness only on lifecycle, intake, and shared
	// infrastructure health.
	const healthy = isWebhookServingReady({
		phase,
		intakeHealthy: intake.healthy,
		backfillInfrastructureHealthy,
		retryInfrastructureHealthy: reconciliation.retryInfrastructureHealthy,
	})
	const body = {
		status: healthy ? 'healthy' : 'degraded',
		phase,
		// Counts and booleans only. Do not expose records, DIDs, URLs, cursors, or errors.
		backfill: {
			running: initialBackfillRunning,
			continuationPending: initialBackfillContinuationPending,
			passes: boundedNumber(initialBackfillPasses),
			scanned: boundedNumber(initialBackfillScanned),
			infrastructureHealthy: backfillInfrastructureHealthy,
			found: boundedNumber(startupBackfill.found),
			failed: reconciliation.failed,
			scanning: reconciliation.scanning,
			retryInfrastructureHealthy: reconciliation.retryInfrastructureHealthy,
			lastSuccessAt: lastReconciliationSuccessAt,
			lastInitialCompletionAt: lastInitialBackfillCompletedAt,
		},
		redis: {
			configured: redis.configured,
			connected: redis.connected,
			dropped: boundedNumber(redis.dropped),
		},
		intake: {
			connected: intake.connected,
			// Socket state and durable progress differ under bounded backpressure.
			progressing: intake.directProgressing && intake.backlinkProgressing && intake.registryProgressing,
			started: intake.started,
			queued: Math.min(intake.queued, config.intakeQueueMax),
			directConnected: intake.directConnected,
			backlinkConnected: intake.backlinkConnected,
			// Relay replay is finite: a cursor age approaching it loses events.
			cursorAgeSeconds: {
				direct: cursorAgeSeconds(intake.cursorAgeMs.direct),
				backlink: cursorAgeSeconds(intake.cursorAgeMs.backlink),
				registry: cursorAgeSeconds(intake.cursorAgeMs.registry),
			},
			admissionLimits: intake.admissionLimits,
			streamFailures: intake.streamFailures,
		},
	}
	return Response.json(body, { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}

/** The only HTTP listener. It intentionally has no diagnostic/admin routes. */
export function startHealthServer(): HealthServer {
	if (healthServer) return healthServer
	healthServer = Bun.serve({
		hostname: config.healthHost,
		port: config.healthPort,
		async fetch(request) {
			const url = new URL(request.url)
			if (request.method === 'GET' && url.pathname === '/health') return healthResponse()
			if (request.method === 'GET' && url.pathname === '/live') {
				return Response.json(
					{ status: phase === 'stopping' || phase === 'stopped' || phase === 'failed' ? 'stopping' : 'live' },
					{ status: phase === 'failed' ? 503 : 200 },
				)
			}
			return new Response('Not Found', { status: 404 })
		},
	})
	return healthServer
}

async function startDeliveryWorker(): Promise<void> {
	const api = delivery as typeof delivery & { startWebhookDeliveryWorker?: () => Promise<void> | void }
	if (!api.startWebhookDeliveryWorker) throw new Error('Durable webhook delivery worker is unavailable')
	await api.startWebhookDeliveryWorker()
}

async function drainAndStopDeliveryWorker(timeoutMs = config.shutdownTimeoutMs): Promise<boolean> {
	const api = delivery as typeof delivery & {
		drainWebhookDeliveryWorker?: (timeoutMs?: number) => Promise<boolean>
		stopWebhookDeliveryWorker?: (timeoutMs?: number) => Promise<boolean> | boolean
	}
	// stop() owns the bounded grace period and then aborts active pinned attempts.
	// Do not run a separate full drain first or it can consume the abort budget.
	if (api.stopWebhookDeliveryWorker) return (await api.stopWebhookDeliveryWorker(timeoutMs)) !== false
	return api.drainWebhookDeliveryWorker ? await api.drainWebhookDeliveryWorker(timeoutMs) : true
}

function waitForBackfillRetry(signal: AbortSignal, attempt: number): Promise<void> {
	const exponent = Math.min(attempt, config.initialBackfillRetryMaxExponent)
	const ceiling = Math.min(config.initialBackfillRetryMaxMs, config.initialBackfillRetryMinMs * 2 ** exponent)
	const delay = Math.max(1, Math.floor(Math.random() * ceiling))
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, delay)
		const abort = () => {
			clearTimeout(timer)
			resolve()
		}
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
	})
}

async function closeBeforeDeadline(
	task: Promise<void>,
	deadline: number,
	timedOutMessage: string,
	failedMessage: string,
): Promise<void> {
	const result = await settleBeforeDeadline(task, deadline)
	if (result.status === 'timed-out') logger.warn(timedOutMessage)
	else if (result.status === 'rejected') logger.warn(failedMessage)
}

function ensureReconciliationRetryScheduler(
	onOwnerTransition: (did: string, status: 'scanning' | 'complete' | 'failed') => Promise<void>,
): Promise<void> {
	if (reconciliationRetryScheduler || backgroundBackfillStopped) return Promise.resolve()
	if (reconciliationSchedulerStartPromise) return reconciliationSchedulerStartPromise
	const scheduler = createReconciliationRetryScheduler({ onOwnerTransition })
	reconciliationSchedulerStartPromise = scheduler
		.start()
		.then(async () => {
			if (backgroundBackfillStopped) {
				await scheduler.stop({ timeoutMs: config.shutdownTimeoutMs })
				return
			}
			reconciliationRetryScheduler = scheduler
		})
		.finally(() => {
			reconciliationSchedulerStartPromise = null
		})
	return reconciliationSchedulerStartPromise
}

async function launchInitialBackfill(
	onOwnerTransition: (did: string, status: 'scanning' | 'complete' | 'failed') => Promise<void>,
): Promise<void> {
	const signal = reconciliationAbortController?.signal
	const generation = reconciliationGeneration
	if (!signal) {
		initialBackfillRunning = false
		return
	}
	const active = () => !backgroundBackfillStopped && !signal.aborted && reconciliationGeneration === generation
	initialBackfillRunning = true
	let startAfter: string | undefined
	let continuationLoaded = false
	let completedScanned = 0
	try {
		while (active()) {
			try {
				// Loading the durable continuation is part of the retryable controller,
				// not a pre-flight await that can wedge the detached lifecycle promise.
				if (!continuationLoaded) {
					startAfter = await database.loadWebhookBackfillContinuation()
					if (!active()) return
					continuationLoaded = true
				}
				let passScanned = 0
				const result = await runStartupBackfill({
					onOwnerTransition,
					startAfter,
					signal,
					onProgress: async (progress) => {
						if (!active()) return
						// The source reports cumulative pass progress. Replace the in-flight
						// portion rather than adding it on every page callback.
						passScanned = boundedNumber(progress.scanned)
						initialBackfillScanned = Math.min(1_000_000, completedScanned + passScanned)
						if (progress.nextOwnerCursor) {
							// Persist after each fully reconciled keyset page. If a later page
							// fails, replay starts at this durable boundary, never at process start.
							await database.saveWebhookBackfillContinuation(progress.nextOwnerCursor)
							if (!active()) return
							startAfter = progress.nextOwnerCursor
							initialBackfillContinuationPending = true
						} else {
							initialBackfillContinuationPending = progress.capped
						}
					},
				})
				if (!active()) return
				initialBackfillPasses++
				completedScanned = Math.min(1_000_000, completedScanned + passScanned)
				initialBackfillScanned = completedScanned
				initialBackfillRetryAttempt = 0
				backfillInfrastructureHealthy = true
				startupBackfill = {
					found: Math.min(1_000_000, startupBackfill.found + boundedNumber(result.found)),
					failed: Math.min(1_000_000, startupBackfill.failed + boundedNumber(result.failed)),
				}
				if (!active()) return
				if (result.nextOwnerCursor) {
					initialBackfillContinuationPending = true
					await database.saveWebhookBackfillContinuation(result.nextOwnerCursor)
					if (!active()) return
					startAfter = result.nextOwnerCursor
					continue
				}
				await ensureReconciliationRetryScheduler(onOwnerTransition)
				if (!active()) return
				// Clear only after the last page and post-scan state are durable.
				await database.clearWebhookBackfillContinuation()
				if (!active()) return
				initialBackfillContinuationPending = false
				lastInitialBackfillCompletedAt = Date.now()
				phase = 'live'
				return
			} catch {
				if (!active()) return
				// Keep live registry intake running and retry the bounded current page.
				// Do not abandon an infrastructure-failed initial reconciliation.
				backfillInfrastructureHealthy = false
				initialBackfillContinuationPending = true
				try {
					// Failed/stale owners continue independently as soon as the DB is reachable.
					await ensureReconciliationRetryScheduler(onOwnerTransition)
					if (!active()) return
				} catch {
					// The bounded initial retry below also recovers scheduler bootstrap.
				}
				if (!active()) return
				await waitForBackfillRetry(signal, initialBackfillRetryAttempt++)
			}
		}
	} finally {
		initialBackfillRunning = false
	}
}

async function runMain(): Promise<void> {
	startHealthServer()
	phase = 'starting'
	const onOwnerTransition = async (did: string, status: 'scanning' | 'complete' | 'failed') => {
		if (backgroundBackfillStopped) return
		if (status === 'complete') lastReconciliationSuccessAt = Date.now()
		// Reconciliation transitions swap only this owner's bounded active rows.
		// A full registry scan per owner is both stale-prone and O(owners × rows).
		await refreshRegistryOwnerFromDatabase(did)
	}
	// Start durable live registry intake immediately from its cursor (or retained
	// cursor zero). Reconciliation runs afterwards under DB live-event fences.
	const bootstrap = refreshRegistryFromDatabase()
	registryBootstrapPromise = bootstrap
	try {
		await bootstrap
	} finally {
		if (registryBootstrapPromise === bootstrap) registryBootstrapPromise = null
	}
	if (backgroundBackfillStopped) return
	const intakeStartup = (async () => {
		await startDeliveryWorker()
		if (backgroundBackfillStopped) {
			await drainAndStopDeliveryWorker(config.shutdownTimeoutMs)
			return
		}
		await startFirehose()
		if (backgroundBackfillStopped) stopFirehose()
	})()
	intakeStartupPromise = intakeStartup
	try {
		await intakeStartup
	} finally {
		if (intakeStartupPromise === intakeStartup) intakeStartupPromise = null
	}
	if (backgroundBackfillStopped) return
	reconciliationAbortController = new AbortController()
	void ensureReconciliationRetryScheduler(onOwnerTransition).catch(() => {
		if (!backgroundBackfillStopped) backfillInfrastructureHealthy = false
	})
	initialBackfillRunning = true // Set before exposing reconciling-live readiness.
	phase = 'reconciling-live'
	initialBackfillPromise = launchInitialBackfill(onOwnerTransition).catch(() => {
		// A final guard for programming errors outside the retry controller.
		backfillInfrastructureHealthy = false
		initialBackfillRunning = false
	})
	void initialBackfillPromise
	logger.info('Webhook service started')
}

export function main(): Promise<void> {
	if (!startupPromise) {
		startupPromise = runMain().catch(async (error) => {
			phase = 'failed'
			await shutdown('startup failure')
			throw error
		})
	}
	return startupPromise
}

/**
 * Idempotent, ordered shutdown used by signals and tests. Returns false if a
 * bounded cleanup left a producer active. Signal handlers use
 * that result as a generic non-zero exit status instead of closing shared clients
 * underneath the outstanding work.
 */
const runShutdown = onceAsync(async (signal: string): Promise<boolean> => {
	const shutdownDeadline = Date.now() + config.shutdownTimeoutMs
	// During early startup the registry snapshot is the active reconciliation
	// producer; afterwards the detached PDS backfill owns that role.
	const initialBackfill = initialBackfillPromise ?? registryBootstrapPromise ?? intakeStartupPromise
	phase = 'stopping'
	backgroundBackfillStopped = true
	reconciliationGeneration++
	const abortController = reconciliationAbortController
	reconciliationAbortController = null
	const scheduler = reconciliationRetryScheduler
	const schedulerStart = reconciliationSchedulerStartPromise
	reconciliationRetryScheduler = null
	// Begin cancellation now, but do not let PDS retry draining delay stopping
	// intake. It is awaited at a bounded point after accepted relay work drains.
	const schedulerStop = scheduler?.stop({
		timeoutMs: remainingShutdownTimeout(shutdownDeadline),
		...(abortController ? { signal: abortController.signal } : {}),
	})
	abortController?.abort()
	logger.info(`Webhook service stopping (${signal})`)

	// Stop the unauthenticated HTTP surface first, then stop accepting relay work.
	if (healthServer) {
		try {
			healthServer.stop(true)
		} catch {
			// Listener may already be stopped by a concurrent signal.
		}
		healthServer = null
	}
	stopFirehose()
	const initialBackfillResult = await settleBeforeDeadline(initialBackfill, shutdownDeadline)
	const initialBackfillSettled = initialBackfillResult.status !== 'timed-out'
	if (!initialBackfillSettled) logger.warn('Initial reconciliation did not settle before shutdown deadline')

	let intakeDrained = false
	const intakeDrain = drainFirehose(remainingShutdownTimeout(shutdownDeadline))
	const intakeDrainResult = await settleBeforeDeadline(intakeDrain, shutdownDeadline)
	if (intakeDrainResult.status === 'timed-out') {
		logger.warn('Webhook intake drain timed out; unfinished events remain behind their cursor')
	} else if (intakeDrainResult.status === 'rejected') {
		logger.warn('Webhook intake drain failed; unfinished events remain behind their cursor')
	} else {
		intakeDrained = intakeDrainResult.value
		if (!intakeDrained) logger.warn('Webhook intake drain timed out; unfinished events remain behind their cursor')
	}

	let deliveryStopped = false
	const deliveryStop = drainAndStopDeliveryWorker(remainingShutdownTimeout(shutdownDeadline))
	const deliveryStopResult = await settleBeforeDeadline(deliveryStop, shutdownDeadline)
	if (deliveryStopResult.status === 'timed-out') {
		logger.warn('Webhook delivery worker abort cleanup did not settle before shutdown deadline')
	} else if (deliveryStopResult.status === 'rejected') {
		logger.warn('Webhook delivery worker did not stop cleanly')
	} else {
		deliveryStopped = deliveryStopResult.value
		if (!deliveryStopped) logger.warn('Webhook delivery worker abort cleanup did not settle before shutdown deadline')
	}
	let schedulerDrained = true
	if (schedulerStop) {
		const schedulerStopResult = await settleBeforeDeadline(schedulerStop, shutdownDeadline)
		if (schedulerStopResult.status === 'timed-out') {
			schedulerDrained = false
			logger.warn('Reconciliation retry scheduler did not drain before shutdown deadline')
		} else if (schedulerStopResult.status === 'rejected') {
			schedulerDrained = false
			logger.warn('Reconciliation retry scheduler did not stop cleanly')
		} else {
			schedulerDrained = schedulerStopResult.value.drained
			if (!schedulerDrained) logger.warn('Reconciliation retry scheduler did not drain before shutdown deadline')
		}
	}
	// A scheduler can still be constructing when shutdown begins. Its startup
	// promise includes the stopped-path cleanup in ensureReconciliationRetryScheduler.
	const schedulerStartResult = await settleBeforeDeadline(schedulerStart, shutdownDeadline)
	if (schedulerStartResult.status === 'timed-out') {
		schedulerDrained = false
		logger.warn('Reconciliation retry scheduler startup did not settle before shutdown deadline')
	} else if (schedulerStartResult.status === 'rejected') {
		schedulerDrained = false
		logger.warn('Reconciliation retry scheduler startup did not stop cleanly')
	}
	const safeToCloseSharedClients = canCloseSharedClients({
		initialBackfillSettled,
		intakeDrained,
		schedulerDrained,
		deliveryStopped,
	})
	if (safeToCloseSharedClients) {
		await closeBeforeDeadline(
			closeRedisPublisher(),
			shutdownDeadline,
			'Redis publisher did not close before shutdown deadline',
			'Redis publisher did not close cleanly',
		)
		await closeBeforeDeadline(
			database.closeDatabase(),
			shutdownDeadline,
			'Database did not close before shutdown deadline',
			'Database did not close cleanly',
		)
		await closeBeforeDeadline(
			shutdownGrafanaExporters(),
			shutdownDeadline,
			'Observability did not close before shutdown deadline',
			'Observability did not close cleanly',
		)
	} else {
		// A callback ignored cancellation or its bounded drain. Leave all shared
		// clients open until process exit rather than close them beneath that work.
		logger.warn('Skipping shared-client close because webhook shutdown is incomplete')
	}
	phase = safeToCloseSharedClients ? 'stopped' : 'failed'
	return safeToCloseSharedClients
})

export function shutdown(signal = 'shutdown'): Promise<boolean> {
	return runShutdown(signal)
}

if (import.meta.main) {
	const exitAfterShutdown = (signal: string) => {
		void shutdown(signal)
			.then((safeToCloseSharedClients) => process.exit(safeToCloseSharedClients ? 0 : 1))
			.catch(() => process.exit(1))
	}
	process.once('SIGINT', () => exitAfterShutdown('SIGINT'))
	process.once('SIGTERM', () => exitAfterShutdown('SIGTERM'))
	void main().catch(() => {
		// Startup errors are intentionally not serialized: they can contain URLs or credentials.
		process.exit(1)
	})
}
