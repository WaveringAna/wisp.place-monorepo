import { describe, expect, it } from 'bun:test'
import { parseCookieHeader, readSessionDid, unsignCookieValue } from './session-cookie'

/**
 * Golden vectors captured from Elysia's own `signCookie` (elysia 1.4.29, which uses the
 * `cookie-signature` scheme). A byte-for-byte cross-check against the live Elysia
 * implementation lives in `apps/main-app/src/lib/private-session-compat.test.ts`, where
 * elysia is a real dependency; these vectors guard the scheme here without adding one.
 */
const VECTORS = [
	{ value: 'did:plc:abc', secret: 'secret1', signed: 'did:plc:abc.qU6Va32DfaoaxX+yo/lwpqbOb19OOwrGF1UM9R961h8' },
] as const

const SECRET = 'secret1'
const DID = 'did:plc:abc'

describe('cookie signature scheme', () => {
	it('verifies a known-good elysia signature', () => {
		for (const v of VECTORS) {
			expect(unsignCookieValue(v.signed, [v.secret])).toBe(v.value)
		}
	})

	it('rejects a cookie signed with a different secret', () => {
		expect(unsignCookieValue(VECTORS[0].signed, ['wrong-secret'])).toBeNull()
	})

	it('rejects a tampered value', () => {
		const tampered = VECTORS[0].signed.replace('did:plc:abc', 'did:plc:evi')
		expect(unsignCookieValue(tampered, [SECRET])).toBeNull()
	})

	it('rejects an unsigned value', () => {
		expect(unsignCookieValue(DID, [SECRET])).toBeNull()
	})

	it('rejects a value with an empty signature', () => {
		expect(unsignCookieValue(`${DID}.`, [SECRET])).toBeNull()
	})

	it('accepts any of several secrets, so rotation does not drop live sessions', () => {
		expect(unsignCookieValue(VECTORS[0].signed, ['newest-secret', SECRET])).toBe(DID)
	})
})

describe('parseCookieHeader', () => {
	it('parses multiple cookies', () => {
		expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' })
	})

	it('url-decodes values', () => {
		expect(parseCookieHeader('did=did%3Aplc%3Aabc')).toEqual({ did: 'did:plc:abc' })
	})

	it('returns empty for a missing header', () => {
		expect(parseCookieHeader(null)).toEqual({})
	})

	it('ignores malformed segments', () => {
		expect(parseCookieHeader('novalue; a=1')).toEqual({ a: '1' })
	})
})

describe('readSessionDid', () => {
	it('reads a valid signed session cookie', () => {
		expect(readSessionDid(`did=${encodeURIComponent(VECTORS[0].signed)}`, [SECRET])).toBe(DID)
	})

	it('returns null when the cookie is absent', () => {
		expect(readSessionDid('other=1', [SECRET])).toBeNull()
	})

	it('returns null for a forged cookie', () => {
		expect(readSessionDid(`did=${DID}.notavalidsignature`, [SECRET])).toBeNull()
	})

	it('rejects a verified value that is not a DID', () => {
		// 'not-a-did' signed with SECRET, per the same scheme.
		const signed = 'not-a-did.X8crsu1NuP8DBjjTNbpcWNaBW5bWpPISZ0wD2RAWSD8'
		expect(readSessionDid(`did=${encodeURIComponent(signed)}`, [SECRET])).toBeNull()
	})
})
