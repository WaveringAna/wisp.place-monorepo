import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { createLogger } from '@wispplace/observability'
import {
	CACHE_ONLY,
	commitSiteAnalyticsBatch,
	type SiteAnalyticsBatch,
	type SiteAnalyticsBucket,
	type SiteAnalyticsCommitResult,
} from './db'

const logger = createLogger('site-analytics')
const HOUR_MS = 60 * 60 * 1000
const DEFAULT_FLUSH_INTERVAL_MS = 60_000
const DEFAULT_MAX_PENDING_BUCKETS = 10_000
export const MIN_ANALYTICS_FLUSH_INTERVAL_MS = 1_000
export const MAX_ANALYTICS_FLUSH_INTERVAL_MS = 24 * HOUR_MS
export const MIN_ANALYTICS_PENDING_BUCKETS = 1
export const MAX_ANALYTICS_PENDING_BUCKETS = 100_000

type CommitBatch = (batch: SiteAnalyticsBatch) => Promise<SiteAnalyticsCommitResult>
type MutableBucket = Omit<SiteAnalyticsBucket, 'ownerDid' | 'siteRkey' | 'bucketStart'>
type HourBuckets = Map<number, MutableBucket>
type SiteBuckets = Map<string, HourBuckets>
type OwnerBuckets = Map<string, SiteBuckets>
type StatusCounter = Exclude<keyof MutableBucket, 'requests' | 'htmlResponses'>

type RecordEligibility = { kind: 'eligible' } | { kind: 'ignored' }
type BucketReservation = { kind: 'available'; bucket: MutableBucket } | { kind: 'capacityReached' }

interface AnalyticsBucketStore {
	reserve(ownerDid: string, siteRkey: string, bucketStart: number): BucketReservation
	drain(): SiteAnalyticsBucket[]
	pendingCount(): number
}

export interface SiteAnalyticsStats {
	enabled: boolean
	pendingBuckets: number
	retryPending: boolean
	collectedRequests: number
	deliveredRequests: number
	droppedRequests: number
	skippedRequests: number
	batchesCommitted: number
	duplicateBatches: number
	flushFailures: number
	lastFlushAt: string | null
	lastFailureAt: string | null
}

export interface SiteAnalyticsCollector {
	record(ownerDid: string, siteRkey: string, method: string, statusCode: number, contentType: string | null): void
	flush(): Promise<void>
	start(): void
	stop(): Promise<void>
	getStats(): SiteAnalyticsStats
}

export interface SiteAnalyticsCollectorOptions {
	enabled: boolean
	commit?: CommitBatch
	flushIntervalMs?: number
	maxPendingBuckets?: number
	now?: () => number
	newBatchId?: () => string
	instanceId?: string
}

export interface SiteAnalyticsLimits {
	flushIntervalMs: number
	maxPendingBuckets: number
}

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
	const parsed =
		typeof value === 'number'
			? value
			: typeof value === 'string' && /^\d+$/.test(value.trim())
				? Number(value.trim())
				: Number.NaN

	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

/**
 * Normalizes both environment and programmatic collector settings. Invalid,
 * fractional, or unsafe values use safe defaults rather than changing timer
 * semantics or allowing an unbounded in-memory buffer.
 */
export function resolveSiteAnalyticsLimits(
	options: { flushIntervalMs?: unknown; maxPendingBuckets?: unknown } = {},
): SiteAnalyticsLimits {
	return {
		flushIntervalMs: boundedInteger(
			options.flushIntervalMs,
			DEFAULT_FLUSH_INTERVAL_MS,
			MIN_ANALYTICS_FLUSH_INTERVAL_MS,
			MAX_ANALYTICS_FLUSH_INTERVAL_MS,
		),
		maxPendingBuckets: boundedInteger(
			options.maxPendingBuckets,
			DEFAULT_MAX_PENDING_BUCKETS,
			MIN_ANALYTICS_PENDING_BUCKETS,
			MAX_ANALYTICS_PENDING_BUCKETS,
		),
	}
}

const errorKind = (error: unknown): string => {
	if (!(error instanceof Error)) return 'UnknownError'
	return error.constructor.name || 'Error'
}

const emptyBucket = (): MutableBucket => ({
	requests: 0,
	htmlResponses: 0,
	status2xx: 0,
	status3xx: 0,
	status4xx: 0,
	status5xx: 0,
})

const countRequests = (batch: SiteAnalyticsBatch): number => {
	let total = 0
	for (const bucket of batch.buckets) total += bucket.requests
	return total
}

const decideRecordEligibility = (
	enabled: boolean,
	ownerDid: string,
	siteRkey: string,
	method: string,
): RecordEligibility => {
	return enabled && method === 'GET' && ownerDid && siteRkey ? { kind: 'eligible' } : { kind: 'ignored' }
}

const statusCounterFor = (statusCode: number): StatusCounter | null => {
	if (statusCode >= 200 && statusCode < 300) return 'status2xx'
	if (statusCode >= 300 && statusCode < 400) return 'status3xx'
	if (statusCode >= 400 && statusCode < 500) return 'status4xx'
	if (statusCode >= 500 && statusCode < 600) return 'status5xx'
	return null
}

const recordBucketResponse = (bucket: MutableBucket, statusCode: number, contentType: string | null): void => {
	bucket.requests++
	if (contentType?.toLowerCase().startsWith('text/html')) bucket.htmlResponses++

	const statusCounter = statusCounterFor(statusCode)
	if (statusCounter) bucket[statusCounter]++
}

