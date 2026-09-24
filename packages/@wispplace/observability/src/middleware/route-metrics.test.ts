import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { Hono } from 'hono'
import { logCollector, metricsCollector } from '../core'
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

	test('records an unmatched Elysia route as 404 and does not log it', async () => {
		const service = 'elysia-not-found-test'
		const middleware = elysiaObservabilityMiddleware(service)
		const app = new Elysia()
			.onBeforeHandle(middleware.beforeHandle)
			.onAfterHandle(middleware.afterHandle)
			.onError(middleware.onError)
			.get('/', () => 'ok')

		const response = await app.handle(new Request('http://localhost/.env'))

		expect(response.status).toBe(404)
		const [metric] = metricsCollector.getMetrics({ service })
		expect(metric?.statusCode).toBe(404)
		expect(logCollector.getLogs({ service }).some((log) => log.message.includes('Request failed'))).toBe(false)
	})

	test('records a thrown Elysia handler error as 500 and logs it', async () => {
		const service = 'elysia-handler-error-test'
		const middleware = elysiaObservabilityMiddleware(service)
		const app = new Elysia()
			.onBeforeHandle(middleware.beforeHandle)
			.onAfterHandle(middleware.afterHandle)
			.onError(middleware.onError)
			.get('/boom', () => {
				throw new Error('boom')
			})

		await app.handle(new Request('http://localhost/boom'))

		const [metric] = metricsCollector.getMetrics({ service })
		expect(metric?.statusCode).toBe(500)
		expect(logCollector.getLogs({ service }).some((log) => log.message === 'Request failed: GET /boom')).toBe(true)
	})
})
