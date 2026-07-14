import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_FETCH_TIMEOUT_MS, safeFetch } from './index'

const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
})

describe('safeFetch public-request defaults', () => {
	test('uses a bounded control-plane timeout', () => {
		expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30_000)
	})

	test('does not retry transient failures unless requested', async () => {
		let attempts = 0
		globalThis.fetch = (async () => {
			attempts++
			const error = new Error('fetch failed') as Error & { code: string }
			error.code = 'ECONNRESET'
			throw error
		}) as unknown as typeof fetch

		await expect(safeFetch('https://example.com/data')).rejects.toThrow('fetch failed')
		expect(attempts).toBe(1)
	})
})
