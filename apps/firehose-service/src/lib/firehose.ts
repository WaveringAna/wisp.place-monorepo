/**
 * Firehose worker - watches AT Protocol firehose for site changes.
 *
 * A cursor is only durable after all earlier site work has completed (or has
 * been durably handed to the revalidation stream). This gives reconnects and
 * process restarts at-least-once delivery instead of skipping queued writes.
 */

import { IdResolver } from '@atproto/identity'
import { Firehose } from '@atproto/sync'
import { BunFirehose, type CommitEvt, type Event, isBun } from '@wispplace/bun-firehose'
import type { Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import { validateRecord as validateSettingsRecord } from '@wispplace/lexicons/types/place/wisp/settings'
import { createLogger } from '@wispplace/observability'
import { config } from '../config'
import { enqueueSiteRevalidation, type SiteRevalidationEnqueueResult } from './cache-invalidation'
import { handleSettingsDelete, handleSettingsUpdate, handleSiteCreateOrUpdate, handleSiteDelete } from './cache-writer'
import { readDurableCursor, relayFingerprint, saveDurableCursor } from './leader'
import {
	SETTINGS_DELETE_FAILURE_REASON,
	SETTINGS_UPDATE_FAILURE_REASON,
	SITE_DELETE_TOMBSTONE_REASON,
} from './revalidate-queue'
import { createRevalidationResourceContext, type RevalidationResourceContext } from './revalidate-resources'
import {
	DEFAULT_REVALIDATE_DEADLINE_MS,
	DEFAULT_REVALIDATE_TRANSFER_BUDGET_BYTES,
	resolveRevalidateWorkerRuntimeConfig,
} from './revalidate-worker'

const idResolver = new IdResolver({ plcUrl: config.plcDirectoryUrl })
const logger = createLogger('firehose-service')

const STALL_THRESHOLD_MS = 30_000
const DEFAULT_MAX_PENDING_EVENTS = 10_000
const MAX_PENDING_EVENTS = 100_000
const DEFAULT_DRAIN_GRACE_PERIOD_MS = 30_000
const MAX_DRAIN_GRACE_PERIOD_MS = 5 * 60_000
const DEFAULT_MAX_CONCURRENCY = 5
const MAX_CONCURRENCY = 20

// Normal firehose site work uses the same bounded resource settings as replay
// work. Settings records are small, so keep their lock-held operation strict:
// one event cannot occupy a DB lock while waiting for two long PDS requests.
const MAX_SETTINGS_OPERATION_DEADLINE_MS = 30_000
const DEFAULT_SETTINGS_TRANSFER_BUDGET_BYTES = 1024 * 1024
const MAX_SETTINGS_TRANSFER_BUDGET_BYTES = DEFAULT_SETTINGS_TRANSFER_BUDGET_BYTES
const firehoseResourceConfig = resolveRevalidateWorkerRuntimeConfig()
const firehoseOperationDeadlineMs = firehoseResourceConfig.revalidationDeadlineMs ?? DEFAULT_REVALIDATE_DEADLINE_MS
const firehoseTransferBudgetBytes =
	firehoseResourceConfig.transferBudgetBytes ?? DEFAULT_REVALIDATE_TRANSFER_BUDGET_BYTES

function createFilesystemEventResources(upstreamSignal?: AbortSignal): RevalidationResourceContext {
	return createRevalidationResourceContext(firehoseOperationDeadlineMs, firehoseTransferBudgetBytes, upstreamSignal)
}

function createSettingsEventResources(upstreamSignal?: AbortSignal): RevalidationResourceContext {
	return createRevalidationResourceContext(
		Math.min(firehoseOperationDeadlineMs, MAX_SETTINGS_OPERATION_DEADLINE_MS),
		Math.min(firehoseTransferBudgetBytes, MAX_SETTINGS_TRANSFER_BUDGET_BYTES),
		upstreamSignal,
	)
}

/** Run one scheduled event with one caller-owned context and always close it. */
export async function runWithFirehoseResourceContext<T>(
	createResources: () => RevalidationResourceContext,
	operation: (resources: RevalidationResourceContext) => Promise<T>,
): Promise<T> {
	const resources = createResources()
	try {
		return await operation(resources)
	} finally {
		resources.close()
	}
}

type FirehoseLifecycle = 'stopped' | 'running' | 'draining'

type FirehoseHandle = {
	destroy: () => void | Promise<void>
}

import { type CursorReservation, isValidFirehoseSeq, OrderedCursorTracker } from './firehose-cursor'
import {
	DurableReplayController,
	type DurableReplayFailureAttempt,
	destroyThenConnect,
	RelayCursorCoordinator,
	type RelayCursorStore,
	RelayFailureBudget,
	RelayGenerationGuard,
} from './firehose-relay'
import { type SchedulerDrainResult, SiteWorkScheduler } from './firehose-scheduler'

export { type CursorReservation, isValidFirehoseSeq, OrderedCursorTracker } from './firehose-cursor'
export {
	DEFAULT_DURABLE_REPLAY_BASE_DELAY_MS,
	DEFAULT_DURABLE_REPLAY_FAILURE_DECAY_MS,
	DEFAULT_DURABLE_REPLAY_MAX_DELAY_MS,
	DEFAULT_DURABLE_REPLAY_MAX_FAILURES,
	DurableReplayBackoff,
	type DurableReplayBackoffOptions,
	DurableReplayController,
	type DurableReplayControllerOptions,
	type DurableReplayFailureAttempt,
	destroyThenConnect,
	durableReplayBackoffCap,
	durableReplayFullJitter,
	type RelayCursorActivation,
	RelayCursorCoordinator,
	type RelayCursorLoad,
	type RelayCursorStore,
	RelayFailureBudget,
	RelayGenerationGuard,
} from './firehose-relay'
export { type SchedulerDrainResult, SiteWorkScheduler } from './firehose-scheduler'

async function settlesWithinGrace(operation: Promise<unknown>, gracePeriodMs: number): Promise<boolean> {
	if (gracePeriodMs <= 0) return false
	return await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), gracePeriodMs)
		void operation.then(
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

interface StopAndDrainOptions {
	/** Overrides FIREHOSE_DRAIN_GRACE_MS for this stop operation. */
	gracePeriodMs?: number
}

interface FirehoseDrainResult extends SchedulerDrainResult {
	cursor?: number
	pendingCursorEvents: number
	replayRequired: boolean
}

function boundedPositiveInteger(value: number | string | undefined, fallback: number, maximum: number): number {
	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) return fallback
	return parsed
}

