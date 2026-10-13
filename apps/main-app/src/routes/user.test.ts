import { afterEach, describe, expect, test } from 'bun:test'
import { signCookie } from 'elysia/utils'
import { logsDuring } from '../lib/collected-logs'
import { clearSessionCache, SESSION_COOKIE_NAME } from '../lib/wisp-auth'
import { createUserRoutes } from './user'

const DID = 'did:web:example.com'
const COOKIE_SECRET = 'test-cookie-secret'
// The OAuth client is the boundary: requireAuth restores this DID's session from it.
const client = { restore: async (did: string) => ({ did }) }
const cookie = `${SESSION_COOKIE_NAME}=${await signCookie(DID, COOKIE_SECRET)}`

afterEach(() => {
	clearSessionCache()
})

// The firehose has fenced `just-deployed`; nothing else.
const mgets: string[][] = []
const userRoutes = createUserRoutes({
	eventualRead: {
		getDomainsForDid: async () => ({ customDomains: [], wispDomains: [] }),
		getDomainsForSite: async () => [],
		getSitesWithDomainsForDid: async () => [
			{
				created_at: 1,
				did: DID,
				display_name: 'site-a',
				domains: [{ domain: 'site-a.wisp.place', type: 'wisp' }],
				record_cid: 'bafy-site-a',
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
	getSitesWithDomainsForDid: async () => [
		{
			created_at: 2,
			did: DID,
			display_name: 'just-deployed',
			domains: [],
			record_cid: 'bafy-just-deployed',
			rkey: 'just-deployed',
			updated_at: 2,
		},
	],
	backfillSitesFromPds: async () => ({ found: 0, queued: 0 }),
	connectSiteFenceReader: async () => ({
		send: async (_command: string, keys: string[]) => {
			mgets.push(keys)
			return keys.map((key) => (key.endsWith('/just-deployed') ? '' : null))
		},
	}),
})

const signedIn = (path: string): Request => new Request(`http://localhost${path}`, { headers: { cookie } })

const responseJson = async (response: Response): Promise<unknown> => response.json()

describe('user identity lookup transport', () => {
	test('uses the supplied identity fetcher rather than global fetch for /info', async () => {
		const requests: string[] = []
		const app = userRoutes(client as never, COOKIE_SECRET, async (url) => {
			requests.push(url)
			return new Response(JSON.stringify({ alsoKnownAs: ['at://alice.example'] }))
		})

		const response = await app.handle(signedIn('/api/user/info'))
		expect(response.status).toBe(200)
		expect(await responseJson(response)).toEqual({ did: DID, handle: 'alice.example', isSupporter: true })
		expect(requests).toEqual(['https://example.com/.well-known/did.json'])
	})

	test('serves each site with its domains so the list view needs one request', async () => {
		const app = userRoutes(client as never, COOKIE_SECRET, async () => new Response('{}'))

		const response = await app.handle(signedIn('/api/user/sites'))
		expect(response.status).toBe(200)
		expect(await responseJson(response)).toEqual({
			sites: [
				{
					created_at: 1,
					did: DID,
					display_name: 'site-a',
					domains: [{ domain: 'site-a.wisp.place', type: 'wisp' }],
					record_cid: 'bafy-site-a',
					rkey: 'site-a',
					updated_at: 1,
				},
			],
		})
	})

	test('returns an unknown handle without logging a raw identity error', async () => {
		const app = userRoutes(client as never, COOKIE_SECRET, async () => {
			throw new Error('https://token:secret@private.example')
		})

		const logs = await logsDuring('main-app', async () => {
			const response = await app.handle(signedIn('/api/user/info'))
			expect(await responseJson(response)).toEqual({ did: DID, handle: 'unknown', isSupporter: true })
		})
		expect(logs.map((entry) => entry.message)).toContain('[User] Returning info')
		expect(logs.some((entry) => JSON.stringify(entry).includes('token:secret'))).toBe(false)
		expect(logs.some((entry) => entry.level === 'error')).toBe(false)
	})
})

describe('domain list', () => {
	test('reads the primary when asked for a fresh list', async () => {
		const app = userRoutes(client as never, COOKIE_SECRET, async () => new Response('{}'))
		const list = async (path: string) =>
			(await responseJson(await app.handle(signedIn(path)))) as { customDomains: unknown[] }
		expect((await list('/api/user/domains')).customDomains).toEqual([])
		expect((await list('/api/user/domains?fresh=1')).customDomains).toEqual([
			{ id: 'fresh', domain: 'just-added.example' },
		])
	})
})

describe('site list', () => {
	test('reads the primary when asked for a fresh list', async () => {
		const app = userRoutes(client as never, COOKIE_SECRET, async () => new Response('{}'))
		const rkeys = async (path: string) =>
			((await responseJson(await app.handle(signedIn(path)))) as { sites: { rkey: string }[] }).sites.map(
				(site) => site.rkey,
			)
		expect(await rkeys('/api/user/sites')).toEqual(['site-a'])
		expect(await rkeys('/api/user/sites?fresh=1')).toEqual(['just-deployed'])
	})
})

describe('site attention', () => {
	test('flags a fenced site in one MGET, for the eventual and the fresh list', async () => {
		const app = userRoutes(client as never, COOKIE_SECRET, async () => new Response('{}'))
		const flags = async (path: string) =>
			(
				(await responseJson(await app.handle(signedIn(path)))) as {
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
