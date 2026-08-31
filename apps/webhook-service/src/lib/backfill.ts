import {
	createPinnedIdentityFetcher,
	getPdsForDid,
	type IdentityGetFetcher,
	isCanonicalWebhookDid,
	parseWebhookScopeAtUri,
	readBoundedIdentityJson,
	validateWebhookRecord,
} from '@wispplace/atproto-utils'
import { createLogger } from '@wispplace/observability'
import type { OwnerReconciliationToken, WebhookSnapshotRecord } from './db'
import {
	applyWebhookSnapshotPage,
	beginOwnerReconciliation,
	completeOwnerReconciliation,
	failOwnerReconciliation,
	listFailedWebhookReconciliationOwners,
	listKnownWebhookOwnerDidsPage,
} from './db'
import { assertSafeWebhookUrlSyntax } from './webhook-url'

export type { WebhookSnapshotRecord } from './db'

const logger = createLogger('webhook-service:backfill')
// The option is inert unless the transport's two development-only env gates are set.
const backfillIdentityGet = createPinnedIdentityFetcher({ allowLoopback: true })
const MAX_BACKFILL_PAGES = 20
const MAX_BACKFILL_RECORDS = 1_000
// Twenty bounded decoded pages cannot exceed the 10 MiB owner scan budget.
const MAX_BACKFILL_PAGE_BYTES = 512 * 1024
const MAX_CURSOR_LENGTH = 2_048
const DEFAULT_OWNER_PAGE_SIZE = 50
const MAX_OWNER_PAGE_SIZE = 1_000
const DEFAULT_OWNERS_PER_PASS = 1_000
const MAX_OWNERS_PER_PASS = 10_000
const DEFAULT_OWNER_CONCURRENCY = 1
const MAX_OWNER_CONCURRENCY = 4

type PageHandler = (records: readonly WebhookSnapshotRecord[]) => Promise<void> | void

interface ListRecordsResponse {
	records: WebhookSnapshotRecord[]
	omitted: number
	cursor?: string
}

export interface StartupBackfillResult {
	found: number
	failed: number
	/** Present only when a bounded pass must resume from this keyset cursor. */
	nextOwnerCursor?: string
}

export interface StartupBackfillProgress {
	scanned: number
	found: number
	failed: number
	capped: boolean
	nextOwnerCursor?: string
}

export type OwnerReconciliationStatus = 'scanning' | 'complete' | 'failed'
export type OwnerTransitionCallback = (did: string, status: OwnerReconciliationStatus) => Promise<void> | void

export interface StartupBackfillOptions {
	fetcher?: IdentityGetFetcher
	onOwnerTransition?: OwnerTransitionCallback
	/** Bounded keyset page source; injectable for tests and explicit continuation jobs. */
	listOwnerPage?: (after: string | undefined, limit: number) => Promise<readonly string[]>
	ownerPageSize?: number
	maxOwnersPerPass?: number
	concurrency?: number
	startAfter?: string
	onProgress?: (progress: StartupBackfillProgress) => Promise<void> | void
	signal?: AbortSignal
}

function boundedBackfillOption(value: number | undefined, fallback: number, maximum: number, name: string): number {
	const actual = value ?? fallback
	if (!Number.isSafeInteger(actual) || actual < 1 || actual > maximum) throw new Error(`Invalid ${name}`)
	return actual
}

function assertOwnerPage(page: readonly string[], after: string | undefined): void {
	let previous = after
	for (const did of page) {
		if (!isCanonicalWebhookDid(did) || (previous !== undefined && did <= previous)) {
			throw new ReconciliationInfrastructureFailure()
		}
		previous = did
	}
}

async function mapBounded<T>(
	values: readonly T[],
	concurrency: number,
	worker: (value: T) => Promise<void>,
): Promise<void> {
	let cursor = 0
	const run = async () => {
		while (cursor < values.length) {
			const index = cursor++
			await worker(values[index] as T)
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run))
}