function configuredMaxPendingEvents(): number {
	return boundedPositiveInteger(config.firehoseMaxPendingEvents, DEFAULT_MAX_PENDING_EVENTS, MAX_PENDING_EVENTS)
}

function configuredMaxConcurrency(): number {
	return boundedPositiveInteger(config.firehoseMaxConcurrency, DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY)
}

function configuredDrainGracePeriodMs(value?: number): number {
	if (value === undefined) return config.firehoseDrainGraceMs
	const parsed = value
	// Zero is an explicit opt-in to forced teardown and is useful for callers
	// which have their own external deadline.
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_DRAIN_GRACE_PERIOD_MS) {
		return DEFAULT_DRAIN_GRACE_PERIOD_MS
	}
	return parsed
}

function errorKind(error: unknown): string {
	return error instanceof Error && error.name ? error.name : 'UnknownError'
}

function relayLabel(service: string): 'primary' | 'secondary' | 'configured' {
	if (service === config.firehoseService) return 'primary'
	if (service === config.firehoseServiceSecondary) return 'secondary'
	return 'configured'
}

function isDurableRevalidation(result: SiteRevalidationEnqueueResult): boolean {
	return result === 'enqueued' || result === 'deduplicated'
}

const DURABLE_REVALIDATION_CAPACITY_RETRY_BASE_MS = 250
const DURABLE_REVALIDATION_CAPACITY_RETRY_MAX_MS = 5_000

interface DurableRevalidationRetryOptions {
	/** Stop waiting when intake or the owning lifecycle is no longer active. */
	shouldContinue?: () => boolean
	/** Abort the capacity wait when the owning firehose lifecycle stops. */
	signal?: AbortSignal
	/** Timer seam for deterministic capacity/race tests. */
	wait?: (delayMs: number) => Promise<void>
	baseDelayMs?: number
	maxDelayMs?: number
}

