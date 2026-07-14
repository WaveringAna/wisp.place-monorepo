/**
 * Firehose worker - watches AT Protocol firehose for site changes
 * Uses BunFirehose for Bun runtime, @atproto/sync for Node.js
 */

import { IdResolver } from '@atproto/identity'
import { Firehose } from '@atproto/sync'
import { BunFirehose, type CommitEvt, type Event, isBun } from '@wispplace/bun-firehose'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import { validateRecord as validateSettingsRecord } from '@wispplace/lexicons/types/place/wisp/settings'
import { createLogger } from '@wispplace/observability'
import { config } from '../config'
import {
	fetchSiteRecord,
	handleSettingsDelete,
	handleSettingsUpdate,
	handleSiteCreateOrUpdate,
	handleSiteDelete,
} from './cache-writer'

const idResolver = new IdResolver()
const logger = createLogger('firehose-service')

// Track firehose health
let lastEventTime = Date.now()
let isConnected = false
let activeHandlers = 0
let queuedHandlers = 0
let consecutiveFailures = 0
// Counts how many times we've switched relays without a successful event since
// the last successful connection. Used to detect when both relays are down.
let swapsWithoutSuccess = 0
// Counts stall watchdog firings without a received event in between. 1 = try a
// same-relay reconnect; 2 = relay is dead, fail over.
let stallReconnects = 0
let activeService: string = config.firehoseService
const siteQueues = new Map<string, Promise<void>>()

const STALL_THRESHOLD_MS = 30_000

// Track current firehose sequence number for cursor-based resumption
let currentSeq: number | undefined

function getAlternateService(current: string): string | undefined {
	if (!config.firehoseServiceSecondary) return undefined
	return current === config.firehoseService ? config.firehoseServiceSecondary : config.firehoseService
}

export function getCurrentSeq(): number | undefined {
	return currentSeq
}

export function getActiveService(): string {
	return activeService
}

export function getFirehoseHealth() {
	return {
		connected: isConnected,
		lastEventTime,
		timeSinceLastEvent: Date.now() - lastEventTime,
		queueSize: queuedHandlers,
		activeHandlers,
		consecutiveFailures,
		healthy: isConnected && Date.now() - lastEventTime < 60000,
	}
}

export function getConsecutiveFailures(): number {
	return consecutiveFailures
}

/**
 * Process a firehose event with concurrency limiting
 */
async function processWithConcurrencyLimit(handler: () => Promise<void>): Promise<void> {
	// If at max concurrency, queue and wait
	while (activeHandlers >= config.firehoseMaxConcurrency) {
		await new Promise((resolve) => setTimeout(resolve, 100))
	}

	activeHandlers++
	try {
		await handler()
	} finally {
		activeHandlers--
	}
}

/**
 * Schedule work so each site (did/rkey) is processed in event order.
 * This prevents stale writes when multiple updates arrive quickly.
 */
function scheduleSiteWork(siteKey: string, handler: () => Promise<void>): void {
	const previous = siteQueues.get(siteKey) ?? Promise.resolve()
	queuedHandlers++

	const next = previous
		.catch(() => undefined)
		.then(() => processWithConcurrencyLimit(handler))
		.catch((err) => {
			logger.error(`[firehose] Unhandled site work error for ${siteKey}`, err)
		})
		.finally(() => {
			queuedHandlers = Math.max(0, queuedHandlers - 1)
			if (siteQueues.get(siteKey) === next) {
				siteQueues.delete(siteKey)
			}
		})

	siteQueues.set(siteKey, next)
}

/**
 * Handle a firehose event
 */
