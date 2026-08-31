import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createOAuthFetch } from './oauth-fetch'

const originalFetch = globalThis.fetch
const originalLocalDev = process.env.LOCAL_DEV
const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 as const }

function restoreEnvironment(): void {
	globalThis.fetch = originalFetch
	// Bun.env can retain a value after process.env is deleted, so restore an
	// explicit false sentinel when the test process started without LOCAL_DEV.
	if (originalLocalDev === undefined) process.env.LOCAL_DEV = 'false'
	else process.env.LOCAL_DEV = originalLocalDev
}

afterEach(restoreEnvironment)

describe('createOAuthFetch', () => {
	test('rewrites only the configured development origin', async () => {
		process.env.LOCAL_DEV = 'true'
		const rewritten: string[] = []
		const pinned: string[] = []
		globalThis.fetch = mock(async (input) => {
			rewritten.push(input instanceof Request ? input.url : String(input))
			return new Response('ok')
		}) as unknown as typeof fetch

		const oauthFetch = createOAuthFetch({
			rewriteFrom: 'http://localhost:3300',
			rewriteTo: 'http://pds:3300',
			resolver: async () => [{ address: '93.184.216.34', family: 4 }],
			transport: async ({ url }) => {
				pinned.push(url.toString())
				return new Response('ok')
			},
		})

		await oauthFetch('http://localhost:3300/oauth/token?code=one')
		await oauthFetch('https://other.example/health')

		expect(rewritten).toEqual(['http://pds:3300/oauth/token?code=one'])
		expect(pinned).toEqual(['https://other.example/health'])
	})

	test('preserves request method, headers, and body for the explicit rewrite', async () => {
		process.env.LOCAL_DEV = 'true'
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

	test('pins generic OAuth POST requests while preserving the body', async () => {
		let seen: { method: string; body: string; address: string } | undefined
		const oauthFetch = createOAuthFetch({
			resolver: async () => [PUBLIC_ADDRESS],
			transport: async ({ method, body, address }) => {
				seen = { method, body: new TextDecoder().decode(body), address: address.address }
				return new Response('ok')
			},
		})

		const response = await oauthFetch('https://oauth.example/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'grant_type=authorization_code',
		})
		expect(await response.text()).toBe('ok')
		expect(seen).toEqual({ method: 'POST', body: 'grant_type=authorization_code', address: PUBLIC_ADDRESS.address })
	})

	test('rejects private and mixed DNS answers before transport', async () => {
		const transport = mock(async () => new Response('ok'))
		const oauthFetch = createOAuthFetch({
			resolver: async (hostname) =>
				hostname === 'mixed.example'
					? [
							{ address: '93.184.216.34', family: 4 },
							{ address: '10.0.0.1', family: 4 },
						]
					: [{ address: '127.0.0.1', family: 4 }],
			transport,
		})

		await expect(oauthFetch('https://127.0.0.1/secret')).rejects.toThrow('not public')
		await expect(oauthFetch('https://mixed.example/secret')).rejects.toThrow('not public')
		expect(transport).not.toHaveBeenCalled()
	})

	test('revalidates redirects and bounds response bodies', async () => {
		const seen: string[] = []
		const oauthFetch = createOAuthFetch({
			resolver: async () => [{ address: '93.184.216.34', family: 4 }],
			transport: async ({ url }) => {
				seen.push(url.toString())
				return new Response('x'.repeat(1024 * 1024 + 1))
			},
		})
		await expect(oauthFetch('https://public.example/large')).rejects.toThrow('exceeds size limit')
		expect(seen).toEqual(['https://public.example/large'])

		const redirectFetch = createOAuthFetch({
			resolver: async () => [{ address: '93.184.216.34', family: 4 }],
			transport: async ({ url }) =>
				url.hostname === 'public.example'
					? new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/internal' } })
					: new Response('ok'),
		})
		await expect(redirectFetch('https://public.example/start')).rejects.toThrow('not public')
	})

	test('requires both rewrite origins and the development gate', () => {
		process.env.LOCAL_DEV = 'false'
		expect(() => createOAuthFetch({ rewriteFrom: 'http://localhost:3300' })).toThrow(
			'OAUTH_FETCH_REWRITE_FROM and OAUTH_FETCH_REWRITE_TO must be set together',
		)
		expect(() => createOAuthFetch({ rewriteFrom: 'http://localhost:3300', rewriteTo: 'http://pds:3300' })).toThrow(
			'LOCAL_DEV=true',
		)
	})
})
