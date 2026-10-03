import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { casKey } from '@wispplace/fs-utils'

// Site files are read from the CAS key that the site's `file_objects` maps. A path with no mapping has
// no stored body: that is a repair request, never a read of {did}/{rkey}/{path}. Only per-site
// pre-rewritten HTML (.rewritten/) keeps its per-site key. See CAS_STORAGE.md.

const DID = 'did:plc:test'
const RKEY = 'pr-ab12cd3'
const OTHER_RKEY = 'pr-9e0f451'

type Entry = { data: Uint8Array; mimeType?: string; sourceCid?: string }
const storageData = new Map<string, Entry>()
const storageReads: string[] = []
const revalidateCalls: Array<{ did: string; rkey: string; reason: string }> = []
const siteRows = new Map<string, { file_cids: Record<string, string>; file_objects?: unknown }>()

class TestStorageUnavailableError extends Error {}

const fakeStorage = {
	async get(key: string) {
		storageReads.push(key)
		return storageData.get(key)?.data ?? null
	},
	async getWithMetadata(key: string) {
		storageReads.push(key)
		const entry = storageData.get(key)
		if (!entry) return null
		return {
			data: entry.data,
			metadata: {
				key,
				size: entry.data.length,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				checksum: 'test-checksum',
				customMetadata: { sourceCid: entry.sourceCid, mimeType: entry.mimeType },
			},
			source: 'cold' as const,
		}
	},
	async *listKeys(_prefix?: string): AsyncGenerator<string> {},
}

mock.module('./storage', () => ({
	storage: fakeStorage,
	hotTier: undefined,
	warmTier: undefined,
	StorageUnavailableError: TestStorageUnavailableError,
	isStorageUnavailableError: (error: unknown) => error instanceof TestStorageUnavailableError,
	addPublicSourceCidIfChecksumMatches: async () => true,
	evictPublicCacheKey: async () => {},
	getStorageConfig: () => ({}),
}))
mock.module('./db', () => ({
	getSiteCache: async (did: string, rkey: string) => {
		const row = siteRows.get(`${did}/${rkey}`)
		return row ? { did, rkey, record_cid: 'record-cid', cached_at: 0, updated_at: 0, absent_since: null, ...row } : null
	},
	getSiteSettingsCache: async () => null,
}))
mock.module('./utils', () => ({ getCachedSettings: async () => null }))
mock.module('./revalidate-metrics', () => ({ recordStorageMiss: () => {} }))
mock.module('./revalidate-queue', () => ({
	enqueueRevalidate: async (did: string, rkey: string, reason: string) => {
		revalidateCalls.push({ did, rkey, reason })
		return { enqueued: true, result: 'enqueued' as const }
	},
}))

const { cache } = await import('./cache-manager')
const { resetHtmlHotCacheWarmupForTests, waitForSiteHtmlHotCacheWarmupForTests } = await import('./html-prewarm')
const { serveFromCache, serveFromCacheWithRewrite } = await import('./file-serving')

const CID = (letter: string) => `bafkrei${letter.repeat(52)}`
const key = (cid: string, path: string, mimeType = 'text/html') => casKey({ cid, path, mimeType })
const url = (path: string) => `https://example.com/${path}`

function storeAt(storageKey: string, body: string, cid: string, mimeType = 'text/html') {
	storageData.set(storageKey, { data: new TextEncoder().encode(body), mimeType, sourceCid: cid })
}

function site(rkey: string, fileCids: Record<string, string>, fileObjects?: unknown) {
	siteRows.set(`${DID}/${rkey}`, {
		file_cids: fileCids,
		...(fileObjects === undefined ? {} : { file_objects: fileObjects }),
	})
}

const legacyKey = (path: string, rkey = RKEY) => `${DID}/${rkey}/${path}`

beforeEach(() => {
	storageData.clear()
	storageReads.length = 0
	revalidateCalls.length = 0
	siteRows.clear()
	for (const namespace of ['redirectRules', 'siteCache', 'siteFiles', 'sourceCidMismatches'] as const) {
		cache.clear(namespace)
	}
	resetHtmlHotCacheWarmupForTests()
})