async function waitForDurableCapacityRetry(
	delayMs: number,
	wait: ((delayMs: number) => Promise<void>) | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (!signal) {
		await (wait ? wait(delayMs) : new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
		return
	}
	if (signal.aborted) return

	await new Promise<void>((resolve, reject) => {
		let settled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const finish = (error?: unknown) => {
			if (settled) return
			settled = true
			if (timer !== undefined) clearTimeout(timer)
			signal.removeEventListener('abort', onAbort)
			if (error === undefined) resolve()
			else reject(error)
		}
		const onAbort = () => finish()
		signal.addEventListener('abort', onAbort, { once: true })
		const waiting = wait
			? wait(delayMs)
			: new Promise<void>((resolveTimer) => {
					timer = setTimeout(resolveTimer, delayMs)
				})
		void waiting.then(
			() => finish(),
			(error) => finish(error),
		)
	})
}

/**
 * Capacity is backpressure, not a failed handoff. Keep the event's handler
 * pending until the independent revalidation consumer frees a slot. The
 * caller's cursor reservation therefore cannot advance while the stream is
 * full, and bounded cursor/scheduler queues naturally stop relay intake.
 */
export async function retryDurableRevalidationUntilAvailable(
	enqueue: () => Promise<SiteRevalidationEnqueueResult>,
	options: DurableRevalidationRetryOptions = {},
): Promise<SiteRevalidationEnqueueResult> {
	const shouldContinue = options.shouldContinue ?? (() => true)
	const signal = options.signal
	const baseDelayMs =
		Number.isSafeInteger(options.baseDelayMs) && (options.baseDelayMs ?? 0) > 0
			? (options.baseDelayMs as number)
			: DURABLE_REVALIDATION_CAPACITY_RETRY_BASE_MS
	const maxDelayMs = Math.max(
		baseDelayMs,
		Number.isSafeInteger(options.maxDelayMs) && (options.maxDelayMs ?? 0) > 0
			? (options.maxDelayMs as number)
			: DURABLE_REVALIDATION_CAPACITY_RETRY_MAX_MS,
	)
	let retries = 0
	const active = () => !signal?.aborted && shouldContinue()

	while (active()) {
		const result = await enqueue()
		if (result !== 'capacity') return result
		if (!active()) return 'unavailable'
		const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(retries, 30))
		retries++
		await waitForDurableCapacityRetry(delayMs, options.wait, signal)
	}

	return 'unavailable'
}

const durableReplayController = new DurableReplayController()

async function requireDurableRevalidation(
	did: string,
	rkey: string,
	reason: string,
	lifecycleSignal: AbortSignal,
): Promise<void> {
	// Do not route a full stream through requestReplay: that path invokes the
	// leader failure callback and stops this process's only consumer. Capacity
	// waits here, while the independently started worker remains alive to drain.
	const result = await retryDurableRevalidationUntilAvailable(() => enqueueSiteRevalidation(did, rkey, reason), {
		shouldContinue: () => acceptingEvents,
		signal: lifecycleSignal,
	})
	if (isDurableRevalidation(result)) {
		durableReplayController.recordDurableSuccess()
		return
	}
	throw new Error('Durable revalidation is unavailable')
}

const cursorTracker = new OrderedCursorTracker(configuredMaxPendingEvents())
const siteWorkScheduler = new SiteWorkScheduler(configuredMaxConcurrency())

// Track firehose health and lifecycle.
let lastEventTime = Date.now()
let isConnected = false
const relayFailureBudget = new RelayFailureBudget()
let activeService: string = config.firehoseService
let lifecycle: FirehoseLifecycle = 'stopped'
let acceptingEvents = false
// Each start gets a new signal. Accepted work keeps the old signal, so a
// later start cannot accidentally revive a stopped event's retry or IO.
let lifecycleAbortController = new AbortController()
let firehoseHandle: FirehoseHandle | null = null
let stallWatchdogHandle: ReturnType<typeof setInterval> | null = null
let statusLogHandle: ReturnType<typeof setInterval> | null = null
let activeFailureCallback: (() => void) | undefined
let stopAndDrainPromise: Promise<FirehoseDrainResult> | null = null
let relayTransitionPromise: Promise<void> | null = null
let relayDestroyFailed = false
const relayGenerationGuard = new RelayGenerationGuard()
const relayCursorCoordinator = new RelayCursorCoordinator(relayFingerprint)
const relayCursorStore: RelayCursorStore = {
	read: readDurableCursor,
	save: async (service, cursor) => (await saveDurableCursor(cursor, service)).kind === 'saved',
}
let relaySwitchPromise: Promise<void> | null = null

export function getCurrentSeq(): number | undefined {
	return cursorTracker.resumableCursor
}

export function getActiveService(): string {
	return activeService
}

