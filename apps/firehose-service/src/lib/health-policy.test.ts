import { describe, expect, test } from 'bun:test'
import { resolveRevalidationHealth } from './health-policy'

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
