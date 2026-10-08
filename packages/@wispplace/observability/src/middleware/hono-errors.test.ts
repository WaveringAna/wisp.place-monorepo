import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { errorTracker, logCollector, metricsCollector } from '../core'
import { observabilityErrorHandler, observabilityMiddleware } from './hono'

/** A body the handler drains, erroring the way hosting's file streams do once the request signal aborts. */
function slowBody(signal: AbortSignal): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(16))
			signal.addEventListener('abort', () => controller.error(new DOMException('Request aborted', 'AbortError')), {
				once: true,
			})
		},
	})
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('condition not met')
		await Bun.sleep(5)
	}
}

describe('observabilityErrorHandler', () => {
	let server: ReturnType<typeof Bun.serve> | null = null

	afterEach(() => {
		server?.stop(true)
		server = null
	})

	async function abortMidRequest(service: string, handler: (signal: AbortSignal) => Promise<Response>) {
		let handlerFailed = false
		const app = new Hono()
		app.use('*', observabilityMiddleware(service))
		app.onError((error, c) => {
			handlerFailed = true
			return observabilityErrorHandler(service)(error, c)
		})
		app.get('/posts/rss.xml', (c) => handler(c.req.raw.signal))
		server = Bun.serve({ port: 0, fetch: app.fetch })

		const client = new AbortController()
		const request = fetch(`http://127.0.0.1:${server.port}/posts/rss.xml`, { signal: client.signal }).catch(() => null)
		await Bun.sleep(50)
		client.abort()
		await request
		await waitFor(() => handlerFailed && metricsCollector.getMetrics({ service }).length > 0)

		const logs = logCollector.getLogs({ service })
		expect(logs.map((log) => [log.level, log.message])).toEqual([
			['info', 'Request aborted by client: GET /posts/rss.xml'],
		])
		expect(errorTracker.getErrors({ service })).toEqual([])
		expect(metricsCollector.getMetrics({ service })[0]?.statusCode).toBe(499)
	}

	test('logs a client that disconnects mid-stream as info, not as an aggregated error', async () => {
		// Drain the body inside the handler, as the rewrite path does, so the abort surfaces here.
		await abortMidRequest('hono-client-abort-stream-test', async (signal) => {
			return new Response(await new Response(slowBody(signal)).arrayBuffer())
		})
	})

	test('treats the abort reason of the request signal as a client disconnect', async () => {
		await abortMidRequest('hono-client-abort-reason-test', async (signal) => {
			await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
			signal.throwIfAborted()
			return new Response('unreachable')
		})
	})

	test('keeps an AbortError from a live request (upstream or S3 timeout) as an error', async () => {
		const service = 'hono-upstream-abort-test'
		const app = new Hono()
		app.use('*', observabilityMiddleware(service))
		app.onError(observabilityErrorHandler(service))
		app.get('/file', () => {
			throw new DOMException('The operation timed out', 'AbortError')
		})

		const response = await app.request('/file')

		expect(response.status).toBe(500)
		expect(logCollector.getLogs({ service, level: 'error' }).map((log) => log.message)).toEqual([
			'Request failed: GET /file',
		])
		expect(errorTracker.getErrors({ service })).toHaveLength(1)
		expect(metricsCollector.getMetrics({ service })[0]?.statusCode).toBe(500)
	})

	test('keeps a non-abort failure after the client left as an error', async () => {
		const service = 'hono-error-after-abort-test'
		const client = new AbortController()
		client.abort()
		const app = new Hono()
		app.onError(observabilityErrorHandler(service))
		app.get('/file', () => {
			throw new Error('S3 GetObject failed')
		})

		const response = await app.request(new Request('http://localhost/file', { signal: client.signal }))

		expect(response.status).toBe(500)
		expect(errorTracker.getErrors({ service })).toHaveLength(1)
	})
})
