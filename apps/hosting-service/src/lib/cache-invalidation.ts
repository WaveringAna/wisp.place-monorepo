/**
 * Cache invalidation subscriber
 *
 * Uses Redis pub/sub for low-latency invalidation and a Redis stream for replay.
 * When a site is updated/deleted, clears the hosting-service's local caches
 * (tiered storage hot+warm tiers, redirect rules) so stale data isn't served.
 *
 * Also tracks sites that are actively being downloaded ('updating' action) so
 * the serving layer can show a "site updating" page instead of stale/partial content.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import {
	type CacheInvalidationMessage,
	DEFAULT_CACHE_INVALIDATION_CHANNEL,
	DEFAULT_CACHE_INVALIDATION_STREAM,
	decodeCacheInvalidationMessage,
} from '@wispplace/constants'
import { createLogger } from '@wispplace/observability'
import type { StorageTier } from '@wispplace/tiered-storage'
import Redis from 'ioredis'
import { cache } from './cache-manager'
import { resetAllHtmlHotCacheWarmups, resetSiteHtmlHotCacheWarmup } from './html-prewarm'
import { hotTier, storage, warmTier } from './storage'

const logger = createLogger('cache-invalidation')
const CHANNEL = DEFAULT_CACHE_INVALIDATION_CHANNEL
const STREAM = process.env.WISP_CACHE_INVALIDATION_STREAM || DEFAULT_CACHE_INVALIDATION_STREAM
const STREAM_BLOCK_MS = parsePositiveInt(process.env.WISP_CACHE_INVALIDATION_BLOCK_MS, 5000)
const STREAM_BATCH_COUNT = parsePositiveInt(process.env.WISP_CACHE_INVALIDATION_BATCH_COUNT, 100)
const STREAM_BLOCKING_GRACE_MS = parsePositiveInt(process.env.WISP_CACHE_INVALIDATION_BLOCKING_GRACE_MS, 1000)
const STREAM_SOCKET_TIMEOUT_MS = Math.max(
	parsePositiveInt(
		process.env.WISP_CACHE_INVALIDATION_SOCKET_TIMEOUT_MS,
		STREAM_BLOCK_MS + STREAM_BLOCKING_GRACE_MS + 10_000,
	),
	STREAM_BLOCK_MS + STREAM_BLOCKING_GRACE_MS + 1000,
)
// HAProxy in front of each regional Redis closes connections idle longer than its
// client/server inactivity timeouts, which silently kills an otherwise silent
// pub/sub subscriber. PING stays valid once ioredis enters subscriber mode, and a
// 60s cadence tolerates missed heartbeats below the raised 180s HAProxy bound.
const SUBSCRIBER_PING_INTERVAL_MS = 60_000
// Supervised PONG deadline: HAProxy closes idle subscriber sockets without
// ioredis firing an error, so a client whose PINGs stop settling within this
// window is recreated.
const SUBSCRIBER_SUPERVISOR_INTERVAL_MS = 30_000
const SUBSCRIBER_RECREATE_AFTER_MS = 180_000

function getCursorFile(): string {
	return (
		process.env.WISP_CACHE_INVALIDATION_CURSOR_FILE ||
		resolve(process.env.CACHE_DIR || './cache/sites', '..', 'cache-invalidation.lastid')
	)
}
const STREAM_ID_PATTERN = /^\d+-\d+$/

export type { CacheInvalidationMessage } from '@wispplace/constants'

// Sites currently being downloaded by the firehose-service.
// Maps `${did}/${rkey}` → current update token and timestamp.
// Used to show an "updating" page instead of serving stale files.
const UPDATING_TTL_MS = 10 * 60 * 1000 // 10 minutes safety timeout
const MAX_UPDATING_SITES = parsePositiveInt(process.env.WISP_MAX_UPDATING_SITES, 10_000)
type UpdatingSiteState = { since: number; token?: string; streamId?: string }
type TerminalSiteState = { since: number; streamId: string }

const updatingSites = new Map<string, UpdatingSiteState>()
// This local, bounded high-water mark prevents live terminal events from being
// undone by older replayed starts. Replay remains the only durable cursor owner.
const latestTerminalSiteStreamIds = new Map<string, TerminalSiteState>()

type InvalidationCache = Pick<typeof cache, 'delete' | 'deletePrefix'>
type UpperCacheInvalidator = Pick<typeof storage, 'invalidateUpperCaches'>

export interface CacheInvalidationDependenciesForTests {
	/** Use the real TieredStorage upper-cache fence in production or inject it in focused tests. */
	storage?: UpperCacheInvalidator
	/** Supplying either tier keeps deterministic legacy injected-tier tests on the direct fallback. */
	hotTier?: StorageTier
	warmTier?: StorageTier
	cache?: InvalidationCache
	resetSiteHtmlHotCacheWarmup?: typeof resetSiteHtmlHotCacheWarmup
}

interface CacheInvalidationDependencies {
	storage: UpperCacheInvalidator | undefined
	hotTier: StorageTier
	warmTier: StorageTier | undefined
	cache: InvalidationCache
	resetSiteHtmlHotCacheWarmup: typeof resetSiteHtmlHotCacheWarmup
}

function getCacheInvalidationDependencies(
	overrides?: CacheInvalidationDependenciesForTests,
): CacheInvalidationDependencies {
	const hasInjectedFileTiers = overrides !== undefined && ('hotTier' in overrides || 'warmTier' in overrides)
	return {
		storage: hasInjectedFileTiers ? undefined : (overrides?.storage ?? storage),
		hotTier: overrides?.hotTier ?? hotTier,
		warmTier: overrides?.warmTier ?? warmTier,
		cache: overrides?.cache ?? cache,
		resetSiteHtmlHotCacheWarmup: overrides?.resetSiteHtmlHotCacheWarmup ?? resetSiteHtmlHotCacheWarmup,
	}
}

/**
 * Recovery hooks for a Redis stream retention gap. The warm-cache validation
 * hook is intentionally separate: file serving validates entries against the
 * current source CID, so recovery must not wipe up to 10GB of warm disk data.
 */
export interface CacheInvalidationGapRecoveryDependencies {
	clearMutableCaches?: () => void | Promise<void>
	clearUpdatingAndTerminalState?: () => void | Promise<void>
	resetHtmlPrewarmState?: () => void | Promise<void>
	evictHotTier?: () => void | Promise<void>
	validateWarmCacheSourceCids?: () => void | Promise<void>
}

interface ResolvedCacheInvalidationGapRecoveryDependencies {
	clearMutableCaches: () => void | Promise<void>
	clearUpdatingAndTerminalState: () => void | Promise<void>
	resetHtmlPrewarmState: () => void | Promise<void>
	evictHotTier: () => void | Promise<void>
	validateWarmCacheSourceCids: () => void | Promise<void>
}

function clearUpdatingAndTerminalState(): void {
	updatingSites.clear()
	latestTerminalSiteStreamIds.clear()
}