export function getFirehoseHealth() {
	const draining = lifecycle === 'draining'
	return {
		connected: isConnected,
		lastEventTime,
		timeSinceLastEvent: Date.now() - lastEventTime,
		queueSize: siteWorkScheduler.queuedHandlers,
		activeHandlers: siteWorkScheduler.activeHandlers,
		pendingCursorEvents: cursorTracker.pendingCount,
		lifecycle,
		draining,
		consecutiveFailures: relayFailureBudget.consecutiveFailures,
		healthy: lifecycle === 'running' && isConnected && Date.now() - lastEventTime < 60_000,
	}
}

function isCurrentRelay(relayGeneration: number): boolean {
	return relayGenerationGuard.isCurrent(relayGeneration)
}

function canAcceptRelayEvent(relayGeneration: number): boolean {
	return acceptingEvents && isCurrentRelay(relayGeneration)
}

function isCommitWriteEvent(evt: Event | CommitEvt): evt is CommitEvt {
	return 'event' in evt && (evt.event === 'create' || evt.event === 'update' || evt.event === 'delete')
}

function scheduleCursorWork(
	siteKey: string,
	handler: () => Promise<void>,
	reservation: CursorReservation,
	relayGeneration: number,
	resources?: RevalidationResourceContext,
): void {
	const scheduledHandler = resources ? () => runWithFirehoseResourceContext(() => resources, handler) : handler
	let work: Promise<void>
	try {
		work = siteWorkScheduler.schedule(siteKey, scheduledHandler)
	} catch (error) {
		resources?.close()
		throw error
	}
	void work.then(
		() => {
			// Shutdown preserves the active generation so accepted work can advance
			// the final cursor. Relay replacement invalidates it and replays instead.
			if (isCurrentRelay(relayGeneration)) reservation.complete()
		},
		(error) => {
			if (!isCurrentRelay(relayGeneration)) return
			reservation.fail()
			logger.error('[Firehose] Site work requires replay', undefined, { errorKind: errorKind(error) })
			if (acceptingEvents) requestReplay()
		},
	)
}

async function reconcileFilesystemEvent(
	event: CommitEvt,
	resources?: RevalidationResourceContext,
): Promise<string | undefined> {
	const { did, rkey } = event
	if (event.event === 'delete') {
		await handleSiteDelete(did, rkey, undefined, resources)
		return undefined
	}

	// The CAR record is only a hint. handleSiteCreateOrUpdate fetches the
	// authoritative record after acquiring the site lock, so a delayed C1 cannot
	// commit after a newer C2. A confirmed absence is a no-op; transport or
	// validation failures are raised by the locked writer for revalidation.
	await handleSiteCreateOrUpdate(did, rkey, event.record as WispFsRecord, event.cid?.toString() || '', { resources })
	return undefined
}

async function processFilesystemEvent(
	event: CommitEvt,
	resources: RevalidationResourceContext,
	lifecycleSignal: AbortSignal,
): Promise<void> {
	const { did, rkey } = event
	let recoveryReason: string | undefined
	try {
		logger.debug('[place.wisp.fs] Processing event', { did, rkey, event: event.event })
		recoveryReason = await reconcileFilesystemEvent(event, resources)
	} catch (error) {
		logger.error('[place.wisp.fs] Error handling event', undefined, {
			did,
			rkey,
			event: event.event,
			errorKind: errorKind(error),
		})
		recoveryReason =
			event.event === 'delete' ? SITE_DELETE_TOMBSTONE_REASON : `firehose-processing-failed:${event.event}`
	} finally {
		resources.close()
	}

	if (recoveryReason) await requireDurableRevalidation(did, rkey, recoveryReason, lifecycleSignal)
	logger.debug('[place.wisp.fs] Completed event', { did, rkey, event: event.event })
}

async function reconcileSettingsEvent(
	event: CommitEvt,
	resources?: RevalidationResourceContext,
): Promise<string | undefined> {
	const { did, rkey, record, cid } = event
	if (event.event === 'delete') {
		await handleSettingsDelete(did, rkey, undefined, resources)
		return undefined
	}
	if (record && validateSettingsRecord(record).success) {
		await handleSettingsUpdate(did, rkey, record as WispSettings, cid?.toString() || '', { resources })
		return undefined
	}

	logger.warn('[place.wisp.settings] Invalid record requires reconciliation', { did, rkey })
	return SETTINGS_UPDATE_FAILURE_REASON
}

