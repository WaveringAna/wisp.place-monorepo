import { describe, expect, test } from 'bun:test'
import { lokiExporter, shutdownGrafanaExporters } from './exporters'

describe('Loki exporter shutdown', () => {
	test('awaits a delayed final flush and is safe to repeat', async () => {
		const originalFetch = globalThis.fetch
		let releaseFetch = () => {}
		let markFetchStarted = () => {}
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve
		})
		const fetchStarted = new Promise<void>((resolve) => {
			markFetchStarted = resolve
		})
		let fetchCalls = 0
		let shutdownPromise: Promise<void> | undefined

		globalThis.fetch = (async () => {
			fetchCalls++
			markFetchStarted()
			await fetchGate
			return new Response(null, { status: 204 })
		}) as unknown as typeof fetch

		try {
			lokiExporter.initialize({
				enabled: true,
				lokiUrl: 'https://loki.example.test',
				serviceName: 'delayed-shutdown-test',
				flushIntervalMs: 60_000,
			})
			lokiExporter.pushLog({
				id: 'delayed-shutdown-log',
				timestamp: new Date(),
				level: 'info',
				message: 'wait for the final Loki flush',
				service: 'delayed-shutdown-test',
			})

			shutdownPromise = shutdownGrafanaExporters()
			let shutdownFinished = false
			void shutdownPromise.then(() => {
				shutdownFinished = true
			})

			await fetchStarted
			expect(shutdownFinished).toBe(false)
			expect(fetchCalls).toBe(1)

			releaseFetch()
			await shutdownPromise
			expect(shutdownFinished).toBe(true)

			await Promise.all([shutdownGrafanaExporters(), shutdownGrafanaExporters()])
			expect(fetchCalls).toBe(1)
		} finally {
			releaseFetch()
			if (shutdownPromise) await shutdownPromise
			globalThis.fetch = originalFetch
			await lokiExporter.stop()
			lokiExporter.initialize({ enabled: false })
		}
	})
})
