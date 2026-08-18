import { describe, expect, test } from 'bun:test'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import { applyCustomHeaders, decodeRequestPathname } from './request-utils'

const settings = {
	$type: 'place.wisp.settings',
	directoryListing: false,
	cleanUrls: false,
	headers: [
		{ name: 'Service-Worker-Allowed', value: '/' },
		{ name: 'X-Site-Header', value: 'ok' },
	],
} satisfies WispSettings

describe('applyCustomHeaders', () => {
	test('blocks service worker scope expansion on the shared origin', () => {
		const headers: Record<string, string> = {}

		applyCustomHeaders(headers, 'sw.js', settings, { sharedOrigin: true })

		expect(headers['Service-Worker-Allowed']).toBeUndefined()
		expect(headers['X-Site-Header']).toBe('ok')
	})

	test('allows service worker scope headers on isolated custom domains', () => {
		const headers: Record<string, string> = {}

		applyCustomHeaders(headers, 'sw.js', settings)

		expect(headers['Service-Worker-Allowed']).toBe('/')
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
})
