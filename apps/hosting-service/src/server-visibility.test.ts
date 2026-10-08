import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { type HostingNotFoundReason, type HostingResponseEntry, metricsCollector } from '@wispplace/observability'
import { markRedirectNotFound } from './lib/request-visibility'

process.env.BASE_HOST = 'wisp.place'
process.env.PREVIEW_HOST = 'preview.wisp.place'

const OWNER_DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const SITE_BODIES: Record<string, () => Response> = {
	'index.html': () => new Response('<h1>hi</h1>', { headers: { 'Content-Type': 'text/html', 'X-Cache-Tier': 'hot' } }),
	'app.js': () => new Response('x', { headers: { 'Content-Type': 'text/javascript', 'X-Cache-Tier': 'cold' } }),
	gone: () => markRedirectNotFound(new Response('gone', { status: 404, headers: { 'Content-Type': 'text/html' } })),
}

mock.module('./lib/db', () => ({
	getWispDomain: async (domain: string) => {
		if (domain === 'alice.wisp.place') return { did: OWNER_DID, rkey: 'blog' }
		if (domain === 'idle.wisp.place') return { did: OWNER_DID, rkey: null }
		return null
	},
	getCustomDomain: async (domain: string) =>
		domain === 'blog.example.com' ? { id: 'h', domain, did: OWNER_DID, rkey: 'blog', verified: true } : null,
	getCustomDomainByHash: async () => null,
	getSiteCache: async () => null,
	getSiteSettingsCache: async () => null,
	closeDatabase: async () => {},
}))
const serveSite = async (_did: string, _rkey: string, path: string) =>
	SITE_BODIES[path]?.() ?? new Response('missing', { status: 404, headers: { 'Content-Type': 'text/html' } })
mock.module('./lib/file-serving', () => ({
	serveFromCache: serveSite,
	serveFromCacheWithRewrite: serveSite,
}))

const notFoundLines: Array<{ reason: HostingNotFoundReason; host: string }> = []
mock.module('./lib/not-found-log', () => ({
	notFoundLog: { record: (reason: HostingNotFoundReason, host: string) => notFoundLines.push({ reason, host }) },
}))

const responses: HostingResponseEntry[] = []
const reasons: HostingNotFoundReason[] = []
spyOn(metricsCollector, 'recordHostingResponse').mockImplementation((entry) => {
	responses.push(entry)
})
spyOn(metricsCollector, 'recordHostingNotFound').mockImplementation((reason) => {
	reasons.push(reason)
})

const { default: app } = await import('./server')

beforeEach(() => {
	responses.length = 0
	reasons.length = 0
	notFoundLines.length = 0
})

async function notFoundFor(url: string, init?: RequestInit) {
	const response = await app.request(url, init)
	expect(response.status).toBe(404)
	return notFoundLines[notFoundLines.length - 1]
}

describe('hosting 404 reasons', () => {
	test.each([
		['https://dead.example.com/', 'unknown-custom-domain', 'dead.example.com'],
		['https://0123456789abcdef.dns.wisp.place/', 'unknown-custom-domain', '0123456789abcdef.dns.wisp.place'],
		['https://nobody.wisp.place/', 'unregistered-subdomain', 'nobody.wisp.place'],
		['https://idle.wisp.place/', 'unmapped-domain', 'idle.wisp.place'],
		['https://pr-ab12cd3-nobody.preview.wisp.place/', 'preview-not-found', 'pr-ab12cd3-nobody.preview.wisp.place'],
		['https://main-alice.preview.wisp.place/', 'preview-not-found', 'main-alice.preview.wisp.place'],
		['https://priv.wisp.place/', 'private-not-found', 'priv.wisp.place'],
		['https://alice.wisp.place/missing.css?token=secret', 'file-not-found', 'alice.wisp.place'],
		['https://blog.example.com/gone', 'redirect-404', 'blog.example.com'],
		[`https://sites.wisp.place/${OWNER_DID}/blog/missing`, 'file-not-found', `sites.wisp.place/${OWNER_DID}/blog`],
	] as const)('%s is %s', async (url, reason, host) => {
		expect(await notFoundFor(url)).toEqual({ reason, host })
		expect(reasons).toEqual([reason])
	})

	test('an unrouted method is other', async () => {
		expect(await notFoundFor('https://alice.wisp.place/', { method: 'POST' })).toEqual({
			reason: 'other',
			host: 'alice.wisp.place',
		})
	})

	test('a served page is not a 404', async () => {
		const response = await app.request('https://alice.wisp.place/index.html')
		expect(response.status).toBe(200)
		expect(reasons).toEqual([])
		expect(notFoundLines).toEqual([])
	})
})

describe('hosting response time labels', () => {
	test.each([
		['https://alice.wisp.place/index.html', { tier: 'hot', statusClass: '2xx', kind: 'html' }],
		['https://blog.example.com/app.js', { tier: 'cold', statusClass: '2xx', kind: 'asset' }],
		['https://alice.wisp.place/missing.css', { tier: 'none', statusClass: '404', kind: 'html' }],
		['https://dead.example.com/', { tier: 'none', statusClass: '404', kind: 'other' }],
		[`https://sites.wisp.place/${OWNER_DID}/blog`, { tier: 'none', statusClass: '3xx', kind: 'other' }],
		['https://wisp.place/%2e%2e%2fsecret', { tier: 'none', statusClass: '4xx', kind: 'other' }],
	] as const)('%s', async (url, labels) => {
		await app.request(url)
		expect(responses).toHaveLength(1)
		const [{ durationMs, ...rest }] = responses as [HostingResponseEntry]
		expect(rest).toEqual(labels)
		expect(durationMs).toBeGreaterThanOrEqual(0)
	})

	test('health probes are not timed', async () => {
		await app.request('https://wisp.place/health')
		await app.request('https://wisp.place/live')
		expect(responses).toEqual([])
	})
})

describe('hosting metric cardinality', () => {
	test('10k distinct hosts and paths reach the metrics as a constant set of label values', async () => {
		// Hosting logs each request at debug outside production; 20k lines would bury the report.
		const quiet = spyOn(console, 'log').mockImplementation(() => {})
		try {
			for (let i = 0; i < 10_000; i++) {
				await app.request(`https://scanner-${i}.example.net/wp-login-${i}.php?i=${i}`)
				await app.request(`https://alice.wisp.place/missing-${i}.css`)
			}
			await app.request('https://alice.wisp.place/index.html')
		} finally {
			quiet.mockRestore()
		}

		const labelSets = new Set(responses.map(({ durationMs: _, ...labels }) => JSON.stringify(labels)))
		expect([...labelSets]).toEqual([
			JSON.stringify({ tier: 'none', statusClass: '404', kind: 'other' }),
			JSON.stringify({ tier: 'none', statusClass: '404', kind: 'html' }),
			JSON.stringify({ tier: 'hot', statusClass: '2xx', kind: 'html' }),
		])
		expect(new Set(reasons)).toEqual(new Set(['unknown-custom-domain', 'file-not-found']))
		expect(responses).toHaveLength(20_001)
	}, 60_000)
})