function invalidPdsResponse(): never {
	throw new Error('Webhook backfill response is invalid')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function owns(value: object, key: string): boolean {
	return Object.getOwnPropertyDescriptor(value, key) !== undefined
}

function parseWebhookRecord(value: unknown) {
	const validation = validateWebhookRecord(value)
	// A malformed record is omitted, not loosely repaired. A complete snapshot
	// then authoritatively removes any stale local row for its rkey.
	if (!validation.ok) return null
	try {
		// Keep startup intake aligned with live firehose validation. DNS pinning is
		// deliberately deferred to delivery; literal private targets are rejected now.
		assertSafeWebhookUrlSyntax(validation.record.url)
	} catch {
		return null
	}
	return validation.record
}

function parseOwnedWebhookUri(uri: string, did: string): string {
	if (uri.length > 4_096) invalidPdsResponse()
	const parsed = parseWebhookScopeAtUri(uri)
	if (!parsed || parsed.did !== did || parsed.collection !== 'place.wisp.v2.wh' || !parsed.rkey) invalidPdsResponse()
	if (uri !== `at://${did}/place.wisp.v2.wh/${parsed.rkey}`) invalidPdsResponse()
	return parsed.rkey
}

function parseListRecordsResponse(value: unknown, did: string): ListRecordsResponse {
	if (!isPlainObject(value) || !Array.isArray(value.records) || value.records.length > 100) invalidPdsResponse()
	const hasCursor = owns(value, 'cursor')
	if (
		hasCursor &&
		(typeof value.cursor !== 'string' || value.cursor.length === 0 || value.cursor.length > MAX_CURSOR_LENGTH)
	) {
		invalidPdsResponse()
	}

	const seenRkeys = new Set<string>()
	const records = value.records.map((entry): WebhookSnapshotRecord | null => {
		if (
			!isPlainObject(entry) ||
			typeof entry.uri !== 'string' ||
			typeof entry.cid !== 'string' ||
			entry.cid.length === 0 ||
			entry.cid.length > 256
		) {
			invalidPdsResponse()
		}
		const rkey = parseOwnedWebhookUri(entry.uri, did)
		if (seenRkeys.has(rkey)) invalidPdsResponse()
		seenRkeys.add(rkey)
		const record = parseWebhookRecord(entry.value)
		return record ? { rkey, cid: entry.cid, record } : null
	})
	const cleanRecords = records.filter((record): record is WebhookSnapshotRecord => record !== null)
	return {
		records: cleanRecords,
		omitted: records.length - cleanRecords.length,
		cursor: hasCursor ? (value.cursor as string) : undefined,
	}
}

function listRecordsUrl(pdsUrl: string, did: string, cursor: string | undefined): string {
	const params = new URLSearchParams({
		repo: did,
		collection: 'place.wisp.v2.wh',
		limit: '100',
	})
	if (cursor) params.set('cursor', cursor)
	const url = new URL('xrpc/com.atproto.repo.listRecords', `${pdsUrl}/`)
	url.search = params.toString()
	return url.toString()
}

async function discardResponse(response: Response): Promise<void> {
	try {
		await response.body?.cancel()
	} catch {
		// The peer may already have closed the response.
	}
}

async function resolveBackfillPds(did: string, fetcher: IdentityGetFetcher, signal?: AbortSignal): Promise<string> {
	if (!isCanonicalWebhookDid(did)) throw new Error('Webhook backfill DID is invalid')
	const pdsUrl = await getPdsForDid(did, fetcher, { allowLoopback: true }, { signal })
	if (!pdsUrl) throw new Error('Webhook backfill has no valid PDS endpoint')
	return pdsUrl
}

/**
 * Fetch one owner's records page by page. Every page is fully parsed and
 * bounded before the callback can apply it. A later failure leaves final owner
 * classification to the reconciliation caller rather than finalizing deletes.
 */
export async function fetchWhRecordPages(
	did: string,
	onPage: PageHandler,
	fetcher: IdentityGetFetcher = backfillIdentityGet,
	signal?: AbortSignal,
): Promise<number> {
	const pdsUrl = await resolveBackfillPds(did, fetcher, signal)
	const seenCursors = new Set<string>()
	const seenRkeys = new Set<string>()
	let cursor: string | undefined
	let total = 0

	for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
		const response = await fetcher(listRecordsUrl(pdsUrl, did, cursor), { signal })
		if (!response.ok) {
			await discardResponse(response)
			throw new Error('Webhook backfill PDS request failed')
		}
		const data = parseListRecordsResponse(await readBoundedIdentityJson(response, MAX_BACKFILL_PAGE_BYTES, signal), did)
		if (data.omitted > 0)
			logger.warn(`[backfill] Omitted ${data.omitted} invalid webhook record(s) from a snapshot page`)
		if (total + data.records.length > MAX_BACKFILL_RECORDS) throw new Error('Webhook backfill record limit exceeded')
		for (const record of data.records) {
			if (seenRkeys.has(record.rkey)) invalidPdsResponse()
			seenRkeys.add(record.rkey)
		}
		await onPage(data.records)
		total += data.records.length
		if (data.cursor === undefined) return total
		if (seenCursors.has(data.cursor)) invalidPdsResponse()
		seenCursors.add(data.cursor)
		cursor = data.cursor
	}
	throw new Error('Webhook backfill page limit exceeded')
}

