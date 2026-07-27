import { describe, expect, it } from 'bun:test'
import { redactSecretPath } from '@wispplace/observability'
import {
	buildPrivateStorageKey,
	generateRecordId,
	generateSiteId,
	isValidSiteId,
	privateResponseHeaders,
} from './site-id'
import { generateShareToken } from './token'

describe('private site identifiers', () => {
	it('generates readable, unique dns labels', () => {
		const ids = Array.from({ length: 500 }, generateSiteId)
		expect(new Set(ids).size).toBe(ids.length)
		for (const id of ids) {
			expect(isValidSiteId(id)).toBe(true)
			expect(id).toMatch(/^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}-\d{4}$/)
			expect(id.length).toBeLessThanOrEqual(63)
		}
	})

	it('uses separate opaque row ids', () => {
		const ids = Array.from({ length: 500 }, generateRecordId)
		expect(new Set(ids).size).toBe(ids.length)
		expect(ids[0]).toMatch(/^[0-9a-f]{16}$/)
		expect(isValidSiteId(ids[0]!)).toBe(false)
	})

	it.each(['../../etc/passwd', 'abc/def', '..', '', 'UPPER-WORDS-DOG-1234', 'word-word-word'])('rejects %s', (id) => {
		expect(isValidSiteId(id)).toBe(false)
	})
})

describe('storage and response isolation', () => {
	it('builds only namespaced keys', () => {
		const id = generateSiteId()
		expect(buildPrivateStorageKey(id, '/index.html')).toBe(`private/${id}/index.html`)
		expect(() => buildPrivateStorageKey('../..', 'index.html')).toThrow('invalid private site id')
		expect(`did:plc:abc/site/index.html`.startsWith('private/')).toBe(false)
	})

	it('prevents caching, indexing, and referrer leakage', () => {
		const headers = privateResponseHeaders()
		expect(headers['Cache-Control']).toContain('no-store')
		expect(headers['Referrer-Policy']).toBe('no-referrer')
		expect(headers['X-Robots-Tag']).toContain('noindex')
	})
})

describe('share token hygiene', () => {
	it('uses short, hashed, unique tokens', () => {
		const tokens = Array.from({ length: 200 }, generateShareToken)
		expect(new Set(tokens.map(({ token }) => token)).size).toBe(tokens.length)
		for (const { token, tokenHash, tokenPrefix } of tokens) {
			expect(token).toMatch(/^wss_[A-Za-z0-9_-]{22}$/)
			expect(tokenHash).toMatch(/^[0-9a-f]{64}$/)
			expect(tokenPrefix.length).toBeLessThan(token.length / 2)
		}
	})

	it('redacts tokens from short-link telemetry', () => {
		const { token } = generateShareToken()
		expect(redactSecretPath(`/p/${token}`)).toBe('/p/<redacted>')
		expect(redactSecretPath(`/p/${token}/nested`)).toBe('/p/<redacted>/nested')
		expect(redactSecretPath('/editor')).toBe('/editor')
	})
})
