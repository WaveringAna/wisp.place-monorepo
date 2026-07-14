import { describe, expect, test } from 'bun:test'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import { applyCustomHeaders } from './request-utils'

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
