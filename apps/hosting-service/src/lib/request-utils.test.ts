import { describe, expect, test } from 'bun:test'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import {
	applyCustomHeaders,
	DEFAULT_INDEX_FILES,
	decodeRequestPathname,
	getIndexFiles,
	MAX_GLOB_MATCH_OPERATIONS,
	matchGlob,
	matchGlobWithStats,
} from './request-utils'

const baseSettings = {
	$type: 'place.wisp.settings',
	directoryListing: false,
	cleanUrls: false,
} satisfies WispSettings

function withSettings(overrides: Partial<WispSettings>): WispSettings {
	return { ...baseSettings, ...overrides }
}

const settings = withSettings({
	headers: [
		{ name: 'Service-Worker-Allowed', value: '/' },
		{ name: 'X-Site-Header', value: 'ok' },
	],
})

describe('matchGlob', () => {
	test('supports documented star and question-mark wildcards', () => {
		expect(matchGlob('assets/app.js', '/assets/*.js')).toBe(true)
		expect(matchGlob('/assets/a.js', '/assets/?.js')).toBe(true)
		expect(matchGlob('/assets/app.js', '/assets/?.js')).toBe(false)
	})

	test('treats regex-looking glob characters as literals', () => {
		const literalPath = '/assets/[a-z]+.(js)$'
		expect(matchGlob(literalPath, literalPath)).toBe(true)
		expect(matchGlob('/assets/app.js', literalPath)).toBe(false)
	})

	test('rejects oversized paths and patterns before matching', () => {
		expect(matchGlob('a'.repeat(100_000), '*')).toBe(false)
		expect(matchGlob('/asset.js', '*'.repeat(501))).toBe(false)
	})

	test('keeps normal long suffix globs usable within the budget', () => {
		expect(matchGlob(`${'a'.repeat(4_091)}.html`, '*.html')).toBe(true)
	})

	test('bounds repeated star suffix retries by an explicit operation budget', () => {
		const result = matchGlobWithStats('a'.repeat(4_096), `*${'a'.repeat(498)}b`)

		expect(result.matches).toBe(false)
		expect(result.budgetExhausted).toBe(true)
		expect(result.operations).toBe(MAX_GLOB_MATCH_OPERATIONS)
	})
})

