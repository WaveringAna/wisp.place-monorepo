import { describe, expect, test } from 'bun:test'
import type { SiteAnalyticsBatch, SiteAnalyticsCommitResult } from './db'
import { createSiteAnalyticsCollector } from './site-analytics'

const accepted = (batch: SiteAnalyticsBatch): SiteAnalyticsCommitResult => ({
	duplicate: false,
	acceptedBuckets: batch.buckets.length,
	acceptedRequests: batch.buckets.reduce((total, bucket) => total + bucket.requests, 0),
	skippedBuckets: 0,
	skippedRequests: 0,
})

describe('site analytics collector', () => {
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
		expect(batchIds).toEqual([
			'00000000-0000-4000-8000-000000000002',
			'00000000-0000-4000-8000-000000000002',
		])
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
})
