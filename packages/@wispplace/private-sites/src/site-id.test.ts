import { describe, expect, it } from 'bun:test'
import {
	buildPrivateStorageKey,
	generateRecordId,
	generateSiteId,
	isValidSiteId,
	privateResponseHeaders,
} from './site-id'
import { redactSecretPath } from '@wispplace/observability'
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

	/** Internal row ids stay opaque; they are not hostnames and are not read aloud. */
	it('generates opaque record ids that are not site ids', () => {
		const id = generateRecordId()
		expect(id).toMatch(/^[234567a-z]{13}$/)
		expect(isValidSiteId(id)).toBe(false)
		expect(new Set(Array.from({ length: 500 }, () => generateRecordId())).size).toBe(500)
	})

	it('rejects ids with path traversal or separators', () => {
		for (const bad of ['../../etc/passwd', 'abc/def', 'abcdefghijkl/', '..', '', 'ABCDEFGHIJKLM']) {
			expect(isValidSiteId(bad)).toBe(false)
		}
	})

	/**
	 * The id is a hostname a person reads and repeats, so its readable shape is a
	 * behavioural guarantee rather than an implementation detail.
	 */
	it('reads as three words and four digits', () => {
		for (let i = 0; i < 100; i += 1) {
			expect(generateSiteId()).toMatch(/^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}-\d{4}$/)
		}
	})

	/** Must survive being used as a DNS label under `.priv.<host>`. */
	it('is a valid dns label', () => {
		for (let i = 0; i < 100; i += 1) {
			const id = generateSiteId()
			expect(id.length).toBeLessThanOrEqual(63)
			expect(id.startsWith('-')).toBe(false)
			expect(id.endsWith('-')).toBe(false)
			expect(id).not.toContain('.')
		}
	})

	/**
	 * Record keys allow letters, digits, hyphens, periods and underscores, up to 512
	 * characters. Holding this keeps the id reusable as an `skey` under proposal 0016.
	 */
	it('stays valid as an atproto record key', () => {
		for (let i = 0; i < 50; i += 1) {
			expect(generateSiteId()).toMatch(/^[A-Za-z0-9._:~-]{1,512}$/)
		}
	})

	it('rejects a malformed readable id', () => {
		for (const bad of ['lovable-plushie-dog', 'lovable-plushie-dog-12', 'lovable_plushie_dog_1226', '-a-b-c-1226']) {
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

	/**
	 * The token is the whole of a `wisp.place/p/<token>` link, which is meant to be pasted
	 * into a chat message. Length is a product property here, not an implementation detail,
	 * so it is pinned: `wss_` plus 22 base64url characters of 128-bit entropy.
	 */
	it('stays short enough to paste as a link', () => {
		const { token } = generateShareToken()
		expect(token.length).toBe(26)
		expect(`https://wisp.place/p/${token}`.length).toBeLessThanOrEqual(48)
	})

	it('keeps the display prefix too short to authenticate with', () => {
		const { token, tokenPrefix } = generateShareToken()
		expect(token.startsWith(tokenPrefix)).toBe(true)
		expect(tokenPrefix.length).toBeLessThan(token.length / 2)
	})
})

/**
 * The short share link (`wisp.place/p/<token>`) puts a credential in a URL *path*, not a
 * query string. Metric labels and error logs record paths, so these pin that the secret is
 * stripped before it can reach a log sink.
 */
describe('short share links keep the token out of telemetry', () => {
	it('redacts the token segment', () => {
		const { token } = generateShareToken()
		const redacted = redactSecretPath(`/p/${token}`)
		expect(redacted).not.toContain(token)
		expect(redacted).toBe('/p/<redacted>')
	})

	it('redacts the token but keeps any trailing path', () => {
		const { token } = generateShareToken()
		expect(redactSecretPath(`/p/${token}/nested`)).toBe('/p/<redacted>/nested')
	})

	it('leaves unrelated paths untouched', () => {
		for (const path of ['/editor', '/api/user/private-sites', '/p', '/policy']) {
			expect(redactSecretPath(path)).toBe(path)
		}
	})
})
