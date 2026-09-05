import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { signCookie } from 'elysia/utils'

const COOKIE_SECRET = 'test-cookie-secret'
const DID = 'did:example:alice'
const SENTINEL = 'SENTINEL_ACCESS_TOKEN_SHOULD_NOT_ESCAPE'
const PRIVATE_HOST = 'priv.wisp.test:3001'
const PRIVATE_HOSTNAME = 'priv.wisp.test'
const LIVE_SITE_ID = 'bright-brook-fox-1234'
const originalPrivateHost = process.env.PRIVATE_HOST

let failPrivateLookup = false
const liveSiteIds = new Set<string>()
const expiredSiteIds = new Set<string>()
const privateLookups: string[] = []
const publicLookups: string[] = []
const publicRegistrations = new Map<string, unknown>()
let secretDatabaseCalls = 0

const logger = {
	debug: () => undefined,
	error: () => undefined,
	info: () => undefined,
	warn: () => undefined,
}

const fail = async (): Promise<never> => {
	throw new Error(SENTINEL)
}

mock.module('@wispplace/observability', () => ({
	createLogger: () => logger,
}))

mock.module('../lib/db', () => ({
	addSupporter: fail,
	claimCustomDomain: async () => undefined,
	claimDomain: async () => 'claimed.wisp.test',
	consumeWebhookMutationRateLimit: async () => true,
	createWebhookSecret: async () => {
		secretDatabaseCalls++
		return { token: 'wsk_test-token', createdAt: '2026-01-01T00:00:00.000Z' }
	},
	deleteCustomDomain: async () => undefined,
	deleteWebhookSecret: async () => {
		secretDatabaseCalls++
		return true
	},
	deleteWispDomain: async () => undefined,
	eventualRead: {
		getAdminSites: fail,
		getAdminSupporters: fail,
	},
	getAdminDatabaseReport: fail,
	getWebhookEventHistory: fail,
	listWebhookSecrets: async () => [],
	rotateWebhookSecret: async () => {
		secretDatabaseCalls++
		return { token: 'wsk_test-token', rotatedAt: '2026-01-01T00:00:00.000Z' }
	},
	getCustomDomainById: async () => null,
	getCustomDomainInfo: async () => null,
	getDomainByDid: async () => null,
	isDomainAvailable: async () => false,
	isDomainRegistered: async (domain: string) => {
		publicLookups.push(domain)
		return publicRegistrations.get(domain) ?? { registered: false }
	},
	getSitesByDid: async () => [],
	removeSupporter: fail,
	updateCustomDomainRkey: async () => undefined,
	updateCustomDomainVerification: async () => undefined,
	updateDomain: async () => 'updated.wisp.test',
	updateWispDomainSite: async () => undefined,
	waitForSiteCache: async () => true,
	withWebhookOwnerMutationLock: async <T>(_did: string, operation: () => Promise<T>): Promise<T> => await operation(),
}))

mock.module('../lib/cache-invalidation', () => ({
	publishDomainCacheInvalidation: async () => undefined,
}))

mock.module('../lib/dns-verify', () => ({
	verifyCustomDomain: async () => ({ verified: false }),
}))

mock.module('../lib/private-sites-db', () => ({
	hasLivePrivateSite: async (siteId: string): Promise<boolean> => {
		privateLookups.push(siteId)
		if (failPrivateLookup) throw new Error(SENTINEL)
		return liveSiteIds.has(siteId) && !expiredSiteIds.has(siteId)
	},
}))

mock.module('../lib/oauth-authorize', () => ({
	authorizeWisp: fail,
	authorizeWispLegacy: fail,
	isLegacyScopeState: () => false,
	missingGrantedCapabilities: async () => [],
	unmarkLegacyScopeState: () => undefined,
}))

mock.module('./private-redeem', () => ({
	resolvePrivateShareState: async () => null,
}))

mock.module('../lib/slingshot-handle-resolver', () => ({
	SlingshotHandleResolver: class {
		async resolve(_handle: string): Promise<null> {
			return null
		}
	},
}))

const [{ authRoutes }, { domainRoutes }, { secretRoutes }, { siteRoutes }, { webhookRoutes }] = await Promise.all([
	import('./auth'),
	import('./domain'),
	import('./secret'),
	import('./site'),
	import('./webhook'),
])
const domainApp = domainRoutes({} as never, COOKIE_SECRET)

const ask = (domain: string): Promise<Response> =>
	domainApp.handle(new Request(`http://localhost/api/domain/registered?domain=${encodeURIComponent(domain)}`))