/** Compatibility helper for callers that explicitly need a bounded in-memory snapshot. */
export async function fetchWhRecordsForDid(
	did: string,
	fetcher: IdentityGetFetcher = backfillIdentityGet,
	signal?: AbortSignal,
): Promise<WebhookSnapshotRecord[]> {
	const records: WebhookSnapshotRecord[] = []
	await fetchWhRecordPages(
		did,
		(page) => {
			records.push(...page)
		},
		fetcher,
		signal,
	)
	return records
}

class OwnerScanFailure extends Error {
	constructor() {
		super('Webhook backfill owner scan failed')
	}
}

class ReconciliationInfrastructureFailure extends Error {
	constructor() {
		super('Webhook reconciliation infrastructure failed')
	}
}

async function notifyOwnerTransition(
	did: string,
	status: OwnerReconciliationStatus,
	callback: OwnerTransitionCallback | undefined,
): Promise<void> {
	try {
		await callback?.(did, status)
	} catch {
		throw new ReconciliationInfrastructureFailure()
	}
}

async function markOwnerFailed(
	token: OwnerReconciliationToken,
	did: string,
	callback: OwnerTransitionCallback | undefined,
): Promise<void> {
	try {
		await failOwnerReconciliation(token)
	} catch {
		throw new ReconciliationInfrastructureFailure()
	}
	await notifyOwnerTransition(did, 'failed', callback)
}

async function reconcileOwner(
	did: string,
	fetcher: IdentityGetFetcher,
	onOwnerTransition: OwnerTransitionCallback | undefined,
	signal?: AbortSignal,
): Promise<number> {
	let token: OwnerReconciliationToken
	try {
		token = await beginOwnerReconciliation(did)
	} catch {
		throw new ReconciliationInfrastructureFailure()
	}
	try {
		await notifyOwnerTransition(did, 'scanning', onOwnerTransition)
	} catch {
		try {
			await markOwnerFailed(token, did, onOwnerTransition)
		} catch {
			// The scan remains `scanning` (and therefore unmatchable) if the DB is down.
		}
		throw new ReconciliationInfrastructureFailure()
	}

	let found = 0
	try {
		await fetchWhRecordPages(
			did,
			async (records) => {
				let result: { applied: boolean; upserted: number }
				try {
					result = await applyWebhookSnapshotPage(token, records)
				} catch {
					throw new ReconciliationInfrastructureFailure()
				}
				if (!result.applied) throw new OwnerScanFailure()
				found += result.upserted
			},
			fetcher,
			signal,
		)
	} catch (error) {
		if (error instanceof ReconciliationInfrastructureFailure) throw error
		await markOwnerFailed(token, did, onOwnerTransition)
		throw new OwnerScanFailure()
	}

	let complete: { applied: boolean; deleted: number; complete: boolean }
	try {
		do {
			if (signal?.aborted) throw new OwnerScanFailure()
			complete = await completeOwnerReconciliation(token)
			if (!complete.applied) break
			// Each DB call finalizes one bounded, timeout-protected transaction.
			// Continue only after that durable batch commits, so a restart safely
			// resumes from the remaining rows rather than holding a giant lock.
		} while (!complete.complete)
	} catch (error) {
		if (error instanceof OwnerScanFailure) {
			await markOwnerFailed(token, did, onOwnerTransition)
			throw error
		}
		// A transient finalization failure should become retryable once the DB
		// returns. If that write also fails, the stale-scanning recovery query
		// eventually admits this owner after its grace period.
		try {
			await markOwnerFailed(token, did, onOwnerTransition)
		} catch {
			// Preserve the infrastructure failure without assuming DB availability.
		}
		throw new ReconciliationInfrastructureFailure()
	}
	if (!complete!.applied || !complete!.complete) {
		await markOwnerFailed(token, did, onOwnerTransition)
		throw new OwnerScanFailure()
	}
	await notifyOwnerTransition(did, 'complete', onOwnerTransition)
	return found
}