function getCacheInvalidationGapRecoveryDependencies(
	overrides?: CacheInvalidationGapRecoveryDependencies,
): ResolvedCacheInvalidationGapRecoveryDependencies {
	return {
		clearMutableCaches: overrides?.clearMutableCaches ?? (() => cache.clearAll()),
		clearUpdatingAndTerminalState: overrides?.clearUpdatingAndTerminalState ?? clearUpdatingAndTerminalState,
		resetHtmlPrewarmState: overrides?.resetHtmlPrewarmState ?? resetAllHtmlHotCacheWarmups,
		evictHotTier: overrides?.evictHotTier ?? (() => hotTier.clear()),
		// File serving validates retained warm entries against the source CID. This
		// seam permits deployments to perform an additional validation pass before
		// replay resumes, without an unsafe broad warm-tier wipe.
		validateWarmCacheSourceCids: overrides?.validateWarmCacheSourceCids ?? (() => undefined),
	}
}

let cacheInvalidationGapRecoveryDependencies = getCacheInvalidationGapRecoveryDependencies()

function getSiteInvalidationKey(did: string, rkey: string): string {
	return `${did}/${rkey}`
}

function pruneExpiredUpdatingSites(now = Date.now()): void {
	for (const [key, state] of updatingSites) {
		if (now - state.since > UPDATING_TTL_MS) {
			updatingSites.delete(key)
		}
	}
}

function pruneExpiredTerminalSiteStreamIds(now = Date.now()): void {
	for (const [key, state] of latestTerminalSiteStreamIds) {
		if (now - state.since > UPDATING_TTL_MS) {
			latestTerminalSiteStreamIds.delete(key)
		}
	}
}

function enforceUpdatingSitesLimit(): void {
	while (updatingSites.size > MAX_UPDATING_SITES) {
		const oldestKey = updatingSites.keys().next().value
		if (oldestKey === undefined) return
		updatingSites.delete(oldestKey)
	}
}

function enforceTerminalSiteStreamIdsLimit(): void {
	while (latestTerminalSiteStreamIds.size > MAX_UPDATING_SITES) {
		const oldestKey = latestTerminalSiteStreamIds.keys().next().value
		if (oldestKey === undefined) return
		latestTerminalSiteStreamIds.delete(oldestKey)
	}
}

function recordTerminalSiteStreamId(did: string, rkey: string, streamId: string | undefined): void {
	const normalized = normalizeStreamId(streamId)
	if (!normalized) return

	const now = Date.now()
	pruneExpiredTerminalSiteStreamIds(now)
	const key = getSiteInvalidationKey(did, rkey)
	const previous = latestTerminalSiteStreamIds.get(key)
	if (previous && compareStreamIds(normalized, previous.streamId) < 0) return

	latestTerminalSiteStreamIds.delete(key)
	latestTerminalSiteStreamIds.set(key, { since: now, streamId: normalized })
	enforceTerminalSiteStreamIdsLimit()
}

function isUpdatingSupersededByTerminal(did: string, rkey: string, streamId: string | undefined): boolean {
	const normalized = normalizeStreamId(streamId)
	if (!normalized) return false

	pruneExpiredTerminalSiteStreamIds()
	const terminal = latestTerminalSiteStreamIds.get(getSiteInvalidationKey(did, rkey))
	return terminal !== undefined && compareStreamIds(terminal.streamId, normalized) >= 0
}

export function isSiteUpdating(did: string, rkey: string): boolean {
	const key = getSiteInvalidationKey(did, rkey)
	const state = updatingSites.get(key)
	if (state === undefined) return false
	if (Date.now() - state.since > UPDATING_TTL_MS) {
		// Firehose must have crashed; remove the stale entry
		updatingSites.delete(key)
		return false
	}
	return true
}

export function markSiteUpdating(did: string, rkey: string, token?: string, streamId?: string): void {
	const now = Date.now()
	const key = getSiteInvalidationKey(did, rkey)
	pruneExpiredUpdatingSites(now)
	// Refresh insertion order so the cap evicts the oldest active update.
	updatingSites.delete(key)
	updatingSites.set(key, { since: now, token, streamId: normalizeStreamId(streamId) })
	enforceUpdatingSitesLimit()
}

function canClearSiteUpdating(did: string, rkey: string, token?: string, streamId?: string): boolean {
	const state = updatingSites.get(getSiteInvalidationKey(did, rkey))
	if (!state) return false

	const terminalStreamId = normalizeStreamId(streamId)
	if (state.streamId && terminalStreamId) {
		// Comparable stream IDs are authoritative. A later terminal event wins even
		// if its updating hint was missed or carried a different token.
		return compareStreamIds(terminalStreamId, state.streamId) >= 0
	}

	// Without comparable stream IDs, retain the legacy token guard. This keeps
	// tokenized producers interoperable when only one side carries a stream ID.
	return !(token && state.token && state.token !== token)
}

export function clearSiteUpdating(did: string, rkey: string, token?: string, streamId?: string): boolean {
	if (!canClearSiteUpdating(did, rkey, token, streamId)) return false
	updatingSites.delete(getSiteInvalidationKey(did, rkey))
	return true
}

export function resetUpdatingSitesForTests(): void {
	clearUpdatingAndTerminalState()
}

export function getUpdatingSiteCountForTests(): number {
	return updatingSites.size
}

export interface CacheInvalidationHealthSnapshot {
	subscriberConnected: boolean
	replayConnected: boolean
	replayState: 'stopped' | 'starting' | 'healthy' | 'degraded' | 'gap'
	cursor: string
	lastEventAt: number | null
	lastErrorAt: number | null
	lastGapAt: number | null
	gapCount: number
	lastGapRecoveryAt: number | null
	retrying: boolean
	subscriberRecreations: number
}

export interface CacheInvalidationRedisOptions {
	maxRetriesPerRequest: number
	enableReadyCheck: boolean
	blockingTimeout?: number
	blockingTimeoutGrace?: number
	socketTimeout?: number
	autoResubscribe?: boolean
}

export type CacheInvalidationRedisFactory = (redisUrl: string, options: CacheInvalidationRedisOptions) => Redis

/**
 * Schedules the repeating subscriber keepalive PING and returns a cancel handle.
 * Production uses an unref'd interval; focused tests inject a fake that records
 * the requested delay and fires ticks manually instead of waiting on real time.
 */
export type CacheInvalidationHeartbeatIntervalScheduler = (callback: () => void, intervalMs: number) => () => void

/** Overrides for the subscriber keepalive PING; focused tests inject a fake scheduler. */
export interface CacheInvalidationSubscriberHeartbeatOptions {
	scheduleInterval?: CacheInvalidationHeartbeatIntervalScheduler
}

export interface CacheInvalidationSubscriberSupervisorOptions {
	scheduleInterval?: CacheInvalidationHeartbeatIntervalScheduler
	recreateAfterMs?: number
}

const defaultRedisClientFactory: CacheInvalidationRedisFactory = (redisUrl, options) => new Redis(redisUrl, options)

// The keepalive must never hold the event loop open during shutdown.
const scheduleRealHeartbeatInterval: CacheInvalidationHeartbeatIntervalScheduler = (callback, intervalMs) => {
	const timer = setInterval(callback, intervalMs)
	timer.unref()
	return () => clearInterval(timer)
}

