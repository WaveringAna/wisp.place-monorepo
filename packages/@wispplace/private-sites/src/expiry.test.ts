import { describe, expect, it } from 'bun:test'
import { DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES, MAX_PRIVATE_SITE_EXPIRY_MINUTES } from '@wispplace/constants'
import { InvalidExpiryError, resolveExpiry } from './expiry'

const NOW = new Date('2026-07-24T12:00:00Z')
const minutes = (value: number) => NOW.getTime() + value * 60_000

describe('resolveExpiry', () => {
	it('uses the default when omitted or null', () => {
		for (const expiryMinutes of [undefined, null]) {
			const result = resolveExpiry({ expiryMinutes, now: NOW })
			expect(result.usedDefault).toBe(true)
			expect(result.expiresAt?.getTime()).toBe(minutes(DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES))
		}
	})

	it('supports never and relative expiry', () => {
		expect(resolveExpiry({ expiryMinutes: 0, now: NOW })).toEqual({
			expiresAt: null,
			neverExpires: true,
			usedDefault: false,
		})
		expect(resolveExpiry({ expiryMinutes: 90, now: NOW }).expiresAt?.getTime()).toBe(minutes(90))
	})

	it.each([-1, 1.5, Number.NaN, MAX_PRIVATE_SITE_EXPIRY_MINUTES + 1])('rejects %s', (expiryMinutes) => {
		expect(() => resolveExpiry({ expiryMinutes, now: NOW })).toThrow(InvalidExpiryError)
	})

	it('clamps shares to the site expiry', () => {
		const clampTo = new Date(minutes(60))
		expect(resolveExpiry({ expiryMinutes: 600, now: NOW, clampTo }).expiresAt).toEqual(clampTo)
		expect(resolveExpiry({ expiryMinutes: 0, now: NOW, clampTo })).toEqual({
			expiresAt: clampTo,
			neverExpires: false,
			usedDefault: false,
		})
	})
})
