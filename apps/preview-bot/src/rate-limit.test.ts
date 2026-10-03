import { describe, expect, test } from 'bun:test'
import { createRateLimiter } from './rate-limit'

describe('createRateLimiter', () => {
	test('allows a burst and then refuses until tokens refill', () => {
		let now = 0
		const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1, now: () => now })

		expect([limiter.take('k'), limiter.take('k'), limiter.take('k'), limiter.take('k')]).toEqual([
			true,
			true,
			true,
			false,
		])
		now = 1000
		expect(limiter.take('k')).toBe(true)
		expect(limiter.take('k')).toBe(false)
	})

	test('never refills past capacity', () => {
		let now = 0
		const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 10, now: () => now })
		limiter.take('k')
		now = 60_000

		expect([limiter.take('k'), limiter.take('k'), limiter.take('k')]).toEqual([true, true, false])
	})

	test('keeps keys independent', () => {
		const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, now: () => 0 })

		expect([limiter.take('a'), limiter.take('b'), limiter.take('a')]).toEqual([true, true, false])
	})

	test('forgets idle keys so memory stays bounded', () => {
		let now = 0
		const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 3, now: () => now })
		for (const key of ['a', 'b', 'c']) limiter.take(key)
		now = 10_000
		limiter.take('d')

		expect(limiter.size()).toBeLessThanOrEqual(3)
	})

	test('refuses new keys instead of growing past maxKeys when none are idle', () => {
		const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, maxKeys: 2, now: () => 0 })
		limiter.take('a')
		limiter.take('b')

		expect(limiter.take('c')).toBe(false)
		expect(limiter.size()).toBe(2)
	})
})