let subscriber: Redis | null = null
let cancelSubscriberHeartbeat: (() => void) | null = null
let cancelSubscriberSupervisor: (() => void) | null = null
// Recreating bumps the generation first so stale client callbacks are no-ops.
let subscriberGeneration = 0
let subscriberRecreations = 0
let subscriberLastPongAt: number | null = null
// 'ready' alone is not connected; health requires the SUBSCRIBE ack.
let subscriberSubscriptionAcked = false
let subscriberReadyAttempt = 0
let subscriberUnhealthySince: number | null = null
let subscriberContext: {
	redisUrl: string
	factory: CacheInvalidationRedisFactory
	scheduleHeartbeatInterval: CacheInvalidationHeartbeatIntervalScheduler
} | null = null
// Start-once/stop-once: repeated start is a no-op; stop is one shared promise.
type CacheInvalidationLifecycleState = 'idle' | 'active' | 'stopping'
let lifecycleState: CacheInvalidationLifecycleState = 'idle'
let stopPromise: Promise<void> | null = null
let replayClient: Redis | null = null
let stopReplayRequested = false
let replayLoop: Promise<void> | null = null
let processingQueue: Promise<void> = Promise.resolve()
let cursorPersistQueue: Promise<void> = Promise.resolve()
let cancelReplayRetryWait: (() => void) | null = null
let replayCursorIsEstablished = false
let lastProcessedStreamId = '0-0'
let cacheInvalidationHealth: CacheInvalidationHealthSnapshot = {
	subscriberConnected: false,
	replayConnected: false,
	replayState: 'stopped',
	cursor: lastProcessedStreamId,
	lastEventAt: null,
	lastErrorAt: null,
	lastGapAt: null,
	gapCount: 0,
	lastGapRecoveryAt: null,
	retrying: false,
	subscriberRecreations: 0,
}

export function getCacheInvalidationHealthSnapshot(): CacheInvalidationHealthSnapshot {
	return { ...cacheInvalidationHealth, cursor: lastProcessedStreamId }
}

function setReplayState(state: CacheInvalidationHealthSnapshot['replayState']): void {
	cacheInvalidationHealth.replayState = state
}

function recordCacheInvalidationError(): void {
	cacheInvalidationHealth.lastErrorAt = Date.now()
}

function singleLineLogValue(value: string, maxLength = 256): string {
	return Array.from(value, (character) => {
		const code = character.charCodeAt(0)
		return code <= 0x1f || code === 0x7f || character === '\u2028' || character === '\u2029' ? ' ' : character
	})
		.join('')
		.slice(0, maxLength)
}

function safeCursorFileBasename(cursorFile: string): string {
	const name = basename(cursorFile)
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ? name : '<unsafe-basename>'
}

function cursorLogContext(cursorFile: string): { cursorFile: string; cursorFileConfigured: boolean } {
	return {
		cursorFile: safeCursorFileBasename(cursorFile),
		cursorFileConfigured: Boolean(process.env.WISP_CACHE_INVALIDATION_CURSOR_FILE),
	}
}

function errorKind(error: unknown): string {
	if (error instanceof Error && error.name) return singleLineLogValue(error.name, 80)
	return 'UnknownError'
}

function siteLogContext(did: string, rkey: string): { did: string; rkey: string } {
	return { did: singleLineLogValue(did), rkey: singleLineLogValue(rkey) }
}

