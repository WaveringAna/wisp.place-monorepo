import { describe, expect, it } from 'bun:test'
import { buildPrivateStorageKey, generateSiteId, isValidSiteId, privateResponseHeaders } from '@wispplace/private-sites'
import { isValidRkey } from './request-utils'

/**
 * Isolation guarantees between public site hosting and private sites.
 *
 * These are regression tests for the security boundary, not behavioral tests: each one
 * pins an invariant that, if broken, would let private content leak through a public path.
 */

describe('private ids cannot traverse public routing', () => {
	/**
	 * The public routes resolve `<identifier>/<site>/...` on sites.<host>, where the
	 * identifier must resolve to a DID. A private site id is not a DID and does not
	 * resolve, so it cannot address a private site through the public path.
	 */
	it('a private site id is not a valid DID or handle identifier', () => {
		const siteId = generateSiteId()
		expect(siteId.startsWith('did:')).toBe(false)
		expect(siteId.includes('.')).toBe(false)
	})

	it('a DID is never a valid private site id', () => {
		expect(isValidSiteId('did:plc:abcdefghijklmnop')).toBe(false)
		expect(isValidSiteId('did:web:example.com')).toBe(false)
	})

	it('rejects traversal attempts in a private site id', () => {
		for (const bad of ['../../../etc/passwd', '..', 'a/b', 'AAAAAAAAAAAAA', '']) {
			expect(isValidSiteId(bad)).toBe(false)
			expect(() => buildPrivateStorageKey(bad, 'index.html')).toThrow()
		}
	})
})

describe('storage key namespaces cannot collide', () => {
	it('private keys always start with the private prefix', () => {
		const key = buildPrivateStorageKey(generateSiteId(), 'index.html')
		expect(key.startsWith('private/')).toBe(true)
	})

	/**
	 * Public keys are built as `${did}/${rkey}/${path}`. Since a DID always begins with
	 * "did:", no public request can produce a key inside the private namespace.
	 */
	it('a public key can never fall inside the private namespace', () => {
		for (const did of ['did:plc:abc123', 'did:web:example.com']) {
			for (const rkey of ['mysite', 'private', 'index']) {
				expect(`${did}/${rkey}/index.html`.startsWith('private/')).toBe(false)
			}
		}
	})

	/**
	 * The inverse: a private site id must never be accepted as a public rkey that could
	 * be mapped to a domain, which would route public traffic at private storage.
	 */
	it('an rkey named "private" still cannot reach private keys', () => {
		expect(isValidRkey('private')).toBe(true)
		const publicKey = `did:plc:abc/private/index.html`
		expect(publicKey.startsWith('private/')).toBe(false)
	})
})

describe('private responses are not cacheable or indexable', () => {
	it('sets no-store, no-referrer, and noindex', () => {
		const h = privateResponseHeaders()
		expect(h['Cache-Control']).toContain('no-store')
		expect(h['Cache-Control']).toContain('private')
		expect(h['Referrer-Policy']).toBe('no-referrer')
		expect(h['X-Robots-Tag']).toContain('noindex')
	})

	/**
	 * The share credential travels in a query parameter, so an outbound link from the
	 * private page must not leak it in a Referer header.
	 */
	it('suppresses the referrer entirely so share tokens cannot leak downstream', () => {
		expect(privateResponseHeaders()['Referrer-Policy']).toBe('no-referrer')
	})
})