async function processSettingsEvent(
	event: CommitEvt,
	resources: RevalidationResourceContext,
	lifecycleSignal: AbortSignal,
): Promise<void> {
	const { did, rkey } = event
	let recoveryReason: string | undefined
	try {
		recoveryReason = await reconcileSettingsEvent(event, resources)
	} catch (error) {
		logger.error('[place.wisp.settings] Error handling event', undefined, {
			did,
			rkey,
			event: event.event,
			errorKind: errorKind(error),
		})
		recoveryReason = event.event === 'delete' ? SETTINGS_DELETE_FAILURE_REASON : SETTINGS_UPDATE_FAILURE_REASON
	} finally {
		resources.close()
	}

	if (recoveryReason) await requireDurableRevalidation(did, rkey, recoveryReason, lifecycleSignal)
}

function dispatchCommitWork(event: CommitEvt, reservation: CursorReservation, relayGeneration: number): void {
	const { did, collection, rkey } = event
	const siteKey = `${did}/${rkey}`
	const lifecycleSignal = lifecycleAbortController.signal
	if (collection === 'place.wisp.fs') {
		logger.info('[place.wisp.fs] Received event', { did, rkey, event: event.event })
		const resources = createFilesystemEventResources(lifecycleSignal)
		scheduleCursorWork(
			siteKey,
			() => processFilesystemEvent(event, resources, lifecycleSignal),
			reservation,
			relayGeneration,
			resources,
		)
		return
	}
	if (collection === 'place.wisp.settings') {
		const resources = createSettingsEventResources(lifecycleSignal)
		scheduleCursorWork(
			siteKey,
			() => processSettingsEvent(event, resources, lifecycleSignal),
			reservation,
			relayGeneration,
			resources,
		)
		return
	}
	reservation.complete()
}

/**
 * Handle a firehose event. The reservation wait is deliberate: when the
 * bounded cursor queue is full, runtimes which await this handler slow intake
 * instead of allocating unbounded queued work.
 */
async function handleEvent(evt: Event | CommitEvt, relayGeneration: number): Promise<void> {
	if (!canAcceptRelayEvent(relayGeneration)) return
	if (!('seq' in evt) || !isValidFirehoseSeq(evt.seq)) {
		logger.warn('[Firehose] Ignoring event without a valid relay sequence')
		return
	}

	let reservation: CursorReservation | undefined
	try {
		reservation = await cursorTracker.reserve(evt.seq)
		if (!reservation || !canAcceptRelayEvent(relayGeneration)) {
			reservation?.fail()
			return
		}

		lastEventTime = Date.now()
		relayFailureBudget.recordEvent()
		if (!isCommitWriteEvent(evt)) {
			reservation.complete()
			return
		}
		dispatchCommitWork(evt, reservation, relayGeneration)
	} catch (error) {
		if (!isCurrentRelay(relayGeneration)) return
		reservation?.fail()
		logger.error('[Firehose] Unexpected event handling error', undefined, { errorKind: errorKind(error) })
		if (acceptingEvents) requestReplay()
	}
}

function getAlternateService(current: string): string | undefined {
	if (!config.firehoseServiceSecondary) return undefined
	return current === config.firehoseService ? config.firehoseServiceSecondary : config.firehoseService
}

function destroyCurrentRelay(invalidateGeneration = true): Promise<void> {
	if (invalidateGeneration) relayGenerationGuard.invalidate()
	const handle = firehoseHandle
	firehoseHandle = null
	isConnected = false
	if (!handle) return Promise.resolve()

	try {
		return Promise.resolve(handle.destroy()).catch((error) => {
			relayDestroyFailed = true
			logger.error('[Firehose] Relay destroy failed', undefined, { errorKind: errorKind(error) })
			throw error
		})
	} catch (error) {
		relayDestroyFailed = true
		logger.error('[Firehose] Relay destroy failed', undefined, { errorKind: errorKind(error) })
		return Promise.reject(error)
	}
}

/** Serialize destroy -> connect so an async old relay cannot overlap a new one. */
function reconnectRelay(allowDuringRelaySwitch = false): Promise<void> {
	if (relayTransitionPromise) return relayTransitionPromise

	const transition = destroyThenConnect(
		() => destroyCurrentRelay(),
		() => acceptingEvents && (allowDuringRelaySwitch || !relaySwitchPromise),
		() => connect(activeFailureCallback),
	).catch((error) => {
		logger.error('[Firehose] Relay transition failed', undefined, { errorKind: errorKind(error) })
		if (activeFailureCallback) activeFailureCallback()
		else void stopAndDrainFirehose()
	})

	relayTransitionPromise = transition
	void transition.then(() => {
		if (relayTransitionPromise === transition) relayTransitionPromise = null
	})
	return transition
}

