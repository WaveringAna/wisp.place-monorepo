import { describe, expect, it } from 'bun:test'
import { buildPrivateStorageKey, generateSiteId, isValidSiteId, privateResponseHeaders } from './site-id'
import { generateShareToken, redactToken, redactUrlForLog } from './token'

describe('site ids', () => {
	it('generates valid ids', () => {
		for (let i = 0; i < 200; i += 1) {
			expect(isValidSiteId(generateSiteId())).toBe(true)
		}
	})

	it('generates distinct ids', () => {
		const seen = new Set(Array.from({ length: 500 }, () => generateSiteId()))
		expect(seen.size).toBe(500)
	})

	it('rejects ids with path traversal or separators', () => {
		for (const bad of ['../../etc/passwd', 'abc/def', 'abcdefghijkl/', '..', '', 'ABCDEFGHIJKLM']) {
			expect(isValidSiteId(bad)).toBe(false)
		}
	})

	it('rejects a DID as a site id, so public keys can never be private ids', () => {
		expect(isValidSiteId('did:plc:abcdefghijklmnop')).toBe(false)
	})
})

describe('storage key isolation', () => {
	it('namespaces private files under the private prefix', () => {
		const id = generateSiteId()
		expect(buildPrivateStorageKey(id, 'index.html')).toBe(`private/${id}/index.html`)
	})

	it('strips a leading slash', () => {
		const id = generateSiteId()
		expect(buildPrivateStorageKey(id, '/index.html')).toBe(`private/${id}/index.html`)
	})

	it('throws rather than building a key from an invalid id', () => {
		expect(() => buildPrivateStorageKey('../..', 'index.html')).toThrow('invalid private site id')
	})

	/**
	 * The core isolation invariant. Public keys are always `${did}/${rkey}/${path}` and a
	 * DID always starts with "did:", so a public request can never name a private key.
	 */
	it('cannot collide with the public key namespace', () => {
		const id = generateSiteId()
		const privateKey = buildPrivateStorageKey(id, 'index.html')
		const publicKey = `did:plc:abc123/mysite/index.html`

		expect(privateKey.startsWith('private/')).toBe(true)
		expect(publicKey.startsWith('private/')).toBe(false)
		expect(privateKey.split('/')[0]!.startsWith('did:')).toBe(false)
	})
})

describe('private response headers', () => {
	it('forbids storing, indexing, and referrer leakage', () => {
		const h = privateResponseHeaders()
		expect(h['Cache-Control']).toContain('no-store')
		expect(h['Cache-Control']).toContain('private')
		expect(h['Referrer-Policy']).toBe('no-referrer')
		expect(h['X-Robots-Tag']).toContain('noindex')
	})
})

describe('secret hygiene', () => {
	it('never returns the token body from redactToken', () => {
		const { token } = generateShareToken()
		const red = redactToken(token)
		expect(red).not.toContain(token.slice(5))
		expect(red).toContain('redacted')
	})

	it('strips the share parameter from a url before logging', () => {
		const { token } = generateShareToken()
		const red = redactUrlForLog(`https://wisp.place/p/abcdefghijklm/?k=${token}`, 'k')
		expect(red).not.toContain(token)
		expect(red).toContain('k=REDACTED')
	})

	it('leaves urls without the parameter alone', () => {
		expect(redactUrlForLog('https://wisp.place/p/abcdefghijklm/', 'k')).toBe('https://wisp.place/p/abcdefghijklm/')
	})

	it('hashes tokens instead of storing them', () => {
		const t = generateShareToken()
		expect(t.tokenHash).toMatch(/^[0-9a-f]{64}$/)
		expect(t.tokenHash).not.toContain(t.token)
		expect(t.token.startsWith('wss_')).toBe(true)
	})

	it('produces distinct tokens', () => {
		const seen = new Set(Array.from({ length: 200 }, () => generateShareToken().token))
		expect(seen.size).toBe(200)
	})
})