function invalidationLogContext(parsed: CacheInvalidationMessage): Record<string, string | boolean | undefined> {
	if (parsed.action === 'domain') {
		return {
			action: parsed.action,
			domain: parsed.domain === undefined ? undefined : singleLineLogValue(parsed.domain),
			domainKind: parsed.domainKind,
			hasCustomDomainId: Boolean(parsed.customDomainId),
		}
	}

	return {
		action: parsed.action,
		...siteLogContext(parsed.did ?? '(missing)', parsed.rkey ?? '(missing)'),
		tokenized: Boolean(parsed.token),
	}
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeStreamId(streamId: string | undefined): string | undefined {
	if (!streamId) return undefined
	const trimmed = streamId.trim()
	return STREAM_ID_PATTERN.test(trimmed) ? trimmed : undefined
}

function parseStreamIdParts(streamId: string): [bigint, bigint] {
	const normalized = normalizeStreamId(streamId)
	if (!normalized) {
		throw new Error('Invalid Redis stream ID')
	}

	const [msRaw, seqRaw] = normalized.split('-') as [string, string]
	return [BigInt(msRaw), BigInt(seqRaw)]
}

export function compareStreamIds(a: string, b: string): number {
	const [aMs, aSeq] = parseStreamIdParts(a)
	const [bMs, bSeq] = parseStreamIdParts(b)
	if (aMs < bMs) return -1
	if (aMs > bMs) return 1
	if (aSeq < bSeq) return -1
	if (aSeq > bSeq) return 1
	return 0
}

function loadCursorFromDisk(): void {
	replayCursorIsEstablished = false
	const cursorFile = getCursorFile()
	if (!existsSync(cursorFile)) return

	try {
		const stored = normalizeStreamId(readFileSync(cursorFile, 'utf8'))
		if (!stored) {
			logger.warn('[CacheInvalidation] Invalid cursor file ignored', {
				operation: 'cursor-load',
				...cursorLogContext(cursorFile),
			})
			return
		}
		lastProcessedStreamId = stored
		replayCursorIsEstablished = true
		logger.info('[CacheInvalidation] Replay cursor loaded', {
			operation: 'cursor-load',
			streamId: stored,
			...cursorLogContext(cursorFile),
		})
	} catch (err) {
		recordCacheInvalidationError()
		logger.error('[CacheInvalidation] Cursor load failed', undefined, {
			operation: 'cursor-load',
			...cursorLogContext(cursorFile),
			errorKind: errorKind(err),
		})
	}
}

function queueCursorPersist(streamId: string): Promise<void> {
	const cursorFile = getCursorFile()
	const normalized = normalizeStreamId(streamId)
	if (!normalized) {
		recordCacheInvalidationError()
		logger.error('[CacheInvalidation] Cursor persistence rejected invalid stream ID', undefined, {
			operation: 'cursor-persist',
			streamIdValid: false,
			...cursorLogContext(cursorFile),
		})
		return Promise.resolve()
	}

	const persistTask = cursorPersistQueue
		.catch(() => undefined)
		.then(async () => {
			const dir = dirname(cursorFile)
			const tmp = `${cursorFile}.tmp`
			await mkdir(dir, { recursive: true })
			await writeFile(tmp, `${normalized}\n`, 'utf8')
			await rename(tmp, cursorFile)
		})

	// Keep the shared tail usable after a failed write, while preserving the
	// individual task rejection for replay-gap recovery to fail closed.
	cursorPersistQueue = persistTask.catch((err) => {
		recordCacheInvalidationError()
		logger.error('[CacheInvalidation] Cursor persistence failed', undefined, {
			operation: 'cursor-persist',
			streamId: normalized,
			...cursorLogContext(cursorFile),
			errorKind: errorKind(err),
		})
	})
	return persistTask
}

function advanceStreamCursor(streamId: string | undefined): void {
	const normalized = normalizeStreamId(streamId)
	if (!normalized) return
	if (compareStreamIds(normalized, lastProcessedStreamId) <= 0) return
	lastProcessedStreamId = normalized
	replayCursorIsEstablished = true
	void queueCursorPersist(normalized).catch(() => undefined)
}

function shouldSkipReplayMessage(streamId: string | undefined): boolean {
	const normalized = normalizeStreamId(streamId)
	if (!normalized) return false
	return compareStreamIds(normalized, lastProcessedStreamId) <= 0
}

type XInfoField = { found: boolean; value: unknown }

function findXInfoField(streamInfo: unknown[], wantedField: string): XInfoField {
	for (let index = 0; index < streamInfo.length - 1; index += 2) {
		if (streamInfo[index] === wantedField) return { found: true, value: streamInfo[index + 1] }
	}
	return { found: false, value: undefined }
}

function parseXInfoLength(value: unknown): number | undefined {
	if (typeof value === 'number') return value
	if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
	return undefined
}

function parseXInfoFirstEntry(value: unknown): string | undefined {
	if (value === null) return undefined
	if (!Array.isArray(value) || typeof value[0] !== 'string') {
		throw new Error('Malformed Redis XINFO first-entry response')
	}
	const firstStreamId = normalizeStreamId(value[0])
	if (!firstStreamId) throw new Error('Malformed Redis XINFO first-entry ID')
	return firstStreamId
}

function extractFirstStreamEntryId(streamInfo: unknown): string | undefined {
	if (!Array.isArray(streamInfo)) throw new Error('Malformed Redis XINFO STREAM response')
	if (streamInfo.length === 0) return undefined

	const firstEntry = findXInfoField(streamInfo, 'first-entry')
	if (firstEntry.found) return parseXInfoFirstEntry(firstEntry.value)

	if (parseXInfoLength(findXInfoField(streamInfo, 'length').value) === 0) return undefined
	throw new Error('Malformed Redis XINFO STREAM response')
}

async function recoverReplayCursorGap(firstStreamId: string): Promise<void> {
	const priorCursor = lastProcessedStreamId
	cacheInvalidationHealth.lastGapAt = Date.now()
	cacheInvalidationHealth.gapCount += 1
	cacheInvalidationHealth.retrying = false
	setReplayState('degraded')
	recordCacheInvalidationError()
	logger.warn('[CacheInvalidation] Replay retention gap detected; starting fail-closed recovery', {
		operation: 'replay-gap-detected',
		priorCursor,
		firstRetainedStreamId: firstStreamId,
		gapCount: cacheInvalidationHealth.gapCount,
	})

	const recovery = cacheInvalidationGapRecoveryDependencies
	// All local state must be cleared before the cursor can move. A failure in
	// any step leaves the old cursor intact and makes the loop retry recovery.
	await recovery.clearMutableCaches()
	await recovery.clearUpdatingAndTerminalState()
	await recovery.resetHtmlPrewarmState()
	await recovery.evictHotTier()
	await recovery.validateWarmCacheSourceCids()

	// Persist the reset before exposing it in memory. If this fails, retain the
	// old cursor and retry rather than replaying with an unrecorded safe point.
	await queueCursorPersist('0-0')
	lastProcessedStreamId = '0-0'
	replayCursorIsEstablished = false
	cacheInvalidationHealth.lastGapRecoveryAt = Date.now()
	setReplayState('starting')
	logger.info('[CacheInvalidation] Replay retention gap recovered; replaying retained stream', {
		operation: 'replay-gap-recovered',
		priorCursor,
		firstRetainedStreamId: firstStreamId,
		resetCursor: lastProcessedStreamId,
		gapCount: cacheInvalidationHealth.gapCount,
	})
}

async function ensureReplayCursorIsRetained(client: Redis): Promise<boolean> {
	// A first boot has no established cursor to prove was behind a trimmed range.
	// Once replay has a cursor, a cursor that predates first-entry needs a local
	// cache reset before replay can safely resume from the retained history.
	if (!replayCursorIsEstablished) return true

	let streamInfo: unknown
	try {
		streamInfo = await client.xinfo('STREAM', STREAM)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		if (/no such key/i.test(message)) return true
		throw err
	}

	const firstStreamId = extractFirstStreamEntryId(streamInfo)
	if (!firstStreamId || compareStreamIds(lastProcessedStreamId, firstStreamId) >= 0) {
		return true
	}

	await recoverReplayCursorGap(firstStreamId)
	return true
}

export function parseCacheInvalidationMessage(message: string): CacheInvalidationMessage | null {
	const parsed = decodeCacheInvalidationMessage(message)
	if (!parsed) return null
	parsed.streamId = normalizeStreamId(typeof parsed.streamId === 'string' ? parsed.streamId : undefined)
	return parsed
}

export function parseCacheInvalidationStreamEntry(streamId: string, fields: string[]): CacheInvalidationMessage | null {
	const payload: Record<string, string> = {}
	for (let index = 0; index < fields.length - 1; index += 2) {
		payload[fields[index]!] = fields[index + 1]!
	}
	delete payload.ts
	return parseCacheInvalidationMessage(JSON.stringify({ ...payload, streamId }))
}

/** Directly invalidate one tier by listing and deleting all keys with the given prefix. */
async function invalidateTier(tier: StorageTier, prefix: string): Promise<number> {
	if (tier.deletePrefix) {
		return await tier.deletePrefix(prefix)
	}

	const keys: string[] = []
	for await (const key of tier.listKeys(prefix)) {
		keys.push(key)
	}
	if (keys.length > 0) {
		await tier.deleteMany(keys)
	}
	return keys.length
}

async function invalidateSiteFileTiers(
	did: string,
	rkey: string,
	dependencies: CacheInvalidationDependencies,
): Promise<{ hotDeleted: number; warmDeleted: number; failures: unknown[] }> {
	const prefix = `${did}/${rkey}/`

	// Production goes through TieredStorage so a lower-tier read cannot promote stale
	// bytes after this upper-cache purge. Explicit test tiers retain the direct path.
	if (dependencies.storage) {
		const result = await dependencies.storage.invalidateUpperCaches(prefix)
		for (const failure of result.failures) {
			logger.error('[CacheInvalidation] Tier invalidation failed', undefined, {
				operation: 'site-tier-invalidate',
				tier: failure.tier,
				...siteLogContext(did, rkey),
				errorKind: errorKind(failure.reason),
			})
		}
		return {
			hotDeleted: result.hotDeleted,
			warmDeleted: result.warmDeleted,
			failures: result.failures.map((failure) => failure.reason),
		}
	}

	const tiers: Array<{ tier: StorageTier; name: 'hot' | 'warm' }> = [{ tier: dependencies.hotTier, name: 'hot' }]
	if (dependencies.warmTier) {
		tiers.push({ tier: dependencies.warmTier, name: 'warm' })
	}

	// Attempt every tier even when one fails. The successful work is idempotent, while
	// reporting a failure keeps the replay cursor behind this event for a retry.
	const results = await Promise.allSettled(tiers.map(({ tier }) => invalidateTier(tier, prefix)))
	let hotDeleted = 0
	let warmDeleted = 0
	const failures: unknown[] = []

	for (const [index, result] of results.entries()) {
		const { name } = tiers[index]!
		if (result.status === 'fulfilled') {
			if (name === 'hot') {
				hotDeleted = result.value
			} else {
				warmDeleted = result.value
			}
			continue
		}

		logger.error('[CacheInvalidation] Tier invalidation failed', undefined, {
			operation: 'site-tier-invalidate',
			tier: name,
			...siteLogContext(did, rkey),
			errorKind: errorKind(result.reason),
		})
		failures.push(result.reason)
	}

	return { hotDeleted, warmDeleted, failures }
}

function advanceReplayCursor(source: 'pubsub' | 'replay', streamId: string | undefined): void {
	if (source === 'replay') {
		advanceStreamCursor(streamId)
	}
}

async function applyCacheInvalidation(
	parsed: CacheInvalidationMessage,
	source: 'pubsub' | 'replay',
	dependencies = getCacheInvalidationDependencies(),
): Promise<void> {
	const { did, rkey, action, token, streamId } = parsed
	cacheInvalidationHealth.lastEventAt = Date.now()

	// Pub/sub is only a low-latency hint. It must not move the durable cursor because
	// a later live message can otherwise skip earlier ordered stream entries.
	if (source === 'replay' && shouldSkipReplayMessage(streamId)) {
		logger.info('[CacheInvalidation] Duplicate replay event skipped', {
			operation: 'event-skip-duplicate',
			source,
			streamId,
			...invalidationLogContext(parsed),
		})
		return
	}

	logger.info('[CacheInvalidation] Invalidation event received', {
		operation: 'event-received',
		source,
		streamId,
		...invalidationLogContext(parsed),
	})

	if (action === 'domain') {
		applyDomainCacheInvalidation(parsed, dependencies.cache)
		advanceReplayCursor(source, streamId)
		return
	}

	if (!did || !rkey) {
		logger.warn('[CacheInvalidation] Site invalidation missing identifier', {
			operation: 'site-event-invalid',
			source,
			streamId,
			action,
			hasDid: Boolean(did),
			hasRkey: Boolean(rkey),
		})
		advanceReplayCursor(source, streamId)
		return
	}

	if (action === 'updating') {
		if (isUpdatingSupersededByTerminal(did, rkey, streamId)) {
			logger.info('[CacheInvalidation] Superseded updating marker ignored', {
				operation: 'updating-marker-skip',
				source,
				streamId,
				...siteLogContext(did, rkey),
			})
			advanceReplayCursor(source, streamId)
			return
		}

		markSiteUpdating(did, rkey, token, streamId)
		advanceReplayCursor(source, streamId)
		logger.info('[CacheInvalidation] Site marked updating', {
			operation: 'updating-marker-set',
			source,
			streamId,
			...siteLogContext(did, rkey),
			tokenized: Boolean(token),
		})
		return
	}

	if (action === 'settings') {
		// Settings affect routing and fallback paths, but do not change stored site files.
		dependencies.cache.delete('redirectRules', `${did}:${rkey}`)
		dependencies.cache.delete('settings', `${did}:${rkey}`)
		dependencies.cache.deletePrefix('siteFiles', `${did}:${rkey}:`)
		dependencies.cache.deletePrefix('sourceCidMismatches', `${did}:${rkey}:`)
		advanceReplayCursor(source, streamId)
		return
	}

	// Do not remove a matching updating marker until every file-tier purge has
	// succeeded. A replay retry must keep serving the updating state, not stale
	// or partially refreshed cache content, while a terminal invalidation fails.
	const canClearUpdating = canClearSiteUpdating(did, rkey, token, streamId)
	if (!canClearUpdating && action === 'update' && token) {
		// The marker may be absent after a restart/TTL expiry, or belong to a newer
		// update. In either case, final invalidation is still required and idempotent.
		logger.info('[CacheInvalidation] Updating marker absent; invalidating anyway', {
			operation: 'updating-marker-missing',
			reason: 'missing-or-replaced',
			source,
			streamId,
			...siteLogContext(did, rkey),
		})
	} else if (!canClearUpdating && streamId) {
		// A newer start may stay visible, but terminal cache cleanup is still safe.
		logger.info('[CacheInvalidation] Updating marker not clearable; invalidating anyway', {
			operation: 'updating-marker-missing',
			reason: 'newer-marker',
			source,
			streamId,
			...siteLogContext(did, rkey),
		})
	}

	const { hotDeleted, warmDeleted, failures } = await invalidateSiteFileTiers(did, rkey, dependencies)

	logger.info('[CacheInvalidation] Site file tiers invalidated', {
		operation: 'site-tier-invalidate',
		hotDeleted,
		warmDeleted,
		source,
		streamId,
		...siteLogContext(did, rkey),
	})

	dependencies.cache.delete('redirectRules', `${did}:${rkey}`)
	dependencies.cache.delete('settings', `${did}:${rkey}`)
	dependencies.cache.delete('siteCache', `${did}:${rkey}`)
	dependencies.cache.deletePrefix('siteFiles', `${did}:${rkey}:`)
	dependencies.cache.deletePrefix('sourceCidMismatches', `${did}:${rkey}:`)
	dependencies.resetSiteHtmlHotCacheWarmup(did, rkey)

	if (failures.length > 0) {
		recordCacheInvalidationError()
		throw new AggregateError(failures, '[CacheInvalidation] Failed to invalidate file caches')
	}

	if (canClearUpdating) {
		clearSiteUpdating(did, rkey, token, streamId)
	}

	// Only a completed terminal invalidation can supersede an older replayed start.
	recordTerminalSiteStreamId(did, rkey, streamId)
	advanceReplayCursor(source, streamId)
}

export async function applyCacheInvalidationForTests(
	parsed: CacheInvalidationMessage,
	source: 'pubsub' | 'replay' = 'pubsub',
	dependencies?: CacheInvalidationDependenciesForTests,
): Promise<void> {
	await applyCacheInvalidation(parsed, source, getCacheInvalidationDependencies(dependencies))
}

export function getLastProcessedStreamIdForTests(): string {
	return lastProcessedStreamId
}

export async function resetCacheInvalidationReplayForTests(): Promise<void> {
	await processingQueue
	await cursorPersistQueue.catch(() => undefined)
	// A previous test's in-flight stop must finish before the lifecycle reset,
	// otherwise its teardown tail can race the next test's start.
	if (stopPromise) await stopPromise
	// Subscriber lifecycle reset so each test starts from 'idle' again.
	stopSubscriberHeartbeat()
	stopSubscriberSupervisor()
	subscriberContext = null
	subscriberGeneration += 1
	subscriberReadyAttempt += 1
	subscriberRecreations = 0
	subscriberSubscriptionAcked = false
	subscriberLastPongAt = null
	subscriberUnhealthySince = null
	subscriber = null
	replayClient = null
	stopReplayRequested = false
	replayLoop = null
	lifecycleState = 'idle'
	stopPromise = null
	lastProcessedStreamId = '0-0'
	replayCursorIsEstablished = false
	processingQueue = Promise.resolve()
	cursorPersistQueue = Promise.resolve()
	cacheInvalidationGapRecoveryDependencies = getCacheInvalidationGapRecoveryDependencies()
	cacheInvalidationHealth = {
		subscriberConnected: false,
		replayConnected: false,
		replayState: 'stopped',
		cursor: lastProcessedStreamId,
		lastEventAt: null,
		lastErrorAt: null,
		lastGapAt: null,
		gapCount: 0,
		lastGapRecoveryAt: null,
		retrying: false,
		subscriberRecreations: 0,
	}
}

function applyDomainCacheInvalidation(parsed: CacheInvalidationMessage, invalidationCache: InvalidationCache): void {
	const domain = parsed.domain?.trim().toLowerCase()
	if (!domain) return

	if (parsed.domainKind !== 'custom') {
		invalidationCache.delete('domains', domain)
	}

	if (parsed.domainKind !== 'wisp') {
		invalidationCache.delete('customDomains', domain)
		if (parsed.customDomainId) {
			invalidationCache.delete('customDomains', parsed.customDomainId)
			invalidationCache.delete('customDomains', `hash:${parsed.customDomainId}`)
		}
	}

	logger.info('[CacheInvalidation] Domain lookup cache invalidated', {
		operation: 'domain-cache-clear',
		...invalidationLogContext({ ...parsed, domain }),
	})
}

function enqueueCacheInvalidation(parsed: CacheInvalidationMessage, source: 'pubsub' | 'replay'): Promise<void> {
	// Keep the shared queue usable after a failed replay entry, but return the task
	// itself so the replay loop sees the failure and leaves its cursor unchanged.
	const task = processingQueue.catch(() => undefined).then(() => applyCacheInvalidation(parsed, source))
	processingQueue = task.catch(() => undefined)
	return task
}

function createReplayClient(redisUrl: string, redisClientFactory: CacheInvalidationRedisFactory): Redis {
	const client = redisClientFactory(redisUrl, {
		maxRetriesPerRequest: 2,
		enableReadyCheck: true,
		// ioredis gives XREAD its own bounded client-side timer. A normal Redis
		// BLOCK response arrives before this grace period, so idle reads do not
		// reconnect. A zombie command resolves instead of hanging this loop.
		blockingTimeout: STREAM_BLOCK_MS + STREAM_BLOCKING_GRACE_MS,
		blockingTimeoutGrace: STREAM_BLOCKING_GRACE_MS,
		// If a half-open socket never delivers data, destroy it after a longer
		// bound. ioredis then uses its standard reconnect strategy and backoff.
		socketTimeout: STREAM_SOCKET_TIMEOUT_MS,
	})

	client.on('error', (err) => {
		cacheInvalidationHealth.replayConnected = false
		recordCacheInvalidationError()
		setReplayState('degraded')
		logger.error('[CacheInvalidation] Replay Redis client error', undefined, {
			operation: 'redis-replay-client',
			errorKind: errorKind(err),
		})
	})
	client.on('close', () => {
		cacheInvalidationHealth.replayConnected = false
	})
	client.on('end', () => {
		cacheInvalidationHealth.replayConnected = false
	})
	client.on('ready', () => {
		cacheInvalidationHealth.replayConnected = true
		setReplayState('starting')
		logger.info('[CacheInvalidation] Redis replay client connected', { operation: 'redis-replay-client-ready' })
		ensureReplayLoopStarted()
	})

	return client
}

type ReplayStreamEntries = Array<[string, string[]]>
type ReplayResponse = Array<[string, ReplayStreamEntries]>

async function readReplayBatch(client: Redis): Promise<ReplayResponse | null> {
	// BLOCK bounds normal idle reads. ioredis's blockingTimeout resolves a
	// half-open command after BLOCK + grace, while socketTimeout tears down a
	// socket that never receives any data and lets normal reconnect take over.
	return (await client.xread(
		'COUNT',
		STREAM_BATCH_COUNT,
		'BLOCK',
		STREAM_BLOCK_MS,
		'STREAMS',
		STREAM,
		lastProcessedStreamId,
	)) as ReplayResponse | null
}

function waitForReplayRetry(): Promise<void> {
	cacheInvalidationHealth.retrying = true
	return new Promise((resolve) => {
		let settled = false
		let timer: ReturnType<typeof setTimeout> | undefined
		const cancel = () => {
			if (timer) clearTimeout(timer)
			if (settled) return
			settled = true
			if (cancelReplayRetryWait === cancel) {
				cancelReplayRetryWait = null
			}
			cacheInvalidationHealth.retrying = false
			resolve()
		}

		timer = setTimeout(cancel, 1000)
		cancelReplayRetryWait = cancel
	})
}

function markReplayReadHealthy(): void {
	cacheInvalidationHealth.replayConnected = true
	cacheInvalidationHealth.retrying = false
	setReplayState('healthy')
}

function discardMalformedReplayEntry(streamId: string): void {
	// This is ordered replay handling too: discard permanently malformed entries
	// so they cannot wedge the cursor.
	cacheInvalidationHealth.lastEventAt = Date.now()
	logger.warn('[CacheInvalidation] Invalid replay stream entry discarded', {
		operation: 'replay-entry-invalid',
		stream: singleLineLogValue(STREAM),
		streamId: normalizeStreamId(streamId) ?? '<invalid-stream-id>',
	})
	advanceStreamCursor(streamId)
}

async function processReplayEntry(streamId: string, fields: string[]): Promise<void> {
	const parsed = parseCacheInvalidationStreamEntry(streamId, fields)
	if (!parsed) {
		discardMalformedReplayEntry(streamId)
		return
	}
	await enqueueCacheInvalidation(parsed, 'replay')
}

async function processReplayEntries(entries: ReplayStreamEntries): Promise<void> {
	for (const [streamId, fields] of entries) {
		await processReplayEntry(streamId, fields)
	}
}

async function processReplayResponse(response: ReplayResponse | null): Promise<void> {
	if (!response) return
	for (const [, entries] of response) {
		await processReplayEntries(entries)
	}
}

async function runReplayIteration(client: Redis): Promise<boolean> {
	if (!(await ensureReplayCursorIsRetained(client))) return false
	const response = await readReplayBatch(client)
	markReplayReadHealthy()
	await processReplayResponse(response)
	return true
}

async function handleReplayLoopError(error: unknown): Promise<void> {
	recordCacheInvalidationError()
	setReplayState('degraded')
	logger.error('[CacheInvalidation] Replay loop error', undefined, {
		operation: 'replay-loop',
		errorKind: errorKind(error),
	})
	// Avoid a tight loop while ioredis performs its normal reconnect handling.
	await waitForReplayRetry()
}

async function runReplayLoop(): Promise<void> {
	logger.info('[CacheInvalidation] Replay loop starting', {
		operation: 'replay-loop-start',
		stream: singleLineLogValue(STREAM),
		cursor: lastProcessedStreamId,
	})

	while (!stopReplayRequested) {
		try {
			const client = replayClient
			if (!client || !(await runReplayIteration(client))) return
		} catch (error) {
			if (stopReplayRequested) return
			await handleReplayLoopError(error)
		}
	}
}

function handleReplayLoopCrash(error: unknown): void {
	if (stopReplayRequested) return
	recordCacheInvalidationError()
	setReplayState('degraded')
	logger.error('[CacheInvalidation] Replay loop crashed', undefined, {
		operation: 'replay-loop',
		errorKind: errorKind(error),
	})
}

function ensureReplayLoopStarted(): void {
	if (!replayClient || replayLoop || stopReplayRequested) return
	replayLoop = runReplayLoop()
		.catch(handleReplayLoopCrash)
		.finally(() => {
			replayLoop = null
		})
}

function stopSubscriberHeartbeat(): void {
	if (cancelSubscriberHeartbeat === null) return
	cancelSubscriberHeartbeat()
	cancelSubscriberHeartbeat = null
}

function startSubscriberHeartbeat(client: Redis, scheduleInterval: CacheInvalidationHeartbeatIntervalScheduler): void {
	// 'ready' fires again on every reconnect, so always restart from a cleared
	// state instead of stacking a second interval for the same subscriber.
	stopSubscriberHeartbeat()
	const heartbeat = scheduleInterval(() => {
		if (cancelSubscriberHeartbeat !== heartbeat) return
		const generation = subscriberGeneration
		// Attach the rejection handler immediately: a PING against a half-open or
		// reconnecting connection must never surface as an unhandled rejection.
		client
			.ping()
			.then(() => {
				if (cancelSubscriberHeartbeat !== heartbeat) return
				if (generation !== subscriberGeneration || subscriber !== client) return
				subscriberLastPongAt = Date.now()
			})
			.catch((err) => {
				// A PING in flight after stop, close/end, or a reconnect that
				// restarted the heartbeat is expected teardown noise.
				if (cancelSubscriberHeartbeat !== heartbeat) return
				recordCacheInvalidationError()
				logger.error('[CacheInvalidation] Redis subscriber heartbeat ping failed', undefined, {
					operation: 'redis-subscriber-heartbeat',
					errorKind: errorKind(err),
				})
				recreateSubscriberClient('heartbeat-ping-failed')
			})
	}, SUBSCRIBER_PING_INTERVAL_MS)
	cancelSubscriberHeartbeat = heartbeat
	logger.info('[CacheInvalidation] Redis subscriber heartbeat started', {
		operation: 'redis-subscriber-heartbeat-start',
		pingIntervalMs: SUBSCRIBER_PING_INTERVAL_MS,
		pongDeadlineMs: SUBSCRIBER_RECREATE_AFTER_MS,
	})
}

function createSubscriberClient(
	generation: number,
	ctx: {
		redisUrl: string
		factory: CacheInvalidationRedisFactory
		scheduleHeartbeatInterval: CacheInvalidationHeartbeatIntervalScheduler
	},
): void {
	// No ioredis socketTimeout: it is cleared by any inbound data and cannot
	// bound a swallowed PING. Liveness is the heartbeat plus the supervisor.
	const client = ctx.factory(ctx.redisUrl, {
		maxRetriesPerRequest: 2,
		enableReadyCheck: true,
		// autoResubscribe re-sends SUBSCRIBE without a callback, so the ack
		// could never re-fire. Every 'ready' issues its own fenced subscribe.
		autoResubscribe: false,
	})
	subscriber = client
	subscriberSubscriptionAcked = false
	subscriberLastPongAt = null
	subscriberUnhealthySince = null
	const isCurrent = () => generation === subscriberGeneration && subscriber === client

	client.on('error', (err) => {
		if (!isCurrent()) return
		subscriberReadyAttempt += 1
		subscriberSubscriptionAcked = false
		cacheInvalidationHealth.subscriberConnected = false
		recordCacheInvalidationError()
		logger.error('[CacheInvalidation] Redis subscriber error', undefined, {
			operation: 'redis-subscriber',
			errorKind: errorKind(err),
		})
	})
	client.on('close', () => {
		if (!isCurrent()) return
		subscriberReadyAttempt += 1
		subscriberSubscriptionAcked = false
		cacheInvalidationHealth.subscriberConnected = false
		// The connection is gone; a keepalive PING can only fail or queue until
		// the client reconnects and 'ready' restarts the heartbeat.
		stopSubscriberHeartbeat()
	})
	client.on('end', () => {
		if (!isCurrent()) return
		subscriberReadyAttempt += 1
		subscriberSubscriptionAcked = false
		cacheInvalidationHealth.subscriberConnected = false
		stopSubscriberHeartbeat()
	})

	client.on('ready', () => {
		if (!isCurrent()) return
		// Health needs the SUBSCRIBE ack for THIS connection; until it lands
		// the supervisor clocks this client for replacement.
		const attempt = ++subscriberReadyAttempt
		logger.info('[CacheInvalidation] Redis subscriber connected', { operation: 'redis-subscriber-ready' })
		startSubscriberHeartbeat(client, ctx.scheduleHeartbeatInterval)
		// One explicit SUBSCRIBE per (re)connect, fenced by generation and attempt.
		client.subscribe(CHANNEL, (err) => {
			if (!isCurrent() || attempt !== subscriberReadyAttempt) return
			if (err) {
				subscriberSubscriptionAcked = false
				cacheInvalidationHealth.subscriberConnected = false
				recordCacheInvalidationError()
				logger.error('[CacheInvalidation] Redis subscription failed', undefined, {
					operation: 'redis-subscribe',
					channel: CHANNEL,
					errorKind: errorKind(err),
				})
			} else {
				subscriberSubscriptionAcked = true
				subscriberUnhealthySince = null
				cacheInvalidationHealth.subscriberConnected = true
				logger.info('[CacheInvalidation] Redis subscription established', {
					operation: 'redis-subscribe',
					channel: CHANNEL,
				})
			}
		})
	})

	client.on('message', (_channel: string, message: string) => {
		if (!isCurrent()) return
		const parsed = parseCacheInvalidationMessage(message)
		if (!parsed) {
			recordCacheInvalidationError()
			logger.warn('[CacheInvalidation] Invalid pub/sub message discarded', { operation: 'pubsub-message-invalid' })
			return
		}

		void enqueueCacheInvalidation(parsed, 'pubsub').catch((err) => {
			if (!isCurrent()) return
			recordCacheInvalidationError()
			logger.error('[CacheInvalidation] Pub/sub message processing failed', undefined, {
				operation: 'pubsub-message-process',
				errorKind: errorKind(err),
			})
		})
	})
}

function stopSubscriberSupervisor(): void {
	if (cancelSubscriberSupervisor === null) return
	cancelSubscriberSupervisor()
	cancelSubscriberSupervisor = null
	subscriberUnhealthySince = null
}

function startSubscriberSupervisor(
	scheduleInterval: CacheInvalidationHeartbeatIntervalScheduler,
	recreateAfterMs: number,
): void {
	stopSubscriberSupervisor()
	cancelSubscriberSupervisor = scheduleInterval(() => {
		const ctx = subscriberContext
		if (lifecycleState !== 'active' || ctx === null) return
		const client = subscriber
		const now = Date.now()
		// Connected + acked + PONGs settling within the recreate window.
		if (client && client.status === 'ready' && subscriberSubscriptionAcked) {
			if (subscriberLastPongAt === null || now - subscriberLastPongAt >= recreateAfterMs) {
				if (subscriberUnhealthySince === null) subscriberUnhealthySince = now
				else if (now - subscriberUnhealthySince >= recreateAfterMs) {
					recreateSubscriberClient('supervisor-pong-stale')
				}
				return
			}
			subscriberUnhealthySince = null
			return
		}
		// Reconnecting / never connected / ready-without-ack: clock to recreate.
		if (subscriberUnhealthySince === null) {
			subscriberUnhealthySince = now
			return
		}
		if (now - subscriberUnhealthySince >= recreateAfterMs) {
			recreateSubscriberClient('supervisor-unhealthy-timeout')
		}
	}, SUBSCRIBER_SUPERVISOR_INTERVAL_MS)
	logger.info('[CacheInvalidation] Redis subscriber supervisor started', {
		operation: 'subscriber-supervisor-start',
		intervalMs: SUBSCRIBER_SUPERVISOR_INTERVAL_MS,
		recreateAfterMs,
	})
}

function recreateSubscriberClient(reason: string): void {
	const ctx = subscriberContext
	if (ctx === null || lifecycleState !== 'active') return
	subscriberGeneration += 1
	subscriberRecreations += 1
	cacheInvalidationHealth.subscriberRecreations = subscriberRecreations
	cacheInvalidationHealth.subscriberConnected = false
	subscriberReadyAttempt += 1
	subscriberSubscriptionAcked = false
	subscriberLastPongAt = null
	subscriberUnhealthySince = null
	stopSubscriberHeartbeat()
	const stale = subscriber
	subscriber = null
	logger.warn('[CacheInvalidation] Redis subscriber wedged; recreating client', {
		operation: 'subscriber-recreate',
		reason,
		recreations: subscriberRecreations,
	})
	stale?.disconnect()
	createSubscriberClient(subscriberGeneration, ctx)
}

function startCacheInvalidationSubscriberWithFactory(
	redisClientFactory: CacheInvalidationRedisFactory,
	gapRecoveryOverrides?: CacheInvalidationGapRecoveryDependencies,
	heartbeatOptions?: CacheInvalidationSubscriberHeartbeatOptions,
	supervisorOptions?: CacheInvalidationSubscriberSupervisorOptions,
): void {
	if (lifecycleState !== 'idle' || stopPromise !== null) {
		logger.warn('[CacheInvalidation] Cache invalidation start ignored; lifecycle already active or stopping', {
			operation: 'subscriber-start-ignored',
			lifecycleState,
		})
		return
	}
	const scheduleHeartbeatInterval = heartbeatOptions?.scheduleInterval ?? scheduleRealHeartbeatInterval
	const scheduleSupervisorInterval = supervisorOptions?.scheduleInterval ?? scheduleRealHeartbeatInterval
	const recreateAfterMs = supervisorOptions?.recreateAfterMs ?? SUBSCRIBER_RECREATE_AFTER_MS
	cacheInvalidationGapRecoveryDependencies = getCacheInvalidationGapRecoveryDependencies(gapRecoveryOverrides)
	const redisUrl = process.env.REDIS_URL
	if (!redisUrl) {
		cacheInvalidationHealth.subscriberConnected = false
		cacheInvalidationHealth.replayConnected = false
		cacheInvalidationHealth.retrying = false
		setReplayState('stopped')
		logger.warn('[CacheInvalidation] Redis is not configured; cache invalidation disabled', {
			operation: 'subscriber-start',
			redisConfigured: false,
		})
		return
	}

	lifecycleState = 'active'
	subscriberRecreations = 0

	cacheInvalidationHealth = {
		subscriberConnected: false,
		replayConnected: false,
		replayState: 'starting',
		cursor: lastProcessedStreamId,
		lastEventAt: null,
		lastErrorAt: null,
		lastGapAt: null,
		gapCount: 0,
		lastGapRecoveryAt: null,
		retrying: false,
		subscriberRecreations: 0,
	}
	loadCursorFromDisk()
	stopReplayRequested = false

	logger.info('[CacheInvalidation] Connecting to Redis subscriber', {
		operation: 'subscriber-start',
		redisConfigured: true,
		pingIntervalMs: SUBSCRIBER_PING_INTERVAL_MS,
		pongDeadlineMs: SUBSCRIBER_RECREATE_AFTER_MS,
		supervisorIntervalMs: SUBSCRIBER_SUPERVISOR_INTERVAL_MS,
		recreateAfterMs,
	})
	subscriberContext = { redisUrl, factory: redisClientFactory, scheduleHeartbeatInterval }
	createSubscriberClient(subscriberGeneration, subscriberContext)
	startSubscriberSupervisor(scheduleSupervisorInterval, recreateAfterMs)

	replayClient = createReplayClient(redisUrl, redisClientFactory)

	ensureReplayLoopStarted()
}

/**
 * Start cache invalidation. Callers with an additional warm-cache source-CID
 * validation pass can supply it through the gap-recovery seam.
 */
export function startCacheInvalidationSubscriber(
	gapRecoveryOverrides?: CacheInvalidationGapRecoveryDependencies,
): void {
	startCacheInvalidationSubscriberWithFactory(defaultRedisClientFactory, gapRecoveryOverrides)
}

export function startCacheInvalidationSubscriberForTests(
	redisClientFactory: CacheInvalidationRedisFactory,
	gapRecoveryOverrides?: CacheInvalidationGapRecoveryDependencies,
	heartbeatOptions?: CacheInvalidationSubscriberHeartbeatOptions,
	supervisorOptions?: CacheInvalidationSubscriberSupervisorOptions,
): void {
	startCacheInvalidationSubscriberWithFactory(
		redisClientFactory,
		gapRecoveryOverrides,
		heartbeatOptions,
		supervisorOptions,
	)
}

export function stopCacheInvalidationSubscriber(): Promise<void> {
	if (stopPromise !== null) return stopPromise
	if (lifecycleState === 'idle') return Promise.resolve()
	stopPromise = performCacheInvalidationStop().finally(() => {
		stopPromise = null
	})
	return stopPromise
}

async function performCacheInvalidationStop(): Promise<void> {
	if (lifecycleState === 'idle') return
	lifecycleState = 'stopping'
	stopReplayRequested = true
	cancelReplayRetryWait?.()
	// Clear the keepalive first so no PING races the closing socket, and an
	// in-flight PING rejection is treated as expected teardown noise.
	stopSubscriberHeartbeat()
	stopSubscriberSupervisor()
	subscriberContext = null
	subscriberGeneration += 1
	subscriberReadyAttempt += 1
	subscriberSubscriptionAcked = false
	subscriberLastPongAt = null
	subscriberUnhealthySince = null
	cacheInvalidationHealth.subscriberConnected = false
	cacheInvalidationHealth.replayConnected = false
	cacheInvalidationHealth.retrying = false
	setReplayState('stopped')

	// Disconnect before awaiting the loop so a BLOCKing XREAD rejects immediately.
	// disconnect() also prevents ioredis from scheduling another reconnect on shutdown.
	const replayToClose = replayClient
	replayClient = null
	replayToClose?.disconnect()

	const subscriberToClose = subscriber
	subscriber = null
	subscriberToClose?.disconnect()

	await replayLoop
	await processingQueue
	await cursorPersistQueue.catch(() => undefined)
	lifecycleState = 'idle'
}
