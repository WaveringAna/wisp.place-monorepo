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
	it('builds a per-site hostname', () => {
		expect(privateSiteHostname('abcdefghijklm', 'priv.wisp.place')).toBe('abcdefghijklm.priv.wisp.place')
	})

	it('round-trips a site id through the hostname', () => {
		const host = privateSiteHostname('abcdefghijklm', 'priv.wisp.place')
		expect(siteIdFromHostname(host, 'priv.wisp.place')).toBe('abcdefghijklm')
	})

	/** The bare private host must not resolve to a site. */
	it('rejects the bare private host', () => {
		expect(siteIdFromHostname('priv.wisp.place', 'priv.wisp.place')).toBeNull()
	})

	/** A deeper name must not smuggle a different site id through. */
	it('rejects nested labels', () => {
		expect(siteIdFromHostname('a.b.priv.wisp.place', 'priv.wisp.place')).toBeNull()
	})

	it('rejects unrelated hosts', () => {
		expect(siteIdFromHostname('sites.wisp.place', 'priv.wisp.place')).toBeNull()
		expect(siteIdFromHostname('evil.com', 'priv.wisp.place')).toBeNull()
	})

	/** Two sites never share an origin, which is what keeps tenant JS separated. */
	it('gives different sites different origins', () => {
		expect(privateSiteHostname('aaaaaaaaaaaaa', 'priv.wisp.place')).not.toBe(
			privateSiteHostname('bbbbbbbbbbbbb', 'priv.wisp.place'),
		)
	})
})

describe('session cookie', () => {
	/** No Domain attribute: the cookie must stay bound to one site's origin. */
	it('is host-only', () => {
		const cookie = buildSessionCookie('wsx_abc', true, 3600)
		expect(cookie).not.toContain('Domain')
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('Path=/')
		expect(cookie).toContain('Max-Age=3600')
		expect(cookie).toContain('Secure')
	})

	it('omits Secure when not on https', () => {
		expect(buildSessionCookie('wsx_abc', false, 60)).not.toContain('Secure')
	})

	/**
	 * Over https the cookie uses the `__Host-` name, so the browser rejects any attempt
	 * to set it from another host or with a Domain attribute — the cookie-tossing fix.
	 */
	it('uses the __Host- name when secure', () => {
		expect(buildSessionCookie('wsx_abc', true, 60)).toContain(`${PRIVATE_SESSION_COOKIE_SECURE}=`)
		expect(sessionCookieName(true)).toBe(PRIVATE_SESSION_COOKIE_SECURE)
	})

	/** Plain http (local development) keeps the unprefixed name. */
	it('uses the plain name when not secure', () => {
		expect(buildSessionCookie('wsx_abc', false, 60)).toContain(`${PRIVATE_SESSION_COOKIE}=`)
		expect(sessionCookieName(false)).toBe(PRIVATE_SESSION_COOKIE)
	})
})

describe('secrets', () => {
	it('stores only a hash', () => {
		const s = generateSessionSecret()
		expect(s.hash).toMatch(/^[0-9a-f]{64}$/)
		expect(s.hash).not.toContain(s.value)
		expect(s.value.startsWith('wsx_')).toBe(true)
	})

	it('mints distinct handoffs', () => {
		const seen = new Set(Array.from({ length: 200 }, () => generateHandoffSecret().value))
		expect(seen.size).toBe(200)
	})

	it('matches a correct hash and rejects a wrong one', () => {
		const s = generateSessionSecret()
		expect(secretsMatch(s.hash, hashSecret(s.value))).toBe(true)
		expect(secretsMatch(s.hash, hashSecret('wsx_other'))).toBe(false)
	})
})
