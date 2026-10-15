import { describe, expect, test } from 'bun:test'
import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import { createWebhookIntakeInstruments } from './exporters'

class CollectingReader extends MetricReader {
	constructor() {
		super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE })
	}
	protected async onShutdown(): Promise<void> {}
	protected async onForceFlush(): Promise<void> {}
}

describe('webhook intake instruments', () => {
	test('records batches, events, connects and the cursor age of running streams, labelled by stream', async () => {
		const reader = new CollectingReader()
		const provider = new MeterProvider({ readers: [reader] })
		const intake = createWebhookIntakeInstruments(provider.getMeter('webhook-intake-test'), () => ({
			backlink: 38_271,
			direct: undefined,
		}))
		intake.recordBatch({ stream: 'backlink', events: 4096, durationMs: 410 })
		intake.recordBatch({ stream: 'backlink', events: 4096, durationMs: 390 })
		intake.recordConnect('backlink')
		const { resourceMetrics } = await reader.collect()
		await provider.shutdown()

		const metrics = Object.fromEntries(
			resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).map((metric) => [metric.descriptor.name, metric]),
		)
		const only = (name: string) => {
			const points = metrics[name]?.dataPoints ?? []
			expect(points).toHaveLength(1)
			expect(points[0]?.attributes).toEqual({ stream: 'backlink' })
			return points[0]?.value
		}
		expect(only('webhook_intake_batch_ms')).toMatchObject({ count: 2, sum: 800 })
		expect(only('webhook_intake_events_total')).toBe(8192)
		expect(only('webhook_intake_connects_total')).toBe(1)
		expect(only('webhook_intake_cursor_age_seconds')).toBe(38_271)
	})
})
