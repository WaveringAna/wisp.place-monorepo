import { afterAll, describe, expect, test } from 'bun:test'
import { metricsExporter } from './exporters'

type OtlpMetric = {
	name: string
	gauge?: { dataPoints: { attributes: { key: string; value: { stringValue: string } }[] }[] }
}
type OtlpRequest = {
	resourceMetrics: {
		resource: { attributes: { key: string; value: { stringValue: string } }[] }
		scopeMetrics: { metrics: OtlpMetric[] }[]
	}[]
}

const bodies: OtlpRequest[] = []
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const body =
			request.headers.get('content-encoding') === 'gzip'
				? new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await request.arrayBuffer())))
				: await request.text()
		bodies.push(JSON.parse(body))
		return Response.json({})
	},
})

afterAll(async () => {
	await metricsExporter.shutdown()
	metricsExporter.initialize({ enabled: false })
	server.stop(true)
})

describe('metrics exporter memory gauges', () => {
	test('exports process and uptime gauges over OTLP with only the kind label', async () => {
		metricsExporter.initialize({
			enabled: true,
			prometheusUrl: `http://localhost:${server.port}`,
			prometheusEncoding: 'json',
			serviceName: 'memory-export-test',
			flushIntervalMs: 60_000,
		})
		// Shutdown runs the final collection and export.
		await metricsExporter.shutdown()

		const [resourceMetrics] = bodies.flatMap((body) => body.resourceMetrics)
		const resource = Object.fromEntries(
			(resourceMetrics?.resource.attributes ?? []).map(({ key, value }) => [key, value.stringValue]),
		)
		expect(resource['service.name']).toBe('memory-export-test')
		expect(resource.instance).toStartWith('memory-export-test-')

		const exported = Object.fromEntries(
			(resourceMetrics?.scopeMetrics ?? []).flatMap((scope) => scope.metrics).map((metric) => [metric.name, metric]),
		)
		const kinds = exported.process_memory_bytes?.gauge?.dataPoints.map((point) =>
			point.attributes.map(({ key, value }) => `${key}=${value.stringValue}`).join(','),
		)
		expect(kinds?.sort()).toEqual([
			'kind=array_buffers',
			'kind=external',
			'kind=heap_total',
			'kind=heap_used',
			'kind=rss',
		])
		expect(exported.process_uptime_seconds?.gauge?.dataPoints).toHaveLength(1)
	})
})
