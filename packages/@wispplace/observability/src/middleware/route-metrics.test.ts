import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { Hono } from 'hono'
import { metricsCollector } from '../core'
import { observabilityMiddleware as elysiaObservabilityMiddleware } from './elysia'
import { observabilityMiddleware as honoObservabilityMiddleware } from './hono'

describe('observability route labels', () => {
	test('uses the matched Hono route instead of the literal request path', async () => {
		const service = 'hono-route-label-test'
		const app = new Hono()
		app.use('*', honoObservabilityMiddleware(service))
		app.get('/sites/:did/*', (c) => c.text('ok'))

		await app.request('/sites/did:plc:abc/assets/unique-file.html')

		const [metric] = metricsCollector.getMetrics({ service })
		expect(metric?.path).toBe('/sites/:did/*')
	})

	test('uses the matched Elysia route instead of the literal request path', async () => {
		const service = 'elysia-route-label-test'
		const middleware = elysiaObservabilityMiddleware(service)
		const app = new Elysia()
			.onBeforeHandle(middleware.beforeHandle)
			.onAfterHandle(middleware.afterHandle)
			.onError(middleware.onError)
			.get('/sites/:did/*', () => 'ok')

		await app.handle(new Request('http://localhost/sites/did:plc:abc/assets/unique-file.html'))

		const [metric] = metricsCollector.getMetrics({ service })
		expect(metric?.path).toBe('/sites/:did/*')
	})
})
