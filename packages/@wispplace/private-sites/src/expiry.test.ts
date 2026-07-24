import { describe, expect, it } from 'bun:test'
import { DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES, MAX_PRIVATE_SITE_EXPIRY_MINUTES } from '@wispplace/constants'
import { InvalidExpiryError, resolveExpiry } from './expiry'

const NOW = new Date('2026-07-24T12:00:00.000Z')

describe('resolveExpiry', () => {
	it('applies the configured default when omitted', () => {
		const r = resolveExpiry({ now: NOW })
		expect(r.usedDefault).toBe(true)
		expect(r.neverExpires).toBe(false)
		expect(r.expiresAt?.getTime()).toBe(NOW.getTime() + DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES * 60_000)
	})

	it('applies the default when explicitly null', () => {
		const r = resolveExpiry({ expiryMinutes: null, now: NOW })
		expect(r.usedDefault).toBe(true)
		expect(r.expiresAt).not.toBeNull()
	})

	it('treats 0 as never expires', () => {
		const r = resolveExpiry({ expiryMinutes: 0, now: NOW })
		expect(r.neverExpires).toBe(true)
		expect(r.expiresAt).toBeNull()
		expect(r.usedDefault).toBe(false)
	})

	it('computes now + n minutes', () => {
		const r = resolveExpiry({ expiryMinutes: 90, now: NOW })
		expect(r.expiresAt?.getTime()).toBe(NOW.getTime() + 90 * 60_000)
		expect(r.neverExpires).toBe(false)
	})

	it('rejects negative values', () => {
		expect(() => resolveExpiry({ expiryMinutes: -1, now: NOW })).toThrow(InvalidExpiryError)
	})

	it('rejects non-integers', () => {
		expect(() => resolveExpiry({ expiryMinutes: 1.5, now: NOW })).toThrow(InvalidExpiryError)
	})

	it('rejects values above the maximum', () => {
		expect(() => resolveExpiry({ expiryMinutes: MAX_PRIVATE_SITE_EXPIRY_MINUTES + 1, now: NOW })).toThrow(
			InvalidExpiryError,
		)
	})

	it('clamps a share expiry to the site expiry', () => {
		const siteExpiry = new Date(NOW.getTime() + 60 * 60_000)
		const r = resolveExpiry({ expiryMinutes: 600, now: NOW, clampTo: siteExpiry })
		expect(r.expiresAt?.getTime()).toBe(siteExpiry.getTime())
	})

	it('clamps a never-expiring share to the site expiry', () => {
		const siteExpiry = new Date(NOW.getTime() + 60 * 60_000)
		const r = resolveExpiry({ expiryMinutes: 0, now: NOW, clampTo: siteExpiry })
		expect(r.expiresAt?.getTime()).toBe(siteExpiry.getTime())
		expect(r.neverExpires).toBe(false)
	})

	it('leaves a share expiry below the site expiry untouched', () => {
		const siteExpiry = new Date(NOW.getTime() + 600 * 60_000)
		const r = resolveExpiry({ expiryMinutes: 60, now: NOW, clampTo: siteExpiry })
		expect(r.expiresAt?.getTime()).toBe(NOW.getTime() + 60 * 60_000)
	})
})