function clearRuntimeTimers(): void {
	if (stallWatchdogHandle) {
		clearInterval(stallWatchdogHandle)
		stallWatchdogHandle = null
	}
	if (statusLogHandle) {
		clearInterval(statusLogHandle)
		statusLogHandle = null
	}
}

/**
 * Move between independent relay sequence spaces only after the old completed
 * prefix is durable and the target prefix has been read successfully.
 */
function requestRelayFailover(targetService: string, onFailure?: () => void): void {
	if (!acceptingEvents || relaySwitchPromise || durableReplayController.pending) return

	const sourceService = activeService
	const sourceCursor = getCurrentSeq()
	const priorRelayTransition = relayTransitionPromise
	// Fence callbacks before any await. Accepted site work may finish, but it
	// cannot advance the target relay's cursor generation. The existing relay
	// transition is awaited before destroying again, so its old relay cannot
	// overlap the checkpoint/destroy transition below.
	relayGenerationGuard.invalidate()

	const switching = (async () => {
		if (priorRelayTransition) await priorRelayTransition
		await destroyCurrentRelay(false)
		const activation = await relayCursorCoordinator.switchTo(targetService, sourceCursor, relayCursorStore)
		if (!activation) throw new Error('Durable relay checkpoint is unavailable')
		if (!acceptingEvents) return

		activeService = targetService
		cursorTracker.reset(activation.cursor)
		lastEventTime = Date.now()
		if (activation.missingCheckpoint) {
			logger.warn('[Firehose] Target relay has no checkpoint; starting live without cross-relay replay', {
				relay: relayLabel(targetService),
			})
		}
		await reconnectRelay(true)
	})()
		.catch((error) => {
			logger.error('[Firehose] Relay failover stopped because its checkpoint is uncertain', undefined, {
				from: relayLabel(sourceService),
				to: relayLabel(targetService),
				errorKind: errorKind(error),
			})
			if (onFailure) onFailure()
			else void stopAndDrainFirehose()
		})
		.finally(() => {
			if (relaySwitchPromise === switching) relaySwitchPromise = null
		})

	relaySwitchPromise = switching
}

function handleError(error: Error, onTooManyFailures?: () => void): void {
	if (!acceptingEvents) return

	logger.error('[Firehose] Connection error', undefined, {
		relay: relayLabel(activeService),
		errorKind: errorKind(error),
	})
	if (relayFailureBudget.recordConnectionError() < 3) return

	const alternate = getAlternateService(activeService)
	if (alternate && relayFailureBudget.canFailOver()) {
		logger.warn('[Firehose] Relay failures reached threshold; failing over', {
			from: relayLabel(activeService),
			to: relayLabel(alternate),
		})
		relayFailureBudget.recordFailOver()
		requestRelayFailover(alternate, onTooManyFailures)
		return
	}

	if (alternate) {
		logger.error('[Firehose] Both configured relays are failing', undefined, { relay: relayLabel(activeService) })
	} else {
		logger.warn('[Firehose] Relay failures reached threshold', { relay: relayLabel(activeService) })
	}
	onTooManyFailures?.()
}

function handleStall(onTooManyFailures?: () => void): void {
	if (!acceptingEvents || durableReplayController.pending || relaySwitchPromise) return

	const silenceMs = Date.now() - lastEventTime
	if (silenceMs < STALL_THRESHOLD_MS) return

	if (relayFailureBudget.recordStall() === 1) {
		logger.warn('[Firehose] Relay stalled; reconnecting from the safe cursor', { relay: relayLabel(activeService) })
		const cursor = getCurrentSeq()
		cursorTracker.reset(cursor)
		lastEventTime = Date.now()
		void reconnectRelay()
		return
	}

	const alternate = getAlternateService(activeService)
	if (alternate && relayFailureBudget.canFailOver()) {
		logger.warn('[Firehose] Relay remained stalled; failing over', {
			from: relayLabel(activeService),
			to: relayLabel(alternate),
		})
		relayFailureBudget.recordFailOver()
		requestRelayFailover(alternate, onTooManyFailures)
		return
	}

	logger.error('[Firehose] Relay stalled with no recoverable alternate', undefined, {
		relay: relayLabel(activeService),
	})
	onTooManyFailures?.()
}

