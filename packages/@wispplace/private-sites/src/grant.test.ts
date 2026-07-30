import { describe, expect, it } from 'bun:test'
import {
	buildSessionCookie,
	generateHandoffSecret,
	generateSessionSecret,
	hashSecret,
	PRIVATE_SESSION_COOKIE,
	PRIVATE_SESSION_COOKIE_SECURE,
	privateSiteHostname,
	secretsMatch,
	sessionCookieName,
	siteIdFromHostname,
} from './grant'

describe('per-site origins', () => {
	it('round-trips one hostname label', () => {
		const host = privateSiteHostname('bright-brook-fox-1234', 'priv.wisp.place')
		expect(host).toBe('bright-brook-fox-1234.priv.wisp.place')
		expect(siteIdFromHostname(host, 'priv.wisp.place')).toBe('bright-brook-fox-1234')
	})

	it.each(['priv.wisp.place', 'a.b.priv.wisp.place', 'sites.wisp.place', 'evil.com'])('rejects %s', (host) => {
		expect(siteIdFromHostname(host, 'priv.wisp.place')).toBeNull()
	})
})

describe('session cookies', () => {
	it('keeps the secure cookie host-only', () => {
		const cookie = buildSessionCookie('wsx_abc', true, 3600)
		expect(cookie).toContain(`${PRIVATE_SESSION_COOKIE_SECURE}=wsx_abc`)
		expect(cookie).toContain('Secure')
		expect(cookie).toContain('HttpOnly')
		expect(cookie).not.toContain('Domain')
	})

	it('uses a plain cookie for local http', () => {
		expect(buildSessionCookie('wsx_abc', false, 60)).toContain(`${PRIVATE_SESSION_COOKIE}=wsx_abc`)
		expect(buildSessionCookie('wsx_abc', false, 60)).not.toContain('Secure')
		expect(sessionCookieName(true)).toBe(PRIVATE_SESSION_COOKIE_SECURE)
		expect(sessionCookieName(false)).toBe(PRIVATE_SESSION_COOKIE)
	})
})

describe('session secrets', () => {
	it('stores hashes and compares them safely', () => {
		const secret = generateSessionSecret()
		expect(secret.value.startsWith('wsx_')).toBe(true)
		expect(secret.hash).toMatch(/^[0-9a-f]{64}$/)
		expect(secretsMatch(secret.hash, hashSecret(secret.value))).toBe(true)
		expect(secretsMatch(secret.hash, hashSecret('other'))).toBe(false)
	})

	it('mints distinct handoffs', () => {
		expect(new Set(Array.from({ length: 200 }, () => generateHandoffSecret().value)).size).toBe(200)
	})
})
