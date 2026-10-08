import { describe, expect, test } from 'bun:test'
import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import type { RevalidateQuarantineRetryOutcome } from './core'
import { createRevalidateQuarantineInstruments, type RevalidateQuarantineInstruments } from './exporters'

class CollectingReader extends MetricReader {
	constructor() {
		super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE })
	}
	protected async onShutdown(): Promise<void> {}
	protected async onForceFlush(): Promise<void> {}
}

const OUTCOMES: RevalidateQuarantineRetryOutcome[] = [
	'retrying',
	'recovered',
	'failed',
	'gave-up',
	'deferred',
	'skipped',
]

async function collect(record: (instruments: RevalidateQuarantineInstruments) => void) {
	const reader = new CollectingReader()
	const provider = new MeterProvider({ readers: [reader] })
	record(createRevalidateQuarantineInstruments(provider.getMeter('quarantine-metrics-test')))
	const { resourceMetrics } = await reader.collect()
	await provider.shutdown()
	return Object.fromEntries(
		resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).map((metric) => [metric.descriptor.name, metric]),
	)
}

describe('revalidation quarantine instruments', () => {
	test('gauges report the leader snapshot with one series per class', async () => {
		const metrics = await collect(({ setSnapshot }) =>
			setSnapshot({
				fenced: { transient: 20, permanent: 5, unknown: 1 },
				dlqEntries: 581,
				oldestFenceAgeSeconds: 7200,
			}),
		)
		const fenced = Object.fromEntries(
			(metrics.revalidate_quarantined_sites?.dataPoints ?? []).map((point) => [
				point.attributes.classification,
				point.value,
			]),
		)
		expect(fenced).toEqual({ transient: 20, permanent: 5, unknown: 1 })
		expect(metrics.revalidate_dlq_entries?.dataPoints.map((point) => point.value)).toEqual([581])
		expect(metrics.revalidate_quarantine_oldest_age_seconds?.dataPoints.map((point) => point.value)).toEqual([7200])
	})

	test('a follower, or a leader that stepped down, reports no gauges', async () => {
		const metrics = await collect(({ setSnapshot }) => {
			setSnapshot({ fenced: { transient: 1, permanent: 0, unknown: 0 }, dlqEntries: 1, oldestFenceAgeSeconds: 1 })
			setSnapshot(null)
		})
		expect(metrics.revalidate_quarantined_sites?.dataPoints ?? []).toHaveLength(0)
		expect(metrics.revalidate_dlq_entries?.dataPoints ?? []).toHaveLength(0)
	})

	test('retry outcomes stay within six series', async () => {
		const metrics = await collect(({ recordRetry }) => {
			for (let i = 0; i < 1_000; i++) recordRetry(OUTCOMES[i % OUTCOMES.length] ?? 'failed')
		})
		const points = metrics.revalidate_quarantine_retries_total?.dataPoints ?? []
		expect(points).toHaveLength(OUTCOMES.length)
		for (const point of points) expect(Object.keys(point.attributes)).toEqual(['outcome'])
	})
})
