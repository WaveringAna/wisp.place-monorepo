import { describe, expect, test } from 'bun:test'
import type { SiteAnalyticsBatch, SiteAnalyticsBucket, SiteAnalyticsCommitResult } from './db'
import {
	createSiteAnalyticsCollector,
	MAX_ANALYTICS_FLUSH_INTERVAL_MS,
	MAX_ANALYTICS_PENDING_BUCKETS,
	MIN_ANALYTICS_FLUSH_INTERVAL_MS,
	MIN_ANALYTICS_PENDING_BUCKETS,
	resolveSiteAnalyticsLimits,
} from './site-analytics'

const accepted = (batch: SiteAnalyticsBatch): SiteAnalyticsCommitResult => ({
	duplicate: false,
	acceptedBuckets: batch.buckets.length,
	acceptedRequests: batch.buckets.reduce((total, bucket) => total + bucket.requests, 0),
	skippedBuckets: 0,
	skippedRequests: 0,
})

type StatusCounter = 'status2xx' | 'status3xx' | 'status4xx' | 'status5xx'
type AnalyticsResponseBranch = {
	status: number
	contentType: string | null
	counter: StatusCounter | null
	html: number
}

const analyticsResponseBranches: AnalyticsResponseBranch[] = [
	{ status: 199, contentType: null, counter: null, html: 0 },
	{ status: 200, contentType: 'TEXT/HTML; charset=utf-8', counter: 'status2xx', html: 1 },
	{ status: 299, contentType: 'text/plain', counter: 'status2xx', html: 0 },
	{ status: 300, contentType: 'text/htmlish', counter: 'status3xx', html: 1 },
	{ status: 399, contentType: 'application/xhtml+xml', counter: 'status3xx', html: 0 },
	{ status: 400, contentType: 'text/html', counter: 'status4xx', html: 1 },
	{ status: 499, contentType: 'TEXT/HTML', counter: 'status4xx', html: 1 },
	{ status: 500, contentType: 'text/html; charset=utf-8', counter: 'status5xx', html: 1 },
	{ status: 599, contentType: 'application/json', counter: 'status5xx', html: 0 },
	{ status: 600, contentType: 'text/plain', counter: null, html: 0 },
]

const expectedMetricsFor = (branch: AnalyticsResponseBranch) => ({
	requests: 1,
	htmlResponses: branch.html,
	status2xx: Number(branch.counter === 'status2xx'),
	status3xx: Number(branch.counter === 'status3xx'),
	status4xx: Number(branch.counter === 'status4xx'),
	status5xx: Number(branch.counter === 'status5xx'),
})

const expectResponseBranches = (
	rows: readonly SiteAnalyticsBucket[],
	branches: readonly AnalyticsResponseBranch[],
): void => {
	expect(rows).toHaveLength(branches.length)
	for (const [index, branch] of branches.entries()) {
		expect(rows[index]).toMatchObject(expectedMetricsFor(branch))
	}
}

