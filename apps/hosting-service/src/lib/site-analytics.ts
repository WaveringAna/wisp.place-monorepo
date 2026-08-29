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

type CommitBatch = (batch: SiteAnalyticsBatch) => Promise<SiteAnalyticsCommitResult>
type MutableBucket = Omit<SiteAnalyticsBucket, 'ownerDid' | 'siteRkey' | 'bucketStart'>
type HourBuckets = Map<number, MutableBucket>
type SiteBuckets = Map<string, HourBuckets>
type OwnerBuckets = Map<string, SiteBuckets>

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

const positiveInteger = (value: string | undefined, fallback: number): number => {
	const parsed = Number.parseInt(value ?? '', 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
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

export function createSiteAnalyticsCollector(options: SiteAnalyticsCollectorOptions): SiteAnalyticsCollector {
	const enabled = options.enabled
	const commit = options.commit ?? commitSiteAnalyticsBatch
	const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
	const maxPendingBuckets = options.maxPendingBuckets ?? DEFAULT_MAX_PENDING_BUCKETS
	const now = options.now ?? Date.now
	const newBatchId = options.newBatchId ?? randomUUID
	const instanceId = options.instanceId ?? `hosting-${os.hostname()}/${process.pid}/${randomUUID()}`

	let buckets: OwnerBuckets = new Map()
	let pendingBucketCount = 0
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

	const flushOnce = async (): Promise<void> => {
		if (!enabled) return
		if (!retryBatch && pendingBucketCount > 0) {
			retryBatch = {
				batchId: newBatchId(),
				instanceId,
				buckets: drain(),
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
			if (!enabled || method !== 'GET' || !ownerDid || !siteRkey) return

			const bucketStart = Math.floor(now() / HOUR_MS) * HOUR_MS
			const existingSites = buckets.get(ownerDid)
			const existingHours = existingSites?.get(siteRkey)
			let bucket = existingHours?.get(bucketStart)

			if (!bucket) {
				if (pendingBucketCount >= maxPendingBuckets) {
					droppedRequests++
					return
				}
				const sites = existingSites ?? new Map<string, HourBuckets>()
				if (!existingSites) buckets.set(ownerDid, sites)
				const hours = existingHours ?? new Map<number, MutableBucket>()
				if (!existingHours) sites.set(siteRkey, hours)
				bucket = emptyBucket()
				hours.set(bucketStart, bucket)
				pendingBucketCount++
			}

			bucket.requests++
			if (contentType?.toLowerCase().startsWith('text/html')) bucket.htmlResponses++
			if (statusCode >= 200 && statusCode < 300) bucket.status2xx++
			else if (statusCode >= 300 && statusCode < 400) bucket.status3xx++
			else if (statusCode >= 400 && statusCode < 500) bucket.status4xx++
			else if (statusCode >= 500 && statusCode < 600) bucket.status5xx++
			collectedRequests++
		},

		flush,

		start() {
			if (!enabled || timer) return
			timer = setInterval(() => {
				void flush().catch((error) => {
					logger.error('aggregate flush failed; retaining batch for retry', error)
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
			if (!retryBatch && pendingBucketCount > 0) await flush()
		},

		getStats() {
			return {
				enabled,
				pendingBuckets: pendingBucketCount + (retryBatch?.buckets.length ?? 0),
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

export const siteAnalytics = createSiteAnalyticsCollector({
	enabled: requested && !CACHE_ONLY,
	flushIntervalMs: positiveInteger(process.env.ANALYTICS_FLUSH_INTERVAL_MS, DEFAULT_FLUSH_INTERVAL_MS),
	maxPendingBuckets: positiveInteger(process.env.ANALYTICS_MAX_PENDING_BUCKETS, DEFAULT_MAX_PENDING_BUCKETS),
})