const pdsFailureClient = {
	restore: async () => ({
		did: DID,
		fetchHandler: async (): Promise<Response> => {
			throw new Error(SENTINEL)
		},
	}),
}

const signedCookie = async (name: string, value: string): Promise<string> =>
	`${name}=${await signCookie(value, COOKIE_SECRET)}`

const safeJson = async (response: Response): Promise<unknown> => {
	const text = await response.text()
	expect(text).not.toContain(SENTINEL)
	return JSON.parse(text) as unknown
}

beforeEach(() => {
	process.env.PRIVATE_HOST = PRIVATE_HOST
	failPrivateLookup = false
	liveSiteIds.clear()
	expiredSiteIds.clear()
	privateLookups.length = 0
	publicLookups.length = 0
	publicRegistrations.clear()
	secretDatabaseCalls = 0
})

afterAll(() => {
	if (originalPrivateHost === undefined) {
		delete process.env.PRIVATE_HOST
	} else {
		process.env.PRIVATE_HOST = originalPrivateHost
	}
})

describe('public error responses', () => {
	test('keeps OAuth signin failures generic and does not duplicate the error to console', async () => {
		const app = authRoutes({} as never, COOKIE_SECRET)
		const consoleError = spyOn(console, 'error').mockImplementation(() => undefined)

		try {
			const response = await app.handle(
				new Request('http://localhost/api/auth/signin', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ handle: 'alice.example' }),
				}),
			)

			expect(response.status).toBe(401)
			expect(await safeJson(response)).toEqual({
				details: 'Unable to start authentication',
				error: 'Authentication failed',
			})

			const loginResponse = await app.handle(new Request('http://localhost/api/auth/login?login_hint=alice.example'))
			expect(loginResponse.status).toBe(302)
			expect(loginResponse.headers.get('location')).toBe('/?error=auth_failed')
			expect(consoleError).not.toHaveBeenCalled()
		} finally {
			consoleError.mockRestore()
		}
	})

	test('does not expose PDS errors from site routes or write them directly to console', async () => {
		const app = siteRoutes(pdsFailureClient as never, COOKIE_SECRET)
		const cookie = await signedCookie('did', DID)
		const consoleLog = spyOn(console, 'log').mockImplementation(() => undefined)

		try {
			const cases: Array<{ request: Request; error: string }> = [
				{
					request: new Request('http://localhost/api/site/example', {
						headers: { cookie },
						method: 'DELETE',
					}),
					error: 'Failed to delete site',
				},
				{
					request: new Request('http://localhost/api/site/example/settings', { headers: { cookie } }),
					error: 'Failed to fetch settings',
				},
				{
					request: new Request('http://localhost/api/site/example/settings', {
						body: JSON.stringify({ cleanUrls: false, directoryListing: false }),
						headers: { 'Content-Type': 'application/json', cookie },
						method: 'POST',
					}),
					error: 'Failed to save settings',
				},
			]

			for (const { request, error } of cases) {
				const response = await app.handle(request)
				expect(response.status).toBe(500)
				expect(await safeJson(response)).toEqual({ success: false, error })
			}

			expect(consoleLog).not.toHaveBeenCalled()
		} finally {
			consoleLog.mockRestore()
		}
	})

	test('does not expose PDS errors from webhook routes', async () => {
		const app = webhookRoutes(pdsFailureClient as never, COOKIE_SECRET)
		const cookie = await signedCookie('did', DID)
		const cases: Array<{ request: Request; error: string }> = [
			{
				request: new Request('http://localhost/api/webhook', {
					body: JSON.stringify({
						secret: 'test-secret',
						scopeAturi: 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
						url: 'https://receiver.example/webhook',
					}),
					headers: { 'Content-Type': 'application/json', cookie },
					method: 'POST',
				}),
				error: 'Failed to create webhook',
			},
			{
				request: new Request('http://localhost/api/webhook/example', {
					headers: { cookie },
					method: 'DELETE',
				}),
				error: 'Failed to delete webhook',
			},
			{
				request: new Request('http://localhost/api/webhook', { headers: { cookie } }),
				error: 'Failed to list webhooks',
			},
		]

		for (const { request, error } of cases) {
			const response = await app.handle(request)
			expect(response.status).toBe(500)
			expect(await safeJson(response)).toEqual({ success: false, error })
		}
	})

	test('rejects invalid secret IDs before database access with one generic 400 response', async () => {
		const app = secretRoutes(pdsFailureClient as never, COOKIE_SECRET)
		const cookie = await signedCookie('did', DID)
		const invalidNames = ['a'.repeat(65), 'secret-☃', 'secret/name', 'secret%2Fname']

		for (const name of invalidNames) {
			const bodyResponse = await app.handle(
				new Request('http://localhost/api/secret', {
					body: JSON.stringify({ name }),
					headers: { 'Content-Type': 'application/json', cookie },
					method: 'POST',
				}),
			)
			expect(bodyResponse.status).toBe(400)
			expect(await bodyResponse.json()).toEqual({ success: false, error: 'Invalid secret name' })

			const encodedName = encodeURIComponent(name)
			for (const [method, suffix] of [
				['DELETE', ''],
				['POST', '/rotate'],
			] as const) {
				const pathResponse = await app.handle(
					new Request(`http://localhost/api/secret/${encodedName}${suffix}`, { headers: { cookie }, method }),
				)
				expect(pathResponse.status).toBe(400)
				expect(await pathResponse.json()).toEqual({ success: false, error: 'Invalid secret name' })
			}
		}

		const exactBoundary = 'a'.repeat(64)
		const boundaryResponse = await app.handle(
			new Request('http://localhost/api/secret', {
				body: JSON.stringify({ name: exactBoundary }),
				headers: { 'Content-Type': 'application/json', cookie },
				method: 'POST',
			}),
		)
		expect(boundaryResponse.status).toBe(200)
		expect(await boundaryResponse.json()).toMatchObject({ success: true, name: exactBoundary })
		expect(secretDatabaseCalls).toBe(1)
	})
})