async function handleEvent(evt: Event | CommitEvt): Promise<void> {
	try {
		lastEventTime = Date.now()
		if (consecutiveFailures > 0) consecutiveFailures = 0
		// Any successful event means the active relay is working — reset the
		// cross-relay failover counter so a future failure triggers a fresh swap.
		if (swapsWithoutSuccess > 0) swapsWithoutSuccess = 0
		if (stallReconnects > 0) stallReconnects = 0
		if ('seq' in evt) currentSeq = evt.seq

		if (!('event' in evt)) return

		// Only handle commit events
		if (evt.event !== 'create' && evt.event !== 'update' && evt.event !== 'delete') {
			return
		}

		const commitEvt = evt as CommitEvt
		const { did, collection, rkey, record, cid } = commitEvt

		logger.debug(`Event ${evt.event} for ${collection}:${did}/${rkey}`, { cid: cid?.toString() || 'unknown' })

		// Handle place.wisp.fs events
		if (collection === 'place.wisp.fs') {
			logger.info(`[place.wisp.fs] Received ${commitEvt.event} event`, { did, rkey, cid: cid?.toString() || 'unknown' })
			const siteKey = `${did}/${rkey}`
			scheduleSiteWork(siteKey, async () => {
				try {
					logger.debug(`[place.wisp.fs] Processing ${commitEvt.event} event`, { did, rkey })
					if (commitEvt.event === 'delete') {
						await handleSiteDelete(did, rkey)
					} else {
						// For create/update, we need to verify the record from PDS
						// The firehose record might be incomplete
						const verified = await fetchSiteRecord(did, rkey)
						if (verified) {
							await handleSiteCreateOrUpdate(did, rkey, verified.record, verified.cid)
						} else {
							logger.warn(`[place.wisp.fs] Skipping ${commitEvt.event} event - verification failed`, { did, rkey })
						}
					}
					logger.debug(`[place.wisp.fs] Completed ${commitEvt.event} event`, { did, rkey })
				} catch (err) {
					logger.error(`[place.wisp.fs] Error handling event`, err, { did, rkey, event: commitEvt.event })
				}
			})
		}

		// Handle place.wisp.settings events
		if (collection === 'place.wisp.settings') {
			const siteKey = `${did}/${rkey}`
			scheduleSiteWork(siteKey, async () => {
				try {
					if (commitEvt.event === 'delete') {
						await handleSettingsDelete(did, rkey)
					} else if (record && validateSettingsRecord(record).success) {
						const cidStr = cid?.toString() || ''
						await handleSettingsUpdate(did, rkey, record as WispSettings, cidStr)
					} else {
						logger.warn(`[place.wisp.settings] Skipping invalid record`, { did, rkey })
					}
				} catch (err) {
					logger.error(`[place.wisp.settings] Error handling event`, err, { did, rkey, event: commitEvt.event })
				}
			})
		}
	} catch (err) {
		logger.error('Unexpected error in handleEvent', err)
	}
}

function handleError(err: Error, onTooManyFailures?: () => void): void {
	logger.error(`Firehose connection error on ${activeService}`, err)
	consecutiveFailures++
	if (consecutiveFailures < 3) return

	const alternate = getAlternateService(activeService)
	if (alternate && swapsWithoutSuccess < 2) {
		logger.warn(`Firehose ${activeService} failed ${consecutiveFailures} times, failing over to ${alternate}`)
		consecutiveFailures = 0
		swapsWithoutSuccess++
		firehoseHandle?.destroy()
		firehoseHandle = null
		activeService = alternate
		// seq numbers are relay-scoped; don't carry the previous relay's cursor.
		currentSeq = undefined
		connect(onTooManyFailures)
		return
	}

	if (alternate) {
		logger.error('Both primary and secondary relays failing, triggering offline callback')
	} else {
		logger.warn(`Firehose failed ${consecutiveFailures} times, triggering offline callback`)
	}
	onTooManyFailures?.()
}

let firehoseHandle: { destroy: () => void } | null = null
let stallWatchdogHandle: ReturnType<typeof setInterval> | null = null

