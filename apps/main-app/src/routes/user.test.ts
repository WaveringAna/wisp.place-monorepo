import { describe, expect, mock, test } from 'bun:test'

const DID = 'did:web:example.com'
const logs: Array<{ level: string; message: string; extra?: unknown }> = []

mock.module('@wispplace/observability', () => ({
	createLogger: () => ({
		debug: (message: string, extra?: unknown) => logs.push({ level: 'debug', message, extra }),
		error: (message: string, extra?: unknown) => logs.push({ level: 'error', message, extra }),
		info: (message: string, extra?: unknown) => logs.push({ level: 'info', message, extra }),
		warn: (message: string, extra?: unknown) => logs.push({ level: 'warn', message, extra }),
	}),
}))

mock.module('../lib/db', () => ({
	eventualRead: {
		getDomainsForDid: async () => ({ customDomains: [], wispDomains: [] }),
		getDomainsForSite: async () => [],
		getSitesForDid: async () => [],
		getSupporterStatus: async () => true,
		getUserStatus: async () => ({ domain: null, sites: [] }),
	},
	getSitesByDid: async () => [],
}))

mock.module('../lib/wisp-auth', () => ({
	SESSION_COOKIE_NAME: 'did',
	authenticateRequest: async () => ({ did: DID, session: {} }),
	requireAuth: async () => ({ did: DID, session: {} }),
}))

const { userRoutes } = await import('./user')

const responseJson = async (response: Response): Promise<unknown> => response.json()

describe('user identity lookup transport', () => {
	test('uses the supplied identity fetcher rather than global fetch for /info', async () => {
		const requests: string[] = []
		const app = userRoutes({} as never, 'test-cookie-secret', async (url) => {
			requests.push(url)
			return new Response(JSON.stringify({ alsoKnownAs: ['at://alice.example'] }))
		})

		const response = await app.handle(new Request('http://localhost/api/user/info'))
		expect(response.status).toBe(200)
		expect(await responseJson(response)).toEqual({ did: DID, handle: 'alice.example', isSupporter: true })
		expect(requests).toEqual(['https://example.com/.well-known/did.json'])
	})

	test('returns an unknown handle without logging a raw identity error', async () => {
		logs.length = 0
		const app = userRoutes({} as never, 'test-cookie-secret', async () => {
			throw new Error('https://token:secret@private.example')
		})

		const response = await app.handle(new Request('http://localhost/api/user/info'))
		expect(await responseJson(response)).toEqual({ did: DID, handle: 'unknown', isSupporter: true })
		expect(logs.some((entry) => JSON.stringify(entry).includes('token:secret'))).toBe(false)
		expect(logs.some((entry) => entry.level === 'error')).toBe(false)
	})
})