describe('Caddy domain registration ask for private sites', () => {
	test('allows a live private site without returning owner, share, or expiry data', async () => {
		liveSiteIds.add(LIVE_SITE_ID)

		const response = await ask(`${LIVE_SITE_ID}.PRIV.WISP.TEST.`)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			domain: `${LIVE_SITE_ID}.${PRIVATE_HOSTNAME}`,
			registered: true,
			type: 'private',
		})
		expect(privateLookups).toEqual([LIVE_SITE_ID])
		expect(publicLookups).toEqual([])
	})

	test('denies expired and missing private sites with the same generic 404 body', async () => {
		liveSiteIds.add(LIVE_SITE_ID)
		expiredSiteIds.add(LIVE_SITE_ID)
		const expiredResponse = await ask(`${LIVE_SITE_ID}.${PRIVATE_HOSTNAME}`)
		expect(expiredResponse.status).toBe(404)
		const expiredBody = await expiredResponse.json()
		expect(expiredBody).toEqual({ registered: false })

		expiredSiteIds.clear()
		liveSiteIds.clear()
		const missingResponse = await ask(`${LIVE_SITE_ID}.${PRIVATE_HOSTNAME}`)
		expect(missingResponse.status).toBe(404)
		expect(await missingResponse.json()).toEqual(expiredBody)
		expect(privateLookups).toEqual([LIVE_SITE_ID, LIVE_SITE_ID])
		expect(publicLookups).toEqual([])
	})

	test('denies malformed, root, and multi-label private hostnames without falling through to public domains', async () => {
		liveSiteIds.add(LIVE_SITE_ID)
		for (const domain of [
			`not-a-site.${PRIVATE_HOSTNAME}`,
			`${LIVE_SITE_ID}.extra.${PRIVATE_HOSTNAME}`,
			PRIVATE_HOSTNAME,
		]) {
			const response = await ask(domain)
			expect(response.status).toBe(404)
			expect(await response.json()).toEqual({ registered: false })
		}
		expect(privateLookups).toEqual([])
		expect(publicLookups).toEqual([])
	})

	test('still uses the existing public-domain registration path outside the private hostname', async () => {
		const publicRegistration = {
			did: 'did:plc:public',
			domain: 'custom.example',
			registered: true,
			rkey: 'site',
			type: 'custom',
			verified: true,
		}
		publicRegistrations.set('custom.example', publicRegistration)

		const response = await ask('custom.example')
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual(publicRegistration)
		expect(privateLookups).toEqual([])
		expect(publicLookups).toEqual(['custom.example'])
	})

	test('keeps a primary lookup failure generic', async () => {
		failPrivateLookup = true

		const response = await ask(`${LIVE_SITE_ID}.${PRIVATE_HOSTNAME}`)
		expect(response.status).toBe(500)
		const text = await response.text()
		expect(text).not.toContain(SENTINEL)
		expect(JSON.parse(text)).toEqual({ error: 'Failed to check domain' })
	})
})
