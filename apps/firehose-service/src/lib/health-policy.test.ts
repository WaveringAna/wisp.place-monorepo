import { describe, expect, test } from 'bun:test'
import { resolveIngestHealth, resolveRevalidationHealth } from './health-policy'

describe('revalidation health policy', () => {
	test('keeps a supervised reconnect live but not ready', () => {
		expect(resolveRevalidationHealth(true, true, { running: true, hasLoop: true, hasRedisClient: false })).toEqual({
			live: true,
			ready: false,
			reconnecting: true,
		})
	})

	test('marks a stopped loop unhealthy and a connected loop ready', () => {
		expect(resolveRevalidationHealth(true, true, { running: false, hasLoop: false, hasRedisClient: false })).toEqual({
			live: false,
			ready: false,
			reconnecting: false,
		})
		expect(resolveRevalidationHealth(true, true, { running: true, hasLoop: true, hasRedisClient: true })).toEqual({
			live: true,
			ready: true,
			reconnecting: false,
		})
	})

	test('does not require a worker while standby or unconfigured', () => {
		const stopped = { running: false, hasLoop: false, hasRedisClient: false }
		expect(resolveRevalidationHealth(false, true, stopped).ready).toBe(true)
		expect(resolveRevalidationHealth(true, false, stopped).ready).toBe(true)
	})
})

describe('ingest health policy', () => {
	const base = {
		draining: false,
		standbyHealthy: false,
		workerExpected: true,
		firehose: { healthy: true, ready: true },
		revalidation: { live: true, ready: true },
	}

	test('caught-up worker is live and ready', () => {
		expect(resolveIngestHealth(base)).toEqual({ healthy: true, ready: true })
	})

	test('replay lag or unknown source age stays live (200) but not ready', () => {
		expect(resolveIngestHealth({ ...base, firehose: { healthy: true, ready: false } })).toEqual({
			healthy: true,
			ready: false,
		})
	})

	test('draining, disconnected, and standby behave as before', () => {
		expect(resolveIngestHealth({ ...base, draining: true })).toEqual({ healthy: false, ready: false })
		expect(resolveIngestHealth({ ...base, firehose: { healthy: false, ready: false } }).healthy).toBe(false)
		expect(
			resolveIngestHealth({
				...base,
				workerExpected: false,
				standbyHealthy: true,
				firehose: { healthy: false, ready: false },
			}),
		).toEqual({ healthy: true, ready: false })
	})
})
