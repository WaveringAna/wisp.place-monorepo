import { beforeEach, describe, expect, test } from 'bun:test'
import { OAUTH_SCOPE } from '../lib/oauth-client-metadata'
import { createAuthRoutes } from './auth'

const calls: Array<{ identifier: string; options: Record<string, unknown> }> = []

// The authorization server is the boundary: the real authorizeWisp builds the request it receives.
const client = {
	authorize: async (identifier: string, options: Record<string, unknown>) => {
		calls.push({ identifier, options })
		return new URL('https://pds.example/oauth/authorize?request_uri=x')
	},
}
const notUsedBySignIn = async (): Promise<never> => {
	throw new Error('not used when starting a sign-in')
}
const app = createAuthRoutes({
	eventualRead: { getUserStatus: notUsedBySignIn },
	backfillSitesFromPds: notUsedBySignIn,
	resolvePrivateShareState: notUsedBySignIn,
})(client as never, 'test-cookie-secret')
const login = (query: string) => app.handle(new Request(`http://localhost/api/auth/login?${query}`))

describe('GET /api/auth/login', () => {
	beforeEach(() => {
		calls.length = 0
	})

	test('asks the server for its sign-up page with prompt=create', async () => {
		const response = await login('pds=pds.wisp.place&prompt=create')
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe('https://pds.example/oauth/authorize?request_uri=x')
		expect(calls).toEqual([
			{
				identifier: 'https://pds.wisp.place',
				options: { state: expect.any(String), prompt: 'create', scope: OAUTH_SCOPE },
			},
		])
	})

	test('sends no prompt for a plain sign-in', async () => {
		await login('login_hint=alice.example')
		expect(calls).toEqual([{ identifier: 'alice.example', options: { state: expect.any(String), scope: OAUTH_SCOPE } }])
	})

	test('ignores prompts other than create', async () => {
		await login('login_hint=alice.example&prompt=none')
		expect(calls[0]?.options).not.toHaveProperty('prompt')
	})
	test('passes sso=github through to the authorize URL', async () => {
		const response = await login('pds=pds.wisp.place&sso=github')
		expect(response.headers.get('location')).toBe('https://pds.example/oauth/authorize?request_uri=x&sso=github')
	})

	test('drops sso values other than github', async () => {
		const response = await login('pds=pds.wisp.place&sso=evil')
		expect(response.headers.get('location')).toBe('https://pds.example/oauth/authorize?request_uri=x')
	})
})
