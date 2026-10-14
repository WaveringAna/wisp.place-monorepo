import { describe, expect, test } from 'bun:test'
import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import { createS3Instruments } from './exporters'

class CollectingReader extends MetricReader {
	constructor() {
		super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE })
	}
	protected async onShutdown(): Promise<void> {}
	protected async onForceFlush(): Promise<void> {}
}

describe('s3 instruments', () => {
	test('records one series per operation and outcome, labelled only by them', async () => {
		const reader = new CollectingReader()
		const provider = new MeterProvider({ readers: [reader] })
		const record = createS3Instruments(provider.getMeter('s3-metrics-test'))
		record({ operation: 'GetObject', outcome: 'ok', durationMs: 120 })
		record({ operation: 'GetObject', outcome: 'ok', durationMs: 40 })
		record({ operation: 'HeadObject', outcome: 'not-found', durationMs: 8 })
		const { resourceMetrics } = await reader.collect()
		await provider.shutdown()

		const [metric] = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics)
		expect(metric?.descriptor.name).toBe('s3_request_duration_ms')
		expect(metric?.descriptor.unit).toBe('ms')
		const points = Object.fromEntries(
			(metric?.dataPoints ?? []).map((point) => [`${point.attributes.operation}/${point.attributes.outcome}`, point]),
		)
		expect(Object.keys(points).sort()).toEqual(['GetObject/ok', 'HeadObject/not-found'])
		expect(points['GetObject/ok']?.value).toMatchObject({ count: 2 })
	})
})
