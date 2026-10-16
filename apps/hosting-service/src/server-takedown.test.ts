import { describe, expect, test } from 'bun:test'
import { siteSubject } from './lib/moderation'
import { createApp, resolveHostConfig } from './server'

const ALICE = 'did:plc:abcdefghijklmnopqrstuvwx'
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const takenDown = new Set([siteSubject(ALICE, 'shop'), siteSubject(ALICE, 'pr-dead000'), BOB])
const served: string[] = []

const serveSite = async (did: string, rkey: string) => {
	served.push(`${did}/${rkey}`)
	return new Response('site body', { headers: { 'Content-Type': 'text/html' } })
}

const app = createApp({
	hosts: resolveHostConfig({ BASE_HOST: 'wisp.place', PREVIEW_HOST: 'preview.wisp.place' }),
	getWispDomain: async (domain) => {
		if (domain === 'shop.wisp.place') return { did: ALICE, rkey: 'shop' }
		if (domain === 'blog.wisp.place') return { did: ALICE, rkey: 'blog' }
		if (domain === 'alice.wisp.place') return { did: ALICE, rkey: 'blog' }
		if (domain === 'bob.wisp.place') return { did: BOB, rkey: 'home' }
		return null
	},
	getCustomDomain: async (domain) => (domain === 'shop.example.com' ? { did: ALICE, rkey: 'shop' } : null),
	getCustomDomainByHash: async () => null,
	serveFromCache: serveSite,
	serveFromCacheWithRewrite: serveSite,
	isTakenDown: (did, rkey) => takenDown.has(did) || takenDown.has(siteSubject(did, rkey)),
	metrics: { recordHostingResponse: () => {}, recordHostingNotFound: () => {} },
	notFoundLog: { record: () => {} },
})

describe('taken-down sites', () => {
	test.each([
		'https://shop.wisp.place/',
		'https://shop.example.com/index.html',
		`https://sites.wisp.place/${ALICE}/shop/`,
		'https://pr-dead000-alice.preview.wisp.place/',
		'https://bob.wisp.place/anything',
		`https://sites.wisp.place/${BOB}/home/`,
	])('%s answers 451 without reading the site', async (url) => {
		served.length = 0
		const response = await app.request(url)
		expect(response.status).toBe(451)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(await response.text()).toContain('acceptable use policy')
		expect(served).toEqual([])
	})

	test.each([
		['https://blog.wisp.place/', `${ALICE}/blog`],
		['https://pr-ab12cd3-alice.preview.wisp.place/', `${ALICE}/pr-ab12cd3`],
	])('%s, another site of the same account, is still served', async (url, site) => {
		served.length = 0
		const response = await app.request(url)
		expect(response.status).toBe(200)
		expect(served).toEqual([site])
	})

	test('HEAD gets the status without the page', async () => {
		const response = await app.request('https://shop.wisp.place/', { method: 'HEAD' })
		expect(response.status).toBe(451)
		expect(await response.text()).toBe('')
	})
})