function connect(onTooManyFailures: (() => void) | undefined = activeFailureCallback): void {
	if (!acceptingEvents || firehoseHandle) return

	const relayGeneration = relayGenerationGuard.beginConnection()
	const handleRelayEvent = (evt: Event | CommitEvt) => handleEvent(evt, relayGeneration)
	const isCurrentRelay = () => relayGenerationGuard.isCurrent(relayGeneration)
	logger.info('[Firehose] Connecting', { relay: relayLabel(activeService) })
	if (isBun) {
		const bunFirehose = new BunFirehose({
			idResolver,
			service: activeService,
			filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
			handleEvent: handleRelayEvent,
			onError: (error: Error) => {
				if (isCurrentRelay()) handleError(error, onTooManyFailures)
			},
			getCursor: () => getCurrentSeq(),
			onConnect: () => {
				if (!acceptingEvents || !isCurrentRelay()) return
				isConnected = true
				relayFailureBudget.recordConnected()
				// A connected socket is not proof of a usable relay. The failure and
				// cross-relay budgets reset only when handleEvent receives an event.
				logger.info('[Firehose] Connected', { relay: relayLabel(activeService) })
			},
			onDisconnect: () => {
				if (!isCurrentRelay()) return
				isConnected = false
				if (acceptingEvents) logger.warn('[Firehose] Disconnected; relay will reconnect')
			},
		})
		void bunFirehose.start()
		firehoseHandle = { destroy: () => bunFirehose.destroy() }
		return
	}

	const nodeFirehose = new Firehose({
		idResolver,
		service: activeService,
		filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
		handleEvent: handleRelayEvent as (evt: Event) => Promise<void>,
		onError: (error: Error) => {
			if (isCurrentRelay()) handleError(error, onTooManyFailures)
		},
		getCursor: () => getCurrentSeq(),
	})
	isConnected = true
	void nodeFirehose.start()
	firehoseHandle = { destroy: () => nodeFirehose.destroy() }
}

/** Fail closed when bounded durable-recovery replay cannot make progress. */
function failClosedAfterDurableReplayFailures(attempt: DurableReplayFailureAttempt): void {
	logger.error('[Firehose] Durable recovery replay failure budget exhausted', undefined, {
		consecutiveFailures: attempt.consecutiveFailures,
	})
	if (activeFailureCallback) {
		activeFailureCallback()
		return
	}
	void stopAndDrainFirehose()
}

/** Reconnect from the last safe cursor after durable recovery was unavailable. */
function requestReplay(): void {
	if (!acceptingEvents) return

	const attempt = durableReplayController.request(async () => {
		if (!acceptingEvents) return
		const cursor = getCurrentSeq()
		// Discard old reservations after retaining their safe prefix. Replayed
		// events receive fresh reservations; callbacks from old work are ignored.
		cursorTracker.reset(cursor)
		isConnected = false
		await reconnectRelay()
	}, failClosedAfterDurableReplayFailures)
	if (!attempt || attempt.terminal) return

	isConnected = false
	logger.warn('[Firehose] Durable recovery unavailable; replay reconnect scheduled', {
		consecutiveFailures: attempt.consecutiveFailures,
		delayMs: attempt.delayMs,
		delayCapMs: attempt.delayCapMs,
	})
}

function startFirehoseNow(initialCursor: number | undefined, onTooManyFailures?: () => void): void {
	logger.info('[Firehose] Starting', { runtime: isBun ? 'bun' : 'node', maxConcurrency: configuredMaxConcurrency() })
	if (config.firehoseServiceSecondary) logger.info('[Firehose] Secondary relay configured')
	if (initialCursor !== undefined) logger.info('[Firehose] Resuming from a saved cursor')

	stopAndDrainPromise = null
	relayDestroyFailed = false
	lifecycleAbortController = new AbortController()
	activeService = config.firehoseService
	activeFailureCallback = onTooManyFailures
	relayFailureBudget.reset()
	durableReplayController.reset()
	lastEventTime = Date.now()
	relayCursorCoordinator.initialize(activeService, initialCursor)
	cursorTracker.reset(initialCursor)
	acceptingEvents = true
	lifecycle = 'running'
	connect(onTooManyFailures)

	if (statusLogHandle) clearInterval(statusLogHandle)
	statusLogHandle = setInterval(() => {
		logger.info('[Firehose] Status check', {
			queueSize: siteWorkScheduler.queuedHandlers,
			activeHandlers: siteWorkScheduler.activeHandlers,
			pendingCursorEvents: cursorTracker.pendingCount,
		})
	}, 60 * 60_000)

	if (stallWatchdogHandle) clearInterval(stallWatchdogHandle)
	stallWatchdogHandle = setInterval(() => handleStall(onTooManyFailures), STALL_THRESHOLD_MS)
}

