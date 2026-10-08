import { describe, expect, test } from 'bun:test'
import { REDIS_KEEPALIVE_INTERVAL_MS, type RedisKeepaliveScheduler, startRedisKeepalive } from './redis-keepalive'

function manualScheduler() {
	const state = { tick: () => {}, intervalMs: 0, cancelled: false }
	const schedule: RedisKeepaliveScheduler = (callback, intervalMs) => {
		state.tick = callback
		state.intervalMs = intervalMs
		return () => {
			state.cancelled = true
		}
	}
	return { state, schedule }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('startRedisKeepalive', () => {
	test('pings at an interval well under the 180 s haproxy idle timeout', () => {
		const { state, schedule } = manualScheduler()
		let pings = 0
		startRedisKeepalive(
			() => {
				pings++
				return Promise.resolve('PONG')
			},
			{ schedule },
		)

		expect(state.intervalMs).toBe(REDIS_KEEPALIVE_INTERVAL_MS)
		expect(REDIS_KEEPALIVE_INTERVAL_MS * 2).toBeLessThan(180_000)
		state.tick()
		expect(pings).toBe(1)
	})

	test('does not stack pings behind one that is still outstanding', async () => {
		const { state, schedule } = manualScheduler()
		let pings = 0
		let resolvePing = () => {}
		startRedisKeepalive(
			() => {
				pings++
				return new Promise<void>((resolve) => {
					resolvePing = resolve
				})
			},
			{ schedule },
		)

		state.tick()
		state.tick()
		expect(pings).toBe(1)
		resolvePing()
		await settle()
		state.tick()
		expect(pings).toBe(2)
	})

	test('skips a tick when ping returns undefined', () => {
		const { state, schedule } = manualScheduler()
		const errors: unknown[] = []
		startRedisKeepalive(() => undefined, { schedule, onError: (error) => errors.push(error) })
		state.tick()
		expect(errors).toEqual([])
	})

	test('reports rejected and thrown pings without an unhandled rejection', async () => {
		const { state, schedule } = manualScheduler()
		const errors: unknown[] = []
		let calls = 0
		startRedisKeepalive(
			() => {
				calls++
				if (calls === 1) return Promise.reject(new Error('Connection closed'))
				throw new Error('Stream not writeable')
			},
			{ schedule, onError: (error) => errors.push(error) },
		)

		state.tick()
		await settle()
		state.tick()
		expect(errors.map((error) => (error as Error).message)).toEqual(['Connection closed', 'Stream not writeable'])
	})

	test('returns the scheduler cancel function', () => {
		const { state, schedule } = manualScheduler()
		const stop = startRedisKeepalive(() => undefined, { schedule })
		stop()
		expect(state.cancelled).toBe(true)
	})
})