describe('applyCustomHeaders', () => {
	test('blocks origin-wide headers on the shared origin while keeping safe headers', () => {
		const headers: Record<string, string> = {}
		const blockedHeaderNames = [
			'Set-Cookie',
			'Set-Cookie2',
			'Clear-Site-Data',
			'Service-Worker-Allowed',
			'Access-Control-Allow-Origin',
			'Connection',
			'Transfer-Encoding',
			'Content-Length',
			'Content-Encoding',
			'Trailer',
			'Upgrade',
			'Strict-Transport-Security',
			'Alt-Svc',
			'Accept-CH',
			'NEL',
			'Report-To',
			'Origin-Agent-Cluster',
		]
		const blockedHeaders = blockedHeaderNames.map((name) => ({ name, value: 'blocked' }))

		applyCustomHeaders(
			headers,
			'assets/app.js',
			withSettings({
				headers: [
					...blockedHeaders,
					{ name: 'Cache-Control', value: 'public, max-age=60', path: '/assets/*' },
					{ name: 'Content-Security-Policy', value: "default-src 'self'" },
					{ name: 'X-Content-Type-Options', value: 'nosniff' },
				],
			}),
			{ sharedOrigin: true },
		)

		for (const name of blockedHeaderNames) {
			expect(headers[name]).toBeUndefined()
		}
		expect(headers['Cache-Control']).toBe('public, max-age=60')
		expect(headers['Content-Security-Policy']).toBe("default-src 'self'")
		expect(headers['X-Content-Type-Options']).toBe('nosniff')
	})

	test('allows shared-origin-safe path globs and blocks case-insensitive CORS headers', () => {
		const headers: Record<string, string> = {}

		applyCustomHeaders(
			headers,
			'/docs/guide.html',
			withSettings({
				headers: [
					{ name: 'X-Guide', value: 'yes', path: '/docs/*.html' },
					{ name: 'aCcEsS-cOnTrOl-Expose-Headers', value: 'X-Guide' },
				],
			}),
			{ sharedOrigin: true },
		)

		expect(headers['X-Guide']).toBe('yes')
		expect(headers['aCcEsS-cOnTrOl-Expose-Headers']).toBeUndefined()
	})

	test('keeps valid custom-domain headers but rejects unsafe framing headers', () => {
		const headers: Record<string, string> = {}

		applyCustomHeaders(
			headers,
			'sw.js',
			withSettings({
				headers: [
					{ name: 'Set-Cookie', value: 'session=abc; Path=/; Secure' },
					{ name: 'Clear-Site-Data', value: '"cache"' },
					{ name: 'Service-Worker-Allowed', value: '/' },
					{ name: 'Access-Control-Allow-Origin', value: 'https://example.com' },
					{ name: 'Accept-Ranges', value: 'bytes' },
					{ name: 'Content-Length', value: '1' },
					{ name: 'Content-Encoding', value: 'gzip' },
					{ name: 'Content-Range', value: 'bytes 0-0/1' },
					{ name: 'Transfer-Encoding', value: 'chunked' },
				],
			}),
		)

		expect(headers['Set-Cookie']).toBe('session=abc; Path=/; Secure')
		expect(headers['Clear-Site-Data']).toBe('"cache"')
		expect(headers['Service-Worker-Allowed']).toBe('/')
		expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com')
		expect(headers['Accept-Ranges']).toBeUndefined()
		expect(headers['Content-Length']).toBeUndefined()
		expect(headers['Content-Encoding']).toBeUndefined()
		expect(headers['Content-Range']).toBeUndefined()
		expect(headers['Transfer-Encoding']).toBeUndefined()
	})

	test('does not let custom ETags replace representation validators', () => {
		const headers: Record<string, string> = { ETag: '"stored-checksum-identity"' }

		applyCustomHeaders(headers, 'asset.js', withSettings({ headers: [{ name: 'eTaG', value: '"tenant-validator"' }] }))

		expect(headers.ETag).toBe('"stored-checksum-identity"')
		expect(headers.eTaG).toBeUndefined()
		expect(Object.keys(headers).filter((name) => name.toLowerCase() === 'etag')).toHaveLength(1)
	})

	test('rejects invalid names, values, and CRLF injection attempts', () => {
		const headers: Record<string, string> = {}

		applyCustomHeaders(
			headers,
			'index.html',
			withSettings({
				headers: [
					{ name: 'X-Valid', value: 'safe' },
					{ name: 'Bad Header', value: 'ignored' },
					{ name: 'X-Injected\r\nSet-Cookie', value: 'ignored' },
					{ name: 'X-CRLF', value: 'safe\r\nSet-Cookie: session=attacker' },
					{ name: 'X-Nul', value: 'safe\0not-safe' },
					{ name: 'X-Unicode', value: 'safe\u2028not-safe' },
					{ name: 'X-Too-Long', value: 'a'.repeat(1_001) },
				],
			}),
		)

		expect(headers['X-Valid']).toBe('safe')
		expect(headers['Bad Header']).toBeUndefined()
		expect(headers['X-Injected\r\nSet-Cookie']).toBeUndefined()
		expect(headers['X-CRLF']).toBeUndefined()
		expect(headers['X-Nul']).toBeUndefined()
		expect(headers['X-Unicode']).toBeUndefined()
		expect(headers['X-Too-Long']).toBeUndefined()
	})

	test('replaces existing response headers case-insensitively', () => {
		const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' }

		applyCustomHeaders(
			headers,
			'index.html',
			withSettings({ headers: [{ name: 'content-type', value: 'text/html; charset=utf-8' }] }),
		)

		expect(headers['Content-Type']).toBe('text/html; charset=utf-8')
		expect(headers['content-type']).toBeUndefined()
		expect(Object.keys(headers).filter((name) => name.toLowerCase() === 'content-type')).toHaveLength(1)
	})

	test('blocks service worker scope expansion on the shared origin', () => {
		const headers: Record<string, string> = {}

		applyCustomHeaders(headers, 'sw.js', settings, { sharedOrigin: true })

		expect(headers['Service-Worker-Allowed']).toBeUndefined()
		expect(headers['X-Site-Header']).toBe('ok')
	})
})

describe('getIndexFiles', () => {
	test('keeps only normalized relative site paths', () => {
		const indexFiles = getIndexFiles(
			withSettings({
				indexFiles: [
					'nested/index.html',
					'../outside.html',
					'/absolute.html',
					'folder\\index.html',
					'bad\0name.html',
					'https://example.com/index.html',
					'./index.html',
					'folder//index.html',
					'folder/../index.html',
					'a'.repeat(256),
				],
			}),
		)

		expect(indexFiles).toEqual(['nested/index.html'])
	})

	test('uses defaults when no configured index path is safe and bounds the list length', () => {
		expect(getIndexFiles(withSettings({ indexFiles: ['../outside.html'] }))).toEqual(DEFAULT_INDEX_FILES)

		const configuredIndexFiles = Array.from({ length: 11 }, (_, index) => `index-${index}.html`)
		expect(getIndexFiles(withSettings({ indexFiles: configuredIndexFiles }))).toEqual(configuredIndexFiles.slice(0, 10))
	})
})

describe('decodeRequestPathname', () => {
	test('decodes percent-encoded file names before storage lookup', () => {
		expect(decodeRequestPathname('/486x486bb%203.webp')).toBe('/486x486bb 3.webp')
		expect(decodeRequestPathname('/caf%C3%A9/photo.webp')).toBe('/café/photo.webp')
	})

	test('rejects malformed percent encoding', () => {
		expect(decodeRequestPathname('/invalid%2')).toBeNull()
	})

	test('rejects literal and percent-decoded NULs before path sanitization', () => {
		expect(decodeRequestPathname('/unsafe%00path')).toBeNull()
		expect(decodeRequestPathname('/unsafe\0path')).toBeNull()
	})
})
