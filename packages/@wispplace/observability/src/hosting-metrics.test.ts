import { describe, expect, test } from 'bun:test'
import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import type { HostingNotFoundReason, HostingResponseEntry } from './core'
import { createHostingInstruments, HOSTING_RESPONSE_BUCKETS_MS } from './exporters'

class CollectingReader extends MetricReader {
	constructor() {
		super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE })
	}
	protected async onShutdown(): Promise<void> {}
	protected async onForceFlush(): Promise<void> {}
}

const TIERS = ['hot', 'warm', 'cold', 'none'] as const
const STATUS_CLASSES = ['2xx', '3xx', '404', '4xx', '5xx'] as const
const KINDS = ['html', 'asset', 'other'] as const
const REASONS: HostingNotFoundReason[] = [
	'unknown-custom-domain',
	'unregistered-subdomain',
	'unmapped-domain',
	'preview-not-found',
	'private-not-found',
	'file-not-found',
	'redirect-404',
	'other',
]

async function collect(record: (instruments: ReturnType<typeof createHostingInstruments>) => void) {
	const reader = new CollectingReader()
	const provider = new MeterProvider({ readers: [reader] })
	record(createHostingInstruments(provider.getMeter('hosting-metrics-test')))
	const { resourceMetrics } = await reader.collect()
	await provider.shutdown()
	return Object.fromEntries(
		resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).map((metric) => [metric.descriptor.name, metric]),
	)
}

describe('hosting instruments', () => {
	test('every label combination stays within 60 response series and 8 reason series', async () => {
		const metrics = await collect(({ recordResponse, recordNotFound }) => {
			for (let i = 0; i < 10_000; i++) {
				const entry: HostingResponseEntry = {
					tier: TIERS[i % TIERS.length] ?? 'none',
					statusClass: STATUS_CLASSES[i % STATUS_CLASSES.length] ?? '2xx',
					kind: KINDS[i % KINDS.length] ?? 'other',
					durationMs: i % 3000,
				}
				recordResponse(entry)
				recordNotFound(REASONS[i % REASONS.length] ?? 'other')
			}
		})

		const responseTime = metrics.hosting_response_time_ms
		const notFound = metrics.hosting_not_found_total
		expect(responseTime?.dataPoints).toHaveLength(TIERS.length * STATUS_CLASSES.length * KINDS.length)
		expect(notFound?.dataPoints).toHaveLength(REASONS.length)
		for (const point of responseTime?.dataPoints ?? []) {
			expect(Object.keys(point.attributes).sort()).toEqual(['kind', 'status_class', 'tier'])
		}
		for (const point of notFound?.dataPoints ?? []) expect(Object.keys(point.attributes)).toEqual(['reason'])
	})

	test('replica read retries are labelled by outcome only', async () => {
		const metrics = await collect(({ recordDbReadRetry }) => {
			for (let i = 0; i < 100; i++) recordDbReadRetry(i % 2 ? 'recovered' : 'exhausted')
		})

		const points = metrics.hosting_db_read_retries_total?.dataPoints ?? []
		expect(points).toHaveLength(2)
		for (const point of points) expect(Object.keys(point.attributes)).toEqual(['outcome'])
	})

	test('records time to headers in millisecond buckets fine enough for hot reads', async () => {
		const metrics = await collect(({ recordResponse }) => {
			for (const durationMs of [0.4, 0.9, 3, 180, 240]) {
				recordResponse({ tier: 'cold', statusClass: '2xx', kind: 'asset', durationMs })
			}
		})

		const [point] = metrics.hosting_response_time_ms?.dataPoints ?? []
		const value = point?.value as { buckets: { boundaries: number[]; counts: number[] }; count: number }
		expect(metrics.hosting_response_time_ms?.descriptor.unit).toBe('ms')
		expect(value.buckets.boundaries).toEqual(HOSTING_RESPONSE_BUCKETS_MS)
		expect(value.count).toBe(5)
		// <=1 ms, <=5 ms and <=250 ms.
		expect(value.buckets.counts.slice(0, 8)).toEqual([2, 0, 1, 0, 0, 0, 0, 2])
	})
})
