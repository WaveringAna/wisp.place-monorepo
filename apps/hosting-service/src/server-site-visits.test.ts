import { describe, expect, test } from 'bun:test'
import { createApp, resolveHostConfig } from './server'

const ALICE = 'did:plc:abcdefghijklmnopqrstuvwx'
const visits: string[] = []

const app = createApp({
	hosts: resolveHostConfig({ BASE_HOST: 'wisp.place', PREVIEW_HOST: 'preview.wisp.place' }),
	getWispDomain: async (domain) =>
		domain === 'blog.wisp.place' || domain === 'alice.wisp.place' ? { did: ALICE, rkey: 'blog' } : null,
	getCustomDomain: async (domain) => (domain === 'blog.example.com' ? { did: ALICE, rkey: 'blog' } : null),
	getCustomDomainByHash: async () => null,
	serveFromCache: async (_did, _rkey, path) =>
		new Response(path.includes('missing') ? 'nope' : 'page', { status: path.includes('missing') ? 404 : 200 }),
	serveFromCacheWithRewrite: async () => new Response('page'),
	isTakenDown: () => false,
	recordSiteVisit: (did, rkey) => visits.push(`${did}/${rkey}`),
	metrics: { recordHostingResponse: () => {}, recordHostingNotFound: () => {} },
	notFoundLog: { record: () => {} },
})

describe('site visits', () => {
	test.each([
		'https://blog.wisp.place/',
		'https://blog.example.com/about',
		`https://sites.wisp.place/${ALICE}/blog/`,
		'https://pr-ab12cd3-alice.preview.wisp.place/',
	])('a page served for %s counts as a visit to its site', async (url) => {
		visits.length = 0
		expect((await app.request(url)).status).toBe(200)
		expect(visits).toHaveLength(1)
	})

	test('a missing path, a HEAD, or an unmapped host does not', async () => {
		visits.length = 0
		await app.request('https://blog.wisp.place/missing')
		await app.request('https://blog.wisp.place/', { method: 'HEAD' })
		await app.request('https://nobody.wisp.place/')
		expect(visits).toEqual([])
	})
})
