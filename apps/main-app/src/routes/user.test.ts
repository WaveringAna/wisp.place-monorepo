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

mock.module('../lib/pds-backfill', () => ({
	backfillSitesFromPds: async () => ({ found: 0, queued: 0 }),
}))

mock.module('../lib/db', () => ({
	eventualRead: {
		getDomainsForDid: async () => ({ customDomains: [], wispDomains: [] }),
		getDomainsForSite: async () => [],
		getSitesWithDomainsForDid: async () => [
			{
				created_at: 1,
				did: DID,
				display_name: 'site-a',
				domains: [{ domain: 'site-a.wisp.place', type: 'wisp' }],
				rkey: 'site-a',
				updated_at: 1,
			},
		],
		getSupporterStatus: async () => true,
		getUserStatus: async () => ({ domain: null, sites: [] }),
	},
	getDomainsForDid: async () => ({
		customDomains: [{ id: 'fresh', domain: 'just-added.example' }],
		wispDomains: [],
	}),
	getSitesByDid: async () => [],
	getSitesWithDomainsForDid: async () => [
		{ created_at: 2, did: DID, display_name: 'just-deployed', domains: [], rkey: 'just-deployed', updated_at: 2 },
	],
}))

// The firehose has fenced `just-deployed`; nothing else.
const mgets: string[][] = []
mock.module('../lib/redis', () => ({
	getConnectedRedisClient: async () => ({
		send: async (_command: string, keys: string[]) => {
			mgets.push(keys)
			return keys.map((key) => (key.endsWith('/just-deployed') ? '' : null))
		},
	}),
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

	test('serves each site with its domains so the list view needs one request', async () => {
		const app = userRoutes({} as never, 'test-cookie-secret', async () => new Response('{}'))

		const response = await app.handle(new Request('http://localhost/api/user/sites'))
		expect(response.status).toBe(200)
		expect(await responseJson(response)).toEqual({
			sites: [
				{
					created_at: 1,
					did: DID,
					display_name: 'site-a',
					domains: [{ domain: 'site-a.wisp.place', type: 'wisp' }],
					rkey: 'site-a',
					updated_at: 1,
				},
			],
		})
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

describe('domain list', () => {
	test('reads the primary when asked for a fresh list', async () => {
		const app = userRoutes({} as never, 'test-cookie-secret', async () => new Response('{}'))
		const list = async (path: string) =>
			(await responseJson(await app.handle(new Request(`http://localhost${path}`)))) as { customDomains: unknown[] }
		expect((await list('/api/user/domains')).customDomains).toEqual([])
		expect((await list('/api/user/domains?fresh=1')).customDomains).toEqual([
			{ id: 'fresh', domain: 'just-added.example' },
		])
	})
})

describe('site list', () => {
	test('reads the primary when asked for a fresh list', async () => {
		const app = userRoutes({} as never, 'test-cookie-secret', async () => new Response('{}'))
		const rkeys = async (path: string) =>
			(
				(await responseJson(await app.handle(new Request(`http://localhost${path}`)))) as { sites: { rkey: string }[] }
			).sites.map((site) => site.rkey)
		expect(await rkeys('/api/user/sites')).toEqual(['site-a'])
		expect(await rkeys('/api/user/sites?fresh=1')).toEqual(['just-deployed'])
	})
})

describe('site attention', () => {
	test('flags a fenced site in one MGET, for the eventual and the fresh list', async () => {
		const app = userRoutes({} as never, 'test-cookie-secret', async () => new Response('{}'))
		const flags = async (path: string) =>
			(
				(await responseJson(await app.handle(new Request(`http://localhost${path}`)))) as {
					sites: { rkey: string; needs_attention?: boolean }[]
				}
			).sites.map(({ rkey, needs_attention }) => [rkey, needs_attention ?? false])
		mgets.length = 0
		expect(await flags('/api/user/sites')).toEqual([['site-a', false]])
		expect(await flags('/api/user/sites?fresh=1')).toEqual([['just-deployed', true]])
		expect(mgets).toEqual([
			['wisp:revalidate:quarantine:did%3Aweb%3Aexample.com/site-a'],
			['wisp:revalidate:quarantine:did%3Aweb%3Aexample.com/just-deployed'],
		])
	})
})
