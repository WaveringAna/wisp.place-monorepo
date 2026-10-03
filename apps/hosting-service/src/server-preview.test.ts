import { beforeEach, describe, expect, mock, test } from 'bun:test'

process.env.BASE_HOST = 'wisp.place'
process.env.PREVIEW_HOST = 'preview.wisp.place'

const OWNER_DID = 'did:plc:alice'
const domainLookups: string[] = []
const served: Array<{ did: string; rkey: string; path: string }> = []

mock.module('./lib/db', () => ({
	getWispDomain: async (domain: string) => {
		domainLookups.push(domain)
		return domain === 'alice.wisp.place' ? { did: OWNER_DID, rkey: 'main-site' } : null
	},
	getCustomDomain: async () => null,
	getCustomDomainByHash: async () => null,
	getSiteCache: async () => null,
	getSiteSettingsCache: async () => null,
	closeDatabase: async () => {},
}))
mock.module('./lib/file-serving', () => ({
	serveFromCache: async (did: string, rkey: string, path: string) => {
		served.push({ did, rkey, path })
		return new Response('preview body')
	},
	serveFromCacheWithRewrite: async () => new Response('unexpected'),
}))

const { default: app } = await import('./server')

describe('preview host routing', () => {
	beforeEach(() => {
		domainLookups.length = 0
		served.length = 0
	})

	test("serves the pr site from the claim owner, ignoring the claim's mapped site", async () => {
		const response = await app.request('https://pr-ab12cd3-alice.preview.wisp.place/docs/index.html')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('preview body')
		expect(domainLookups).toEqual(['alice.wisp.place'])
		expect(served).toEqual([{ did: OWNER_DID, rkey: 'pr-ab12cd3', path: 'docs/index.html' }])
	})

	test('404s an unregistered claim', async () => {
		const response = await app.request('https://pr-ab12cd3-nobody.preview.wisp.place/')

		expect(response.status).toBe(404)
		expect(served).toEqual([])
	})

	test.each([
		'https://preview.wisp.place/',
		'https://main-alice.preview.wisp.place/',
		'https://x.pr-ab12cd3-alice.preview.wisp.place/',
	])('404s %s without a database lookup', async (url) => {
		const response = await app.request(url)

		expect(response.status).toBe(404)
		expect(domainLookups).toEqual([])
		expect(served).toEqual([])
	})
})