function handleStall(onTooManyFailures?: () => void): void {
	const silenceMs = Date.now() - lastEventTime
	if (silenceMs < STALL_THRESHOLD_MS) return

	stallReconnects++
	const silenceSec = Math.round(silenceMs / 1000)

	// First stall: try reconnecting to the same relay with the current cursor.
	if (stallReconnects === 1) {
		logger.warn(`No events for ${silenceSec}s on ${activeService}, reconnecting with cursor`)
		firehoseHandle?.destroy()
		firehoseHandle = null
		// Grace window so the next watchdog tick doesn't fire before reconnect
		// has had a chance to receive events.
		lastEventTime = Date.now()
		connect(onTooManyFailures)
		return
	}

	// Second stall: same-relay reconnect didn't help — fail over if possible.
	const alternate = getAlternateService(activeService)
	if (alternate && swapsWithoutSuccess < 2) {
		logger.warn(`${activeService} still silent after reconnect, failing over to ${alternate}`)
		swapsWithoutSuccess++
		stallReconnects = 0
		consecutiveFailures = 0
		activeService = alternate
		// seq numbers are relay-scoped; don't carry the previous relay's cursor.
		currentSeq = undefined
		firehoseHandle?.destroy()
		firehoseHandle = null
		lastEventTime = Date.now()
		connect(onTooManyFailures)
		return
	}

	logger.error(`Firehose stalled on ${activeService} with no recoverable relay, triggering offline callback`)
	onTooManyFailures?.()
}

function connect(onTooManyFailures?: () => void): void {
	logger.info(`Connecting firehose to ${activeService}`)
	if (isBun) {
		// Use BunFirehose for Bun runtime
		const bunFirehose = new BunFirehose({
			idResolver,
			service: activeService,
			filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
			handleEvent,
			onError: (err: Error) => handleError(err, onTooManyFailures),
			getCursor: () => currentSeq,
			onConnect: () => {
				isConnected = true
				consecutiveFailures = 0
				swapsWithoutSuccess = 0
				logger.info(`Firehose connected to ${activeService}`)
			},
			onDisconnect: () => {
				isConnected = false
				logger.warn('Firehose disconnected, will reconnect')
			},
		})
		bunFirehose.start()
		firehoseHandle = { destroy: () => bunFirehose.destroy() }
	} else {
		// Use @atproto/sync Firehose for Node.js
		isConnected = true
		const nodeFirehose = new Firehose({
			idResolver,
			service: activeService,
			filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
			handleEvent: handleEvent as any,
			onError: (err: Error) => handleError(err, onTooManyFailures),
		})
		nodeFirehose.start()
		firehoseHandle = { destroy: () => nodeFirehose.destroy() }
	}
}

/**
 * Start the firehose worker
 */
export function startFirehose(initialCursor?: number, onTooManyFailures?: () => void): void {
	logger.info(`Starting firehose (runtime: ${isBun ? 'Bun' : 'Node.js'})`)
	logger.info(`Primary service: ${config.firehoseService}`)
	if (config.firehoseServiceSecondary) {
		logger.info(`Secondary service: ${config.firehoseServiceSecondary}`)
	}
	logger.info(`Max concurrency: ${config.firehoseMaxConcurrency}`)
	if (initialCursor !== undefined) {
		currentSeq = initialCursor
		logger.info(`Resuming from cursor: ${initialCursor}`)
	}

	activeService = config.firehoseService
	swapsWithoutSuccess = 0
	connect(onTooManyFailures)

	// Log cache info hourly
	setInterval(
		() => {
			logger.info('Hourly status check')
		},
		60 * 60 * 1000,
	)

	// Stall watchdog: if no events for STALL_THRESHOLD_MS, reconnect (same relay
	// first, then fail over on the next stall).
	if (stallWatchdogHandle) clearInterval(stallWatchdogHandle)
	stallWatchdogHandle = setInterval(() => handleStall(onTooManyFailures), STALL_THRESHOLD_MS)
}

/**
 * Stop the firehose worker
 */
export function stopFirehose(): void {
	logger.info('Stopping firehose')
	isConnected = false
	consecutiveFailures = 0
	swapsWithoutSuccess = 0
	stallReconnects = 0
	activeService = config.firehoseService
	if (stallWatchdogHandle) {
		clearInterval(stallWatchdogHandle)
		stallWatchdogHandle = null
	}
	firehoseHandle?.destroy()
	firehoseHandle = null
	currentSeq = undefined
}