/**
 * Start the firehose worker. If a previous leader is still draining, startup is
 * delayed until it has drained successfully instead of overlapping handlers.
 */
export function startFirehose(initialCursor?: number, onTooManyFailures?: () => void): void {
	if (acceptingEvents) {
		logger.warn('[Firehose] Start requested while already running; ignoring duplicate request')
		return
	}

	const priorDrain = stopAndDrainPromise
	if (priorDrain) {
		void priorDrain.then((result) => {
			if (stopAndDrainPromise !== priorDrain) return
			if (result.forced) {
				logger.error('[Firehose] Not restarting after a forced drain', undefined, {
					remainingWork: result.remainingWork,
				})
				return
			}
			startFirehoseNow(initialCursor, onTooManyFailures)
		})
		return
	}

	startFirehoseNow(initialCursor, onTooManyFailures)
}

/**
 * Stop intake immediately, then wait for all accepted site work. The result is
 * explicit when the grace period expires so callers can choose a forced process
 * teardown without pretending that queued work drained.
 */
export function stopAndDrainFirehose(options: StopAndDrainOptions = {}): Promise<FirehoseDrainResult> {
	if (stopAndDrainPromise) return stopAndDrainPromise

	const gracePeriodMs = configuredDrainGracePeriodMs(options.gracePeriodMs)
	logger.info('[Firehose] Stopping intake and draining queued work', { gracePeriodMs })
	acceptingEvents = false
	lifecycle = 'draining'
	lifecycleAbortController.abort(new Error('Firehose lifecycle stopped'))
	isConnected = false
	relayFailureBudget.reset()
	durableReplayController.stop()
	clearRuntimeTimers()
	cursorTracker.stopAccepting()
	// No more reservations can arrive after this point, so the final commit can
	// become eligible for checkpointing as soon as its work completes.
	cursorTracker.sealOpenSequence()
	const replayReconnectPromise = durableReplayController.pending
	const hadRelayTransition = Boolean(
		firehoseHandle || replayReconnectPromise || relayTransitionPromise || relaySwitchPromise,
	)
	const relayDestroyed = destroyCurrentRelay(false)
	const relayStopping = Promise.all([
		relayDestroyed,
		replayReconnectPromise ?? Promise.resolve(),
		relayTransitionPromise ?? Promise.resolve(),
		relaySwitchPromise ?? Promise.resolve(),
	])

	stopAndDrainPromise = (async () => {
		const [workerDrain, relayStopped] = await Promise.all([
			siteWorkScheduler.drain(gracePeriodMs),
			hadRelayTransition ? settlesWithinGrace(relayStopping, gracePeriodMs) : Promise.resolve(true),
		])
		const drain: SchedulerDrainResult =
			workerDrain.forced || !relayStopped || relayDestroyFailed
				? { ...workerDrain, outcome: 'forced', forced: true }
				: workerDrain
		cursorTracker.sealOpenSequence()
		const result: FirehoseDrainResult = {
			...drain,
			cursor: getCurrentSeq(),
			pendingCursorEvents: cursorTracker.pendingCount,
			replayRequired: cursorTracker.pendingCount > 0,
		}
		lifecycle = 'stopped'

		if (result.forced) {
			logger.warn('[Firehose] Drain did not complete safely; forced teardown is required', {
				remainingWork: result.remainingWork,
				activeHandlers: result.activeHandlers,
				pendingCursorEvents: result.pendingCursorEvents,
				relayDestroyFailed,
			})
		} else {
			logger.info('[Firehose] Drain complete', {
				pendingCursorEvents: result.pendingCursorEvents,
				replayRequired: result.replayRequired,
			})
		}
		return result
	})()

	return stopAndDrainPromise
}

/**
 * Backward-compatible stop entry point. Callers that can await it receive the
 * same idempotent drain result; callback-only callers may safely ignore it.
 */
export function stopFirehose(): Promise<FirehoseDrainResult> {
	return stopAndDrainFirehose()
}
