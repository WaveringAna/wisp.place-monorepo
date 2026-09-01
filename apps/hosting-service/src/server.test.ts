import { describe, expect, test } from 'bun:test'

const { default: app, getCacheInvalidationHealthResponse, normalizeConfiguredHostname } = await import('./server')

describe('hosting server', () => {
	test('serves a compact cache invalidation health payload', async () => {
		const response = await app.request('https://wisp.place/health')
		const body = (await response.json()) as {
			status: string
			cacheInvalidation: Record<string, unknown>
		}

		expect(response.status).toBe(200)
		expect(['ok', 'degraded']).toContain(body.status)
		expect(Object.keys(body.cacheInvalidation).sort()).toEqual([
			'configured',
			'gapCount',
			'lastGapAt',
			'lastGapRecoveryAt',
			'replayConnected',
			'replayState',
			'retrying',
			'subscriberConnected',
			'subscriberRecreations',
		])
		expect(typeof body.cacheInvalidation.configured).toBe('boolean')
		expect(typeof body.cacheInvalidation.replayConnected).toBe('boolean')
		expect(typeof body.cacheInvalidation.subscriberConnected).toBe('boolean')
		expect(typeof body.cacheInvalidation.gapCount).toBe('number')
	})

	test('normalizes configured hosts without accepting URL credentials', () => {
		expect(normalizeConfiguredHostname('WISP.PLACE:443', 'fallback.example')).toBe('wisp.place')
		expect(normalizeConfiguredHostname('user:secret@wisp.place', 'fallback.example')).toBe('fallback.example')
	})

	test('uses the normalized URL hostname for DNS-hash routing', async () => {
		const response = await app.request(
			new Request('https://0123456789ABCDEF.dns.NOT..VALID:8443/assets/app.js', {
				headers: { host: 'sites.wisp.place' },
			}),
		)

		expect(response.status).toBe(400)
		expect(await response.text()).toBe('Invalid base domain')
	})

	test('reports an unhealthy configured replay without exposing its cursor', () => {
		const response = getCacheInvalidationHealthResponse(
			{
				subscriberConnected: true,
				replayConnected: false,
				replayState: 'gap',
				cursor: 'internal-stream-cursor',
				lastEventAt: null,
				lastErrorAt: null,
				lastGapAt: 123,
				gapCount: 1,
				lastGapRecoveryAt: null,
				retrying: true,
				subscriberRecreations: 0,
			},
			true,
			{
				configured: true,
				status: 'healthy',
				breaker: 'closed',
				consecutiveFailures: 0,
				totalFailures: 0,
				totalSuccesses: 1,
				circuitRejections: 0,
				lastSuccessAt: 123,
				lastFailureAt: null,
				lastErrorKind: null,
				lastSuccessAgeMs: 0,
			},
		)

		expect(response).toEqual({
			status: 'degraded',
			cacheInvalidation: {
				configured: true,
				subscriberConnected: true,
				replayConnected: false,
				replayState: 'gap',
				retrying: true,
				gapCount: 1,
				lastGapAt: 123,
				lastGapRecoveryAt: null,
				subscriberRecreations: 0,
			},
			storage: {
				configured: true,
				status: 'healthy',
				breaker: 'closed',
				consecutiveFailures: 0,
				circuitRejections: 0,
				lastSuccessAgeMs: 0,
				lastErrorKind: null,
			},
		})
		expect(JSON.stringify(response)).not.toContain('internal-stream-cursor')
	})

	test('fails closed when the pub/sub subscriber is down even if replay is healthy', () => {
		const response = getCacheInvalidationHealthResponse(
			{
				subscriberConnected: false,
				replayConnected: true,
				replayState: 'healthy',
				cursor: 'internal-stream-cursor',
				lastEventAt: 1,
				lastErrorAt: null,
				lastGapAt: null,
				gapCount: 0,
				lastGapRecoveryAt: null,
				retrying: false,
				subscriberRecreations: 2,
			},
			true,
			{
				configured: true,
				status: 'healthy',
				breaker: 'closed',
				consecutiveFailures: 0,
				totalFailures: 0,
				totalSuccesses: 1,
				circuitRejections: 0,
				lastSuccessAt: 1,
				lastFailureAt: null,
				lastErrorKind: null,
				lastSuccessAgeMs: 0,
			},
		)

		expect(response.status).toBe('degraded')
		expect(response.cacheInvalidation.subscriberConnected).toBe(false)
		expect(response.cacheInvalidation.subscriberRecreations).toBe(2)
	})

	test('serves a liveness-only /live endpoint', async () => {
		const response = await app.request('https://wisp.place/live')
		expect(response.status).toBe(200)
		expect((await response.json()) as { status: string }).toEqual({ status: 'ok' })
	})
})

test('rejects unsafe decoded paths before routing', async () => {
	const unsafePaths = [
		'/assets%2f..%2fsecret.txt',
		'/%2e%2e%2fsecret.txt',
		'/..%5csecret.txt',
		'/safe%00name.txt',
		'/C:%2fWindows%2fsystem.ini',
		'/nested//file.txt',
		`/${'a'.repeat(4097)}`,
	]

	for (const path of unsafePaths) {
		const response = await app.request(`https://wisp.place${path}`)
		expect(response.status).toBe(400)
		expect(['Invalid path', 'Invalid URL encoding']).toContain(await response.text())
	}
})