/** Retry one already-degraded owner. Infrastructure failures remain fatal to the caller. */
export async function retryFailedWebhookOwner(did: string, options: StartupBackfillOptions = {}): Promise<boolean> {
	try {
		await reconcileOwner(did, options.fetcher ?? backfillIdentityGet, options.onOwnerTransition, options.signal)
		return true
	} catch (error) {
		if (error instanceof ReconciliationInfrastructureFailure) throw error
		return false
	}
}

export interface ReconciliationRetrySchedulerOptions {
	fetcher?: IdentityGetFetcher
	onOwnerTransition?: OwnerTransitionCallback
	listFailedOwners?: (limit: number) => Promise<readonly string[]>
	now?: () => number
	random?: () => number
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
	maxOwners?: number
	concurrency?: number
	baseDelayMs?: number
	maxDelayMs?: number
	discoveryIntervalMs?: number
}

export interface ReconciliationRetryHealth {
	running: boolean
	infrastructureHealthy: boolean
	active: number
	queued: number
	scheduled: number
	lastInfrastructureFailureAt?: number
}

export interface ReconciliationRetryStopOptions {
	timeoutMs?: number
	signal?: AbortSignal
}

export interface ReconciliationRetryScheduler {
	start(): Promise<void>
	/** Stops admission immediately, aborts active network reads, and waits only to its deadline. */
	stop(options?: ReconciliationRetryStopOptions): Promise<{ drained: boolean }>
	readonly health: ReconciliationRetryHealth
}

interface ScheduledOwnerRetry {
	timer: ReturnType<typeof setTimeout>
	dueAt: number
	generation: number
}

interface ActiveOwnerRetry {
	generation: number
	controller: AbortController
}

function schedulerInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
	const resolved = value ?? fallback
	if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new RangeError(`${name} is invalid`)
	return resolved
}

function schedulerRandom(random: () => number): number {
	try {
		const value = random()
		return Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999_999_999) : 0.5
	} catch {
		return 0.5
	}
}

const MIN_RECONCILIATION_RETRY_DELAY_MS = 100
const MAX_RECONCILIATION_RETRY_ATTEMPTS = 100
const DEFAULT_RECONCILIATION_STOP_TIMEOUT_MS = 10_000
const MAX_RECONCILIATION_STOP_TIMEOUT_MS = 120_000

class OwnerRetryScheduler implements ReconciliationRetryScheduler {
	readonly #fetcher: IdentityGetFetcher
	readonly #transition: OwnerTransitionCallback | undefined
	readonly #listFailedOwners: (limit: number) => Promise<readonly string[]>
	readonly #now: () => number
	readonly #random: () => number
	readonly #setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
	readonly #clearTimer: (timer: ReturnType<typeof setTimeout>) => void
	readonly #maxOwners: number
	readonly #concurrency: number
	readonly #baseDelayMs: number
	readonly #maxDelayMs: number
	readonly #discoveryIntervalMs: number
	readonly #attempts = new Map<string, number>()
	readonly #scheduled = new Map<string, ScheduledOwnerRetry>()
	readonly #queued = new Set<string>()
	readonly #active = new Map<string, ActiveOwnerRetry>()
	#discoveryTimer: ReturnType<typeof setTimeout> | undefined
	#generation = 0
	#started = false
	#stopped = false
	#infrastructureHealthy = true
	#lastInfrastructureFailureAt: number | undefined
	#drainWaiters: Array<() => void> = []

