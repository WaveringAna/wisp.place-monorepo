import { beforeEach, describe, expect, mock, test } from 'bun:test'

const calls: Array<{ identifier: string; options: Record<string, unknown> }> = []

mock.module('../lib/oauth-authorize', () => ({
	authorizeWisp: async (_client: unknown, identifier: string, options: Record<string, unknown>) => {
		calls.push({ identifier, options })
		return new URL('https://pds.example/oauth/authorize?request_uri=x')
	},
	authorizeWispLegacy: async () => new URL('https://pds.example/'),
	grantedAddOns: async () => [],
	isLegacyScopeState: () => false,
	isScopeAddOn: () => false,
	missingGrantedCapabilities: async () => [],
	setupAddOn: () => null,
	setupState: () => '',
	setupTab: () => '',
	stateValue: () => undefined,
	unmarkLegacyScopeState: () => undefined,
}))
mock.module('../lib/db', () => ({ eventualRead: {} }))
mock.module('../lib/pds-backfill', () => ({ backfillSitesFromPds: async () => null }))
mock.module('./private-redeem', () => ({ resolvePrivateShareState: async () => null }))
mock.module('../lib/wisp-auth', () => ({
	SESSION_COOKIE_NAME: 'did',
	authenticateRequest: async () => null,
	invalidateSessionCache: () => undefined,
}))

const { authRoutes } = await import('./auth')
const app = authRoutes({} as never, 'test-cookie-secret')
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
			{ identifier: 'https://pds.wisp.place', options: { state: expect.any(String), prompt: 'create' } },
		])
	})

	test('sends no prompt for a plain sign-in', async () => {
		await login('login_hint=alice.example')
		expect(calls).toEqual([{ identifier: 'alice.example', options: { state: expect.any(String) } }])
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
