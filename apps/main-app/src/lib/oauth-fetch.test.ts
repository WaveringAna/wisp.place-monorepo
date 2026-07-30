import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createOAuthFetch } from './oauth-fetch'

const originalFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = originalFetch
})

describe('createOAuthFetch', () => {
	test('rewrites only the configured public origin', async () => {
		const seen: string[] = []
		globalThis.fetch = mock(async (input) => {
			seen.push(input instanceof Request ? input.url : String(input))
			return new Response('ok')
		}) as unknown as typeof fetch

		const oauthFetch = createOAuthFetch({
			rewriteFrom: 'http://localhost:3300',
			rewriteTo: 'http://pds:3300',
		})

		await oauthFetch('http://localhost:3300/oauth/token?code=one')
		await oauthFetch('http://localhost:3001/health')

		expect(seen).toEqual(['http://pds:3300/oauth/token?code=one', 'http://localhost:3001/health'])
	})

	test('preserves request method, headers, and body', async () => {
		let seen: Request | undefined
		globalThis.fetch = mock(async (input) => {
			seen = input instanceof Request ? input : new Request(input)
			return new Response('ok')
		}) as unknown as typeof fetch

		const oauthFetch = createOAuthFetch({
			rewriteFrom: 'http://localhost:3300',
			rewriteTo: 'http://pds:3300',
		})
		await oauthFetch(
			new Request('http://localhost:3300/oauth/par', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'client_id=wisp',
			}),
		)

		expect(seen?.url).toBe('http://pds:3300/oauth/par')
		expect(seen?.method).toBe('POST')
		expect(seen?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
		expect(await seen?.text()).toBe('client_id=wisp')
	})

	test('requires both rewrite origins', () => {
		expect(() => createOAuthFetch({ rewriteFrom: 'http://localhost:3300' })).toThrow(
			'OAUTH_FETCH_REWRITE_FROM and OAUTH_FETCH_REWRITE_TO must be set together',
		)
	})
})