	constructor(options: ReconciliationRetrySchedulerOptions) {
		this.#fetcher = options.fetcher ?? backfillIdentityGet
		this.#transition = options.onOwnerTransition
		this.#listFailedOwners = options.listFailedOwners ?? listFailedWebhookReconciliationOwners
		this.#now = options.now ?? Date.now
		this.#random = options.random ?? Math.random
		this.#setTimer = options.setTimer ?? setTimeout
		this.#clearTimer = options.clearTimer ?? clearTimeout
		this.#maxOwners = schedulerInteger(options.maxOwners, 16, 1, 100, 'Reconciliation retry owner limit')
		this.#concurrency = schedulerInteger(options.concurrency, 1, 1, 2, 'Reconciliation retry concurrency')
		this.#baseDelayMs = schedulerInteger(options.baseDelayMs, 5_000, 0, 60_000, 'Reconciliation retry base delay')
		this.#maxDelayMs = schedulerInteger(
			options.maxDelayMs,
			60 * 60_000,
			1_000,
			60 * 60_000,
			'Reconciliation retry max delay',
		)
		this.#discoveryIntervalMs = schedulerInteger(
			options.discoveryIntervalMs,
			60_000,
			1_000,
			60 * 60_000,
			'Reconciliation retry discovery interval',
		)
	}

	get health(): ReconciliationRetryHealth {
		return {
			running: this.#started && !this.#stopped,
			infrastructureHealthy: this.#infrastructureHealthy,
			active: this.#active.size,
			queued: this.#queued.size,
			scheduled: this.#scheduled.size,
			...(this.#lastInfrastructureFailureAt === undefined
				? {}
				: { lastInfrastructureFailureAt: this.#lastInfrastructureFailureAt }),
		}
	}

	async start(): Promise<void> {
		if (this.#started && !this.#stopped) return
		this.#generation++
		this.#started = true
		this.#stopped = false
		await this.#discover(this.#generation)
	}

	async stop(options: ReconciliationRetryStopOptions = {}): Promise<{ drained: boolean }> {
		this.#generation++
		this.#stopped = true
		this.#started = false
		if (this.#discoveryTimer) this.#clearTimer(this.#discoveryTimer)
		this.#discoveryTimer = undefined
		for (const { timer } of this.#scheduled.values()) this.#clearTimer(timer)
		this.#scheduled.clear()
		this.#queued.clear()
		for (const active of this.#active.values()) active.controller.abort()
		if (this.#active.size === 0) return { drained: true }
		const timeoutMs = schedulerInteger(
			options.timeoutMs,
			DEFAULT_RECONCILIATION_STOP_TIMEOUT_MS,
			0,
			MAX_RECONCILIATION_STOP_TIMEOUT_MS,
			'Reconciliation retry stop timeout',
		)
		return new Promise((resolve) => {
			let settled = false
			let onDrain: (() => void) | undefined
			const finish = (drained: boolean) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				options.signal?.removeEventListener('abort', abort)
				if (onDrain) {
					const index = this.#drainWaiters.indexOf(onDrain)
					if (index >= 0) this.#drainWaiters.splice(index, 1)
				}
				resolve({ drained })
			}
			const abort = () => finish(false)
			const timer = setTimeout(abort, timeoutMs)
			onDrain = () => finish(true)
			if (options.signal?.aborted) abort()
			else options.signal?.addEventListener('abort', abort, { once: true })
			if (!settled) this.#drainWaiters.push(onDrain)
		})
	}

	#reportInfrastructureFailure(): void {
		this.#infrastructureHealthy = false
		this.#lastInfrastructureFailureAt = this.#now()
	}

	#scheduleDiscovery(generation: number): void {
		if (this.#stopped || !this.#started || generation !== this.#generation) return
		this.#discoveryTimer = this.#setTimer(() => {
			this.#discoveryTimer = undefined
			void this.#discover(generation)
		}, this.#discoveryIntervalMs)
	}

	async #discover(generation: number): Promise<void> {
		if (this.#stopped || !this.#started || generation !== this.#generation) return
		try {
			const owners = await this.#listFailedOwners(this.#maxOwners)
			if (this.#stopped || !this.#started || generation !== this.#generation) return
			this.#infrastructureHealthy = true
			for (const ownerDid of owners) this.#scheduleOwner(ownerDid, this.#attempts.get(ownerDid) ?? 0, generation)
		} catch {
			if (generation === this.#generation) this.#reportInfrastructureFailure()
		} finally {
			this.#scheduleDiscovery(generation)
		}
	}

	#delayFor(attempt: number): number {
		const exponent = Math.min(Math.max(attempt, 0), 16)
		const cap = Math.max(
			MIN_RECONCILIATION_RETRY_DELAY_MS,
			Math.min(this.#baseDelayMs * 2 ** exponent, this.#maxDelayMs),
		)
		return Math.max(MIN_RECONCILIATION_RETRY_DELAY_MS, Math.floor(schedulerRandom(this.#random) * cap))
	}

	#rememberAttempt(did: string, attempt: number): void {
		this.#attempts.delete(did)
		this.#attempts.set(did, attempt)
		while (this.#attempts.size > MAX_RECONCILIATION_RETRY_ATTEMPTS) {
			const oldest = this.#attempts.keys().next().value as string
			this.#attempts.delete(oldest)
		}
	}

	#scheduleOwner(did: string, attempt: number, generation: number): void {
		const trackedOwners = this.#scheduled.size + this.#queued.size + this.#active.size
		if (
			this.#stopped ||
			!this.#started ||
			!isCanonicalWebhookDid(did) ||
			this.#scheduled.has(did) ||
			this.#queued.has(did) ||
			this.#active.has(did) ||
			trackedOwners >= this.#maxOwners ||
			generation !== this.#generation
		) {
			return
		}
		const delay = this.#delayFor(attempt)
		const timer = this.#setTimer(() => {
			if (this.#scheduled.get(did)?.generation !== generation) return
			this.#scheduled.delete(did)
			if (this.#stopped || !this.#started || generation !== this.#generation) return
			this.#queued.add(did)
			this.#pump(generation)
		}, delay)
		this.#scheduled.set(did, { timer, dueAt: this.#now() + delay, generation })
	}

	#pump(generation: number): void {
		while (
			!this.#stopped &&
			generation === this.#generation &&
			this.#active.size < this.#concurrency &&
			this.#queued.size > 0
		) {
			const did = this.#queued.values().next().value as string
			this.#queued.delete(did)
			const controller = new AbortController()
			this.#active.set(did, { generation, controller })
			void this.#runOwner(did, generation, controller.signal).then(
				(shouldRetry) => this.#finishOwner(did, generation, shouldRetry),
				() => this.#finishOwner(did, generation, true),
			)
		}
	}

	async #runOwner(did: string, generation: number, signal: AbortSignal): Promise<boolean> {
		try {
			const recovered = await retryFailedWebhookOwner(did, {
				fetcher: this.#fetcher,
				onOwnerTransition: this.#transition,
				signal,
			})
			if (recovered) {
				if (generation === this.#generation) {
					this.#attempts.delete(did)
					this.#infrastructureHealthy = true
				}
				return false
			}
		} catch {
			if (generation === this.#generation) this.#reportInfrastructureFailure()
		}
		if (this.#stopped || !this.#started || generation !== this.#generation) return false
		const nextAttempt = (this.#attempts.get(did) ?? 0) + 1
		this.#rememberAttempt(did, nextAttempt)
		return true
	}

	#finishOwner(did: string, generation: number, shouldRetry: boolean): void {
		if (this.#active.get(did)?.generation !== generation) return
		this.#active.delete(did)
		if (shouldRetry && !this.#stopped && this.#started && generation === this.#generation) {
			this.#scheduleOwner(did, this.#attempts.get(did) ?? 0, generation)
		}
		this.#pump(generation)
		if (this.#active.size === 0) {
			for (const resolve of this.#drainWaiters.splice(0)) resolve()
		}
	}
}

/** Create a bounded, stoppable failed-owner reconciliation retry lifecycle. */
export function createReconciliationRetryScheduler(
	options: ReconciliationRetrySchedulerOptions = {},
): ReconciliationRetryScheduler {
	return new OwnerRetryScheduler(options)
}

/**
 * On startup, reconcile every known owner through a fenced, page-at-a-time
 * scan. One unavailable owner becomes degraded; healthy owners still complete.
 */
export async function runStartupBackfill(
	fetcherOrOptions: IdentityGetFetcher | StartupBackfillOptions = backfillIdentityGet,
	callback?: OwnerTransitionCallback,
): Promise<StartupBackfillResult> {
	const options =
		typeof fetcherOrOptions === 'function'
			? { fetcher: fetcherOrOptions, onOwnerTransition: callback }
			: fetcherOrOptions
	const fetcher = options.fetcher ?? backfillIdentityGet
	const onOwnerTransition = options.onOwnerTransition ?? callback
	const listOwnerPage = options.listOwnerPage ?? listKnownWebhookOwnerDidsPage
	const pageSize = boundedBackfillOption(
		options.ownerPageSize,
		DEFAULT_OWNER_PAGE_SIZE,
		MAX_OWNER_PAGE_SIZE,
		'known owner page size',
	)
	const maxOwners = boundedBackfillOption(
		options.maxOwnersPerPass,
		DEFAULT_OWNERS_PER_PASS,
		MAX_OWNERS_PER_PASS,
		'known owner pass limit',
	)
	const concurrency = boundedBackfillOption(
		options.concurrency,
		DEFAULT_OWNER_CONCURRENCY,
		MAX_OWNER_CONCURRENCY,
		'known owner concurrency',
	)
	let after = options.startAfter
	let scanned = 0
	let found = 0
	let failed = 0
	let capped = false
	const progress = async (nextOwnerCursor?: string) => {
		await options.onProgress?.({ scanned, found, failed, capped, nextOwnerCursor })
	}

	for (;;) {
		if (options.signal?.aborted) break
		const remaining = maxOwners - scanned
		if (remaining <= 0) {
			capped = true
			break
		}
		const requestLimit = Math.min(pageSize, remaining)
		let page: readonly string[]
		try {
			page = await listOwnerPage(after, requestLimit)
			if (page.length > requestLimit) throw new ReconciliationInfrastructureFailure()
			assertOwnerPage(page, after)
		} catch (error) {
			if (error instanceof ReconciliationInfrastructureFailure) throw error
			throw new ReconciliationInfrastructureFailure()
		}
		if (page.length === 0) break
		// The page is the only queued owner set. Workers take at most `concurrency`
		// entries at once, so neither a large DB nor a slow PDS can grow memory.
		await mapBounded(page, concurrency, async (did) => {
			if (options.signal?.aborted) return
			try {
				found += await reconcileOwner(did, fetcher, onOwnerTransition, options.signal)
			} catch (error) {
				if (error instanceof ReconciliationInfrastructureFailure) throw error
				failed++
				logger.warn('[backfill] DID scan failed')
			}
			scanned++
		})
		if (options.signal?.aborted) break
		after = page[page.length - 1]
		if (scanned >= maxOwners) {
			capped = true
			await progress(after)
			break
		}
		// A caller can persist this completed page cursor immediately. A crash
		// may replay at most one completed owner page, never require an unbounded
		// rescan from the beginning.
		await progress(after)
		if (page.length < requestLimit) break
	}

	if (scanned === 0) logger.info('[backfill] No known DIDs to scan')
	logger.info(`[backfill] Done — ${found} webhook record(s) imported, ${failed} DID(s) failed`)
	return capped && after ? { found, failed, nextOwnerCursor: after } : { found, failed }
}