describe('CAS reads', () => {
	test('serves a mapped path from its CAS key and never reads the legacy key', async () => {
		const objectKey = key(CID('a'), 'index.html')
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': objectKey })
		storeAt(objectKey, '<h1>from cas</h1>', CID('a'))

		const response = await serveFromCache(DID, RKEY, 'index.html', url('index.html'))

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('<h1>from cas</h1>')
		expect(response.headers.get('Content-Type')).toContain('text/html')
		expect(storageReads).toContain(objectKey)
		expect(storageReads).not.toContain(legacyKey('index.html'))
	})

	test('takes the Content-Type from the CAS object, not from the path', async () => {
		const objectKey = key(CID('a'), 'data.txt', 'application/json')
		site(RKEY, { 'data.txt': CID('a') }, { 'data.txt': objectKey })
		storeAt(objectKey, '{"ok":true}', CID('a'), 'application/json')

		const response = await serveFromCache(DID, RKEY, 'data.txt', url('data.txt'))

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toContain('application/json')
	})

	test('a site with no file_objects has no stored bodies: repair is requested, no key is guessed', async () => {
		site(RKEY, { 'index.html': CID('a') })
		storeAt(legacyKey('index.html'), '<h1>old layout</h1>', CID('a'))

		const response = await serveFromCache(DID, RKEY, 'index.html', url('index.html'))

		expect(response.status).toBe(503)
		expect(await response.text()).not.toContain('old layout')
		expect(revalidateCalls.some((call) => call.rkey === RKEY && call.reason.startsWith('storage-miss'))).toBe(true)
		expect(storageReads).not.toContain(legacyKey('index.html'))
	})

	test('a path missing from the mapping is a miss even when its legacy object exists', async () => {
		const objectKey = key(CID('a'), 'index.html')
		site(RKEY, { 'index.html': CID('a'), 'about.html': CID('b') }, { 'index.html': objectKey })
		storeAt(objectKey, 'home', CID('a'))
		storeAt(legacyKey('about.html'), 'about (legacy)', CID('b'))

		expect(await (await serveFromCache(DID, RKEY, 'index.html', url('index.html'))).text()).toBe('home')
		const about = await serveFromCache(DID, RKEY, 'about.html', url('about.html'))
		expect(about.status).toBe(503)
		expect(storageReads).not.toContain(legacyKey('about.html'))
	})

	test('two sites that share one CAS object both serve it', async () => {
		const objectKey = key(CID('a'), 'index.html')
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': objectKey })
		site(OTHER_RKEY, { 'index.html': CID('a') }, { 'index.html': objectKey })
		storeAt(objectKey, 'shared body', CID('a'))

		for (const rkey of [RKEY, OTHER_RKEY]) {
			const response = await serveFromCache(DID, rkey, 'index.html', url('index.html'))
			expect(await response.text()).toBe('shared body')
		}
	})

	test('a missing CAS body is a storage miss that requests repair, not a 200 or a legacy read', async () => {
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': key(CID('a'), 'index.html') })

		const response = await serveFromCache(DID, RKEY, 'index.html', url('index.html'))

		expect(response.status).toBe(503)
		expect(revalidateCalls.some((call) => call.rkey === RKEY && call.reason.startsWith('storage-miss'))).toBe(true)
		expect(storageReads).not.toContain(legacyKey('index.html'))
	})

	test('refuses a CAS object whose source CID is not the one the manifest expects', async () => {
		const objectKey = key(CID('a'), 'index.html')
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': objectKey })
		storeAt(objectKey, 'poisoned', CID('z'))

		const response = await serveFromCache(DID, RKEY, 'index.html', url('index.html'))

		expect(response.status).not.toBe(200)
		expect(await response.text()).not.toContain('poisoned')
	})

	test('ignores a mapping that points outside CAS, so a read cannot be steered at another site', async () => {
		const victim = `${DID}/${OTHER_RKEY}/index.html`
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': victim })
		storeAt(victim, 'other site content', CID('a'))

		const response = await serveFromCache(DID, RKEY, 'index.html', url('index.html'))

		expect(response.status).toBe(503)
		expect(await response.text()).not.toContain('other site content')
		expect(storageReads).not.toContain(victim)
	})

	test('treats an unparseable mapping as no mapping', async () => {
		site(RKEY, { 'index.html': CID('a') }, '{not json')
		storeAt(legacyKey('index.html'), 'legacy', CID('a'))

		expect((await serveFromCache(DID, RKEY, 'index.html', url('index.html'))).status).toBe(503)
	})

	test('does not let a path named like an object property reach the prototype', async () => {
		site(RKEY, { 'index.html': CID('a'), constructor: CID('c') }, { 'index.html': key(CID('a'), 'index.html') })
		storeAt(key(CID('a'), 'index.html'), 'home', CID('a'))

		const response = await serveFromCache(DID, RKEY, 'constructor', url('constructor'))

		expect(response.status).toBe(503)
	})

	test('_redirects of a CAS site is read from its CAS object', async () => {
		const redirectsKey = key(CID('r'), '_redirects', 'text/plain')
		site(
			RKEY,
			{ _redirects: CID('r'), 'new.html': CID('n') },
			{ _redirects: redirectsKey, 'new.html': key(CID('n'), 'new.html') },
		)
		storeAt(redirectsKey, '/old /new.html 301', CID('r'), 'text/plain')

		const response = await serveFromCache(DID, RKEY, 'old', url('old'))

		expect(response.status).toBe(301)
		expect(response.headers.get('Location')).toBe('/new.html')
		expect(storageReads).not.toContain(legacyKey('_redirects'))
	})

	test('pre-rewritten HTML stays per site while the original body comes from CAS', async () => {
		const objectKey = key(CID('a'), 'index.html')
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': objectKey })
		storeAt(objectKey, '<a href="/x">original</a>', CID('a'))
		storeAt(legacyKey('.rewritten/index.html'), '<a href="/did/site/x">rewritten</a>', CID('a'))

		const response = await serveFromCacheWithRewrite(DID, RKEY, 'index.html', `/${DID}/${RKEY}/`, url('index.html'))

		expect(await response.text()).toContain('rewritten')
		expect(storageReads).toContain(legacyKey('.rewritten/index.html'))
	})

	test('HTML prewarm warms the CAS keys of a CAS site, not legacy keys', async () => {
		const objectKey = key(CID('a'), 'index.html')
		const styleKey = key(CID('s'), 'style.css', 'text/css')
		site(RKEY, { 'index.html': CID('a'), 'style.css': CID('s') }, { 'index.html': objectKey, 'style.css': styleKey })
		storeAt(objectKey, 'home', CID('a'))
		storeAt(styleKey, 'body{}', CID('s'), 'text/css')

		await serveFromCache(DID, RKEY, 'style.css', url('style.css'))
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)

		expect(storageReads).toContain(objectKey)
		expect(storageReads).not.toContain(legacyKey('index.html'))
	})

	test('unconverted site with null file_objects triggers 503 repair, then serves 200 from CAS once repaired', async () => {
		site(RKEY, { 'index.html': CID('a') })

		const missResponse = await serveFromCache(DID, RKEY, 'index.html', url('index.html'))
		expect(missResponse.status).toBe(503)
		expect(missResponse.headers.get('Retry-After')).toBe('5')
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:index.html' }])

		// Repair simulates firehose-service downloading blob, storing CAS object, and updating site_cache
		const objectKey = key(CID('a'), 'index.html')
		storeAt(objectKey, '<h1>repaired from pds</h1>', CID('a'))
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': objectKey })
		cache.clear('siteCache')
		cache.clear('siteFiles')

		const repairedResponse = await serveFromCache(DID, RKEY, 'index.html', url('index.html'))
		expect(repairedResponse.status).toBe(200)
		expect(await repairedResponse.text()).toBe('<h1>repaired from pds</h1>')
		expect(storageReads).toContain(objectKey)
		expect(storageReads).not.toContain(legacyKey('index.html'))
	})

	test('missing CAS object triggers 503 repair, then serves 200 once body is materialized', async () => {
		const objectKey = key(CID('a'), 'index.html')
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': objectKey })

		const missResponse = await serveFromCache(DID, RKEY, 'index.html', url('index.html'))
		expect(missResponse.status).toBe(503)
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:index.html' }])

		// Worker materializes the missing body to its CAS key
		storeAt(objectKey, '<h1>materialized</h1>', CID('a'))
		cache.clear('siteFiles')

		const okResponse = await serveFromCache(DID, RKEY, 'index.html', url('index.html'))
		expect(okResponse.status).toBe(200)
		expect(await okResponse.text()).toBe('<h1>materialized</h1>')
	})
})
