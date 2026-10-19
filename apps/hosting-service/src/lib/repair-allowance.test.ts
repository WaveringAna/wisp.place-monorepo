import { describe, expect, test } from 'bun:test'
import { createRepairAllowance, requestClient } from './repair-allowance'

describe('unknown-site repair allowance', () => {
	test('allows a burst per client, then refills over time', () => {
		let time = 0
		const allowance = createRepairAllowance({ burst: 3, refillPerMinute: 3, maxClients: 10, now: () => time })
		expect([1, 2, 3, 4].map(() => allowance.allow('a'))).toEqual([true, true, true, false])
		expect(allowance.allow('b')).toBe(true)
		time += 20_000
		expect([allowance.allow('a'), allowance.allow('a')]).toEqual([true, false])
	})

	test('forgets the least recently seen client past its capacity', () => {
		const allowance = createRepairAllowance({ burst: 1, refillPerMinute: 0, maxClients: 2, now: () => 0 })
		expect([allowance.allow('a'), allowance.allow('b'), allowance.allow('c')]).toEqual([true, true, true])
		expect(allowance.allow('a')).toBe(true)
		expect(allowance.allow('c')).toBe(false)
	})

	test('takes the client from the last X-Forwarded-For entry', () => {
		expect(requestClient({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })).toBe('203.0.113.9')
		expect(requestClient({})).toBe('unknown')
		expect(requestClient({ 'x-forwarded-for': '2001:db8:1:2:a:b:c:d' })).toBe('2001:db8:1:2::/64')
		expect(requestClient({ 'x-forwarded-for': '2001:db8::1' })).toBe('2001:db8:0:0::/64')
	})
})