const createAnalyticsBucketStore = (maxPendingBuckets: number): AnalyticsBucketStore => {
	let buckets: OwnerBuckets = new Map()
	let pendingBucketCount = 0

	const reserve = (ownerDid: string, siteRkey: string, bucketStart: number): BucketReservation => {
		const sites = buckets.get(ownerDid)
		const hours = sites?.get(siteRkey)
		const existingBucket = hours?.get(bucketStart)
		if (existingBucket) return { kind: 'available', bucket: existingBucket }
		if (pendingBucketCount >= maxPendingBuckets) return { kind: 'capacityReached' }

		const nextSites = sites ?? new Map<string, HourBuckets>()
		if (!sites) buckets.set(ownerDid, nextSites)
		const nextHours = hours ?? new Map<number, MutableBucket>()
		if (!hours) nextSites.set(siteRkey, nextHours)

		const bucket = emptyBucket()
		nextHours.set(bucketStart, bucket)
		pendingBucketCount++
		return { kind: 'available', bucket }
	}

	const drain = (): SiteAnalyticsBucket[] => {
		const drained = buckets
		buckets = new Map()
		pendingBucketCount = 0

		const rows: SiteAnalyticsBucket[] = []
		for (const [ownerDid, sites] of drained) {
			for (const [siteRkey, hours] of sites) {
				for (const [bucketStart, bucket] of hours) {
					rows.push({ ownerDid, siteRkey, bucketStart, ...bucket })
				}
			}
		}
		return rows
	}

	return { reserve, drain, pendingCount: () => pendingBucketCount }
}

export function createSiteAnalyticsCollector(options: SiteAnalyticsCollectorOptions): SiteAnalyticsCollector {
	const enabled = options.enabled
	const commit = options.commit ?? commitSiteAnalyticsBatch
	const { flushIntervalMs, maxPendingBuckets } = resolveSiteAnalyticsLimits(options)
	const now = options.now ?? Date.now
	const newBatchId = options.newBatchId ?? randomUUID
	const instanceId = options.instanceId ?? `hosting-${os.hostname()}/${process.pid}/${randomUUID()}`

	const bucketStore = createAnalyticsBucketStore(maxPendingBuckets)
	let retryBatch: SiteAnalyticsBatch | null = null
	let timer: NodeJS.Timeout | null = null
	let flushPromise: Promise<void> | null = null

	let collectedRequests = 0
	let deliveredRequests = 0
	let droppedRequests = 0
	let skippedRequests = 0
	let batchesCommitted = 0
	let duplicateBatches = 0
	let flushFailures = 0
	let lastFlushAt: number | null = null
	let lastFailureAt: number | null = null

	const flushOnce = async (): Promise<void> => {
		if (!enabled) return
		if (!retryBatch && bucketStore.pendingCount() > 0) {
			retryBatch = {
				batchId: newBatchId(),
				instanceId,
				buckets: bucketStore.drain(),
			}
		}
		if (!retryBatch) return

		const batch = retryBatch
		try {
			const result = await commit(batch)
			deliveredRequests += countRequests(batch)
			skippedRequests += result.skippedRequests
			if (result.duplicate) duplicateBatches++
			else batchesCommitted++
			lastFlushAt = now()
			retryBatch = null
		} catch (error) {
			flushFailures++
			lastFailureAt = now()
			throw error
		}
	}

	const flush = (): Promise<void> => {
		if (flushPromise) return flushPromise
		flushPromise = flushOnce().finally(() => {
			flushPromise = null
		})
		return flushPromise
	}

	return {
		record(ownerDid, siteRkey, method, statusCode, contentType) {
			if (decideRecordEligibility(enabled, ownerDid, siteRkey, method).kind !== 'eligible') return

			const bucketStart = Math.floor(now() / HOUR_MS) * HOUR_MS
			const reservation = bucketStore.reserve(ownerDid, siteRkey, bucketStart)
			if (reservation.kind === 'capacityReached') {
				droppedRequests++
				return
			}

			recordBucketResponse(reservation.bucket, statusCode, contentType)
			collectedRequests++
		},

		flush,

		start() {
			if (!enabled || timer) return
			timer = setInterval(() => {
				void flush().catch((error) => {
					logger.error('aggregate flush failed; retaining batch for retry', undefined, {
						errorKind: errorKind(error),
					})
				})
			}, flushIntervalMs)
			timer.unref?.()
		},

		async stop() {
			if (timer) {
				clearInterval(timer)
				timer = null
			}
			await flush()
			if (!retryBatch && bucketStore.pendingCount() > 0) await flush()
		},

		getStats() {
			return {
				enabled,
				pendingBuckets: bucketStore.pendingCount() + (retryBatch?.buckets.length ?? 0),
				retryPending: retryBatch !== null,
				collectedRequests,
				deliveredRequests,
				droppedRequests,
				skippedRequests,
				batchesCommitted,
				duplicateBatches,
				flushFailures,
				lastFlushAt: lastFlushAt === null ? null : new Date(lastFlushAt).toISOString(),
				lastFailureAt: lastFailureAt === null ? null : new Date(lastFailureAt).toISOString(),
			}
		},
	}
}

const requested = process.env.ANALYTICS_ENABLED === 'true'
if (requested && CACHE_ONLY) {
	logger.warn('analytics requested but disabled because CACHE_ONLY=true')
}

const environmentLimits = resolveSiteAnalyticsLimits({
	flushIntervalMs: process.env.ANALYTICS_FLUSH_INTERVAL_MS,
	maxPendingBuckets: process.env.ANALYTICS_MAX_PENDING_BUCKETS,
})

export const siteAnalytics = createSiteAnalyticsCollector({
	enabled: requested && !CACHE_ONLY,
	...environmentLimits,
})