describe('site analytics collector', () => {
	test('accepts inclusive configuration boundaries', () => {
		expect(
			resolveSiteAnalyticsLimits({
				flushIntervalMs: MIN_ANALYTICS_FLUSH_INTERVAL_MS,
				maxPendingBuckets: MIN_ANALYTICS_PENDING_BUCKETS,
			}),
		).toEqual({
			flushIntervalMs: MIN_ANALYTICS_FLUSH_INTERVAL_MS,
			maxPendingBuckets: MIN_ANALYTICS_PENDING_BUCKETS,
		})
		expect(
			resolveSiteAnalyticsLimits({
				flushIntervalMs: String(MAX_ANALYTICS_FLUSH_INTERVAL_MS),
				maxPendingBuckets: String(MAX_ANALYTICS_PENDING_BUCKETS),
			}),
		).toEqual({
			flushIntervalMs: MAX_ANALYTICS_FLUSH_INTERVAL_MS,
			maxPendingBuckets: MAX_ANALYTICS_PENDING_BUCKETS,
		})
	})

	test('falls back for unsafe, fractional, malformed, and out-of-range configuration', () => {
		const defaults = { flushIntervalMs: 60_000, maxPendingBuckets: 10_000 }
		for (const options of [
			{ flushIntervalMs: MIN_ANALYTICS_FLUSH_INTERVAL_MS - 1, maxPendingBuckets: 0 },
			{ flushIntervalMs: MAX_ANALYTICS_FLUSH_INTERVAL_MS + 1, maxPendingBuckets: MAX_ANALYTICS_PENDING_BUCKETS + 1 },
			{ flushIntervalMs: 2 ** 31, maxPendingBuckets: Number.MAX_SAFE_INTEGER },
			{ flushIntervalMs: 1_000.5, maxPendingBuckets: 1.5 },
			{ flushIntervalMs: '1000ms', maxPendingBuckets: '100001' },
		]) {
			expect(resolveSiteAnalyticsLimits(options)).toEqual(defaults)
		}
	})

	test('validates programmatic bucket limits before collecting traffic', async () => {
		const batches: SiteAnalyticsBatch[] = []
		const collector = createSiteAnalyticsCollector({
			enabled: true,
			flushIntervalMs: 2 ** 31,
			maxPendingBuckets: 0,
			now: () => Date.parse('2026-08-25T13:42:00Z'),
			commit: async (batch) => {
				batches.push(batch)
				return accepted(batch)
			},
		})

		collector.record('did:plc:owner', 'first-site', 'GET', 200, 'text/html')
		collector.record('did:plc:owner', 'second-site', 'GET', 200, 'text/html')
		await collector.flush()

		expect(batches[0]?.buckets).toHaveLength(2)
	})

	test('emits only hourly site aggregates for public GET responses', async () => {
		const batches: SiteAnalyticsBatch[] = []
		const collector = createSiteAnalyticsCollector({
			enabled: true,
			now: () => Date.parse('2026-08-25T13:42:00Z'),
			newBatchId: () => '00000000-0000-4000-8000-000000000001',
			instanceId: 'test-instance',
			commit: async (batch) => {
				batches.push(batch)
				return accepted(batch)
			},
		})

		collector.record('did:plc:owner', 'my-site', 'GET', 200, 'text/html; charset=utf-8')
		collector.record('did:plc:owner', 'my-site', 'GET', 404, 'text/plain')
		collector.record('did:plc:owner', 'my-site', 'HEAD', 200, 'text/html')
		await collector.flush()

		expect(batches).toHaveLength(1)
		expect(batches[0]?.batchId).toBe('00000000-0000-4000-8000-000000000001')
		expect(batches[0]?.instanceId).toBe('test-instance')
		expect(batches[0]?.buckets).toEqual([
			{
				ownerDid: 'did:plc:owner',
				siteRkey: 'my-site',
				bucketStart: Date.parse('2026-08-25T13:00:00Z'),
				requests: 2,
				htmlResponses: 1,
				status2xx: 1,
				status3xx: 0,
				status4xx: 1,
				status5xx: 0,
			},
		])
		expect(collector.getStats()).toMatchObject({
			pendingBuckets: 0,
			collectedRequests: 2,
			deliveredRequests: 2,
			droppedRequests: 0,
			batchesCommitted: 1,
		})
	})

	test('retries an uncertain commit with the same batch id', async () => {
		const batchIds: string[] = []
		let attempts = 0
		const collector = createSiteAnalyticsCollector({
			enabled: true,
			now: () => Date.parse('2026-08-25T13:42:00Z'),
			newBatchId: () => '00000000-0000-4000-8000-000000000002',
			commit: async (batch) => {
				batchIds.push(batch.batchId)
				attempts++
				if (attempts === 1) throw new Error('connection lost after commit')
				return { ...accepted(batch), duplicate: true }
			},
		})

		collector.record('did:plc:owner', 'my-site', 'GET', 200, 'text/html')
		await expect(collector.flush()).rejects.toThrow('connection lost after commit')
		expect(collector.getStats()).toMatchObject({ retryPending: true, flushFailures: 1, pendingBuckets: 1 })

		await collector.flush()
		expect(batchIds).toEqual(['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002'])
		expect(collector.getStats()).toMatchObject({
			retryPending: false,
			deliveredRequests: 1,
			duplicateBatches: 1,
		})
	})

	test('bounds new buckets without dropping traffic for an existing bucket', async () => {
		const batches: SiteAnalyticsBatch[] = []
		const collector = createSiteAnalyticsCollector({
			enabled: true,
			maxPendingBuckets: 1,
			now: () => Date.parse('2026-08-25T13:42:00Z'),
			commit: async (batch) => {
				batches.push(batch)
				return accepted(batch)
			},
		})

		collector.record('did:plc:owner', 'first-site', 'GET', 200, 'text/html')
		collector.record('did:plc:owner', 'second-site', 'GET', 200, 'text/html')
		collector.record('did:plc:owner', 'first-site', 'GET', 503, 'text/html')
		await collector.flush()

		expect(batches[0]?.buckets).toHaveLength(1)
		expect(batches[0]?.buckets[0]).toMatchObject({ siteRkey: 'first-site', requests: 2, status2xx: 1, status5xx: 1 })
		expect(collector.getStats()).toMatchObject({ collectedRequests: 2, droppedRequests: 1 })
	})

	test('does no work while disabled', async () => {
		let commits = 0
		const collector = createSiteAnalyticsCollector({
			enabled: false,
			commit: async (batch) => {
				commits++
				return accepted(batch)
			},
		})

		collector.record('did:plc:owner', 'my-site', 'GET', 200, 'text/html')
		await collector.flush()

		expect(commits).toBe(0)
		expect(collector.getStats()).toMatchObject({ enabled: false, collectedRequests: 0, pendingBuckets: 0 })
	})

	for (const scenario of [
		{ name: 'a disabled collector', enabled: false, ownerDid: 'did:plc:owner', siteRkey: 'site', method: 'GET' },
		{ name: 'a HEAD request', enabled: true, ownerDid: 'did:plc:owner', siteRkey: 'site', method: 'HEAD' },
		{ name: 'a lower-case get request', enabled: true, ownerDid: 'did:plc:owner', siteRkey: 'site', method: 'get' },
		{ name: 'a missing owner', enabled: true, ownerDid: '', siteRkey: 'site', method: 'GET' },
		{ name: 'a missing site key', enabled: true, ownerDid: 'did:plc:owner', siteRkey: '', method: 'GET' },
	]) {
		test(`does not allocate or collect for ${scenario.name}`, async () => {
			let clockReads = 0
			let commits = 0
			const collector = createSiteAnalyticsCollector({
				enabled: scenario.enabled,
				now: () => {
					clockReads++
					return Date.parse('2026-08-25T13:42:00Z')
				},
				commit: async (batch) => {
					commits++
					return accepted(batch)
				},
			})

			collector.record(scenario.ownerDid, scenario.siteRkey, scenario.method, 200, 'text/html')
			await collector.flush()

			expect(clockReads).toBe(0)
			expect(commits).toBe(0)
			expect(collector.getStats()).toMatchObject({
				collectedRequests: 0,
				droppedRequests: 0,
				pendingBuckets: 0,
			})
		})
	}

	test('classifies every status range and HTML variant without losing unknown statuses', async () => {
		const batches: SiteAnalyticsBatch[] = []
		const collector = createSiteAnalyticsCollector({
			enabled: true,
			now: () => Date.parse('2026-08-25T13:42:00Z'),
			commit: async (batch) => {
				batches.push(batch)
				return accepted(batch)
			},
		})

		for (const [index, branch] of analyticsResponseBranches.entries()) {
			collector.record('did:plc:owner', `site-${index}`, 'GET', branch.status, branch.contentType)
		}
		await collector.flush()

		expectResponseBranches(batches[0]?.buckets ?? [], analyticsResponseBranches)
		expect(collector.getStats()).toMatchObject({
			collectedRequests: analyticsResponseBranches.length,
			deliveredRequests: analyticsResponseBranches.length,
		})
	})

	test('caps only new hour buckets while retaining existing owner, site, and hour traffic', async () => {
		const batches: SiteAnalyticsBatch[] = []
		let currentTime = Date.parse('2026-08-25T13:42:00Z')
		const collector = createSiteAnalyticsCollector({
			enabled: true,
			maxPendingBuckets: 2,
			now: () => currentTime,
			commit: async (batch) => {
				batches.push(batch)
				return accepted(batch)
			},
		})

		collector.record('did:plc:owner', 'site', 'GET', 200, null)
		currentTime = Date.parse('2026-08-25T14:42:00Z')
		collector.record('did:plc:owner', 'site', 'GET', 201, null)
		currentTime = Date.parse('2026-08-25T13:42:00Z')
		collector.record('did:plc:owner', 'site', 'GET', 202, null)
		currentTime = Date.parse('2026-08-25T15:42:00Z')
		collector.record('did:plc:owner', 'site', 'GET', 203, null)
		currentTime = Date.parse('2026-08-25T13:42:00Z')
		collector.record('did:plc:another-owner', 'site', 'GET', 204, null)
		await collector.flush()

		expect(batches[0]?.buckets).toEqual([
			expect.objectContaining({ bucketStart: Date.parse('2026-08-25T13:00:00Z'), requests: 2, status2xx: 2 }),
			expect.objectContaining({ bucketStart: Date.parse('2026-08-25T14:00:00Z'), requests: 1, status2xx: 1 }),
		])
		expect(collector.getStats()).toMatchObject({ collectedRequests: 3, droppedRequests: 2, deliveredRequests: 3 })
	})

	test('shares an in-flight flush and drains traffic recorded during that flush on stop', async () => {
		const batches: SiteAnalyticsBatch[] = []
		let commitCount = 0
		let releaseFirstCommit: (() => void) | undefined
		const firstCommit = new Promise<void>((resolve) => {
			releaseFirstCommit = resolve
		})
		const collector = createSiteAnalyticsCollector({
			enabled: true,
			now: () => Date.parse('2026-08-25T13:42:00Z'),
			commit: async (batch) => {
				batches.push(batch)
				commitCount++
				if (commitCount === 1) await firstCommit
				return accepted(batch)
			},
		})

		collector.record('did:plc:owner', 'first-site', 'GET', 200, null)
		const firstFlush = collector.flush()
		const joinedFlush = collector.flush()
		expect(joinedFlush).toBe(firstFlush)
		collector.record('did:plc:owner', 'queued-site', 'GET', 201, null)
		releaseFirstCommit?.()
		await Promise.all([firstFlush, joinedFlush])
		await collector.stop()

		expect(batches.map((batch) => batch.buckets.map((bucket) => bucket.siteRkey))).toEqual([
			['first-site'],
			['queued-site'],
		])
		expect(collector.getStats()).toMatchObject({ pendingBuckets: 0, collectedRequests: 2, deliveredRequests: 2 })
	})

	test('retries a failed batch before stop flushes traffic queued after that failure', async () => {
		const batches: SiteAnalyticsBatch[] = []
		let attempts = 0
		let nextBatch = 0
		const collector = createSiteAnalyticsCollector({
			enabled: true,
			now: () => Date.parse('2026-08-25T13:42:00Z'),
			newBatchId: () => `00000000-0000-4000-8000-${String(++nextBatch).padStart(12, '0')}`,
			commit: async (batch) => {
				batches.push(batch)
				attempts++
				if (attempts === 1) throw new Error('commit lost')
				return accepted(batch)
			},
		})

		collector.record('did:plc:owner', 'retry-site', 'GET', 200, null)
		await expect(collector.flush()).rejects.toThrow('commit lost')
		collector.record('did:plc:owner', 'queued-site', 'GET', 201, null)
		await collector.stop()

		expect(batches).toHaveLength(3)
		expect(batches[0]?.batchId).toBe(batches[1]?.batchId)
		expect(batches[0]?.buckets.map((bucket) => bucket.siteRkey)).toEqual(['retry-site'])
		expect(batches[2]?.buckets.map((bucket) => bucket.siteRkey)).toEqual(['queued-site'])
		expect(collector.getStats()).toMatchObject({
			retryPending: false,
			pendingBuckets: 0,
			flushFailures: 1,
			deliveredRequests: 2,
		})
	})
})
