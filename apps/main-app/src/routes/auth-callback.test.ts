import { beforeEach, describe, expect, test } from 'bun:test'
import { OAUTH_LEGACY_SCOPE } from '../lib/oauth-client-metadata'
import { OAUTH_FLOW_COOKIE_NAME } from '../lib/oauth-flow'
import { SESSION_COOKIE_NAME } from '../lib/wisp-auth'
import { createAuthRoutes } from './auth'

const DID = 'did:plc:attacker'
const states: string[] = []
let grantedScope: string | undefined = OAUTH_LEGACY_SCOPE

// The OAuth client stands in for the authorization server: it hands back the
// application state of the last sign-in it started, as a real callback does.
const client = {
	authorize: async (_identifier: string, options: { state: string }) => {
		states.push(options.state)
		return new URL('https://pds.example/oauth/authorize?request_uri=x')
	},
	callback: async () => ({
		session: { did: DID, getTokenInfo: async () => ({ scope: grantedScope }) },
		state: states[states.length - 1],
	}),
}

const app = createAuthRoutes({
	eventualRead: { getUserStatus: async () => ({ sites: [{}], domain: null }) as never },
	backfillSitesFromPds: async () => ({ found: 0, queued: 0 }),
	resolvePrivateShareState: async () => null,
})(client as never, 'test-cookie-secret')

const cookieFrom = (response: Response, name: string): string | undefined =>
	response.headers
		.getSetCookie()
		.map((line) => line.split(';')[0] ?? '')
		.find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1)

const startSignIn = async (): Promise<string> => {
	const response = await app.handle(new Request('http://localhost/api/auth/login?login_hint=alice.example'))
	const flow = cookieFrom(response, OAUTH_FLOW_COOKIE_NAME)
	expect(flow).toBeDefined()
	return flow as string
}

const callback = (cookie?: string) =>
	app.handle(
		new Request('http://localhost/api/auth/callback?code=c&state=s&iss=https://pds.example', {
			headers: cookie ? { cookie } : {},
		}),
	)

beforeEach(() => {
	states.length = 0
	grantedScope = OAUTH_LEGACY_SCOPE
})

describe('GET /api/auth/callback', () => {
	test('signs in the browser that started the sign-in', async () => {
		const flow = await startSignIn()
		const response = await callback(flow)
		expect(response.headers.get('location')).toBe('/editor')
		expect(cookieFrom(response, SESSION_COOKIE_NAME)).toBeDefined()
	})

	test('refuses a callback opened in another browser', async () => {
		await startSignIn()
		const response = await callback()
		expect(response.headers.get('location')).toBe('/?error=auth_failed')
		expect(cookieFrom(response, SESSION_COOKIE_NAME)).toBeUndefined()
	})

	test("refuses a browser holding a different sign-in's cookie", async () => {
		const victimFlow = await startSignIn()
		await startSignIn()
		const response = await callback(victimFlow)
		expect(response.headers.get('location')).toBe('/?error=auth_failed')
		expect(cookieFrom(response, SESSION_COOKIE_NAME)).toBeUndefined()
	})

	test('keeps the binding through the granular-scope retry', async () => {
		const flow = await startSignIn()
		grantedScope = 'atproto'
		const retry = await callback(flow)
		expect(retry.headers.get('location')).toBe('https://pds.example/oauth/authorize?request_uri=x')
		expect(cookieFrom(retry, OAUTH_FLOW_COOKIE_NAME)).toBeUndefined()
		grantedScope = OAUTH_LEGACY_SCOPE
		const response = await callback(flow)
		expect(response.headers.get('location')).toBe('/editor')
		expect(cookieFrom(response, SESSION_COOKIE_NAME)).toBeDefined()
	})
})
