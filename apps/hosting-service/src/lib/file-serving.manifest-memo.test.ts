import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { casKey } from '@wispplace/fs-utils'

// A site manifest is normalized once per cached site row, not once per request. The row object is
// replaced when the lookup entry expires or is invalidated, and the manifest must follow it.

const DID = 'did:plc:test'
const RKEY = 'pr-ab12cd3'

type Entry = { data: Uint8Array; mimeType?: string; sourceCid?: string }
const storageData = new Map<string, Entry>()
const storageReads: string[] = []
const revalidateCalls: Array<{ did: string; rkey: string; reason: string }> = []
const siteRows = new Map<string, Record<string, unknown>>()
let fileObjectReads = 0

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
// The real lookup cache hands back the same row object until the entry expires or is invalidated,
// so this stub does too: manifest memoization is keyed on that identity.
mock.module('./db', () => ({
	getSiteCache: async (did: string, rkey: string) => siteRows.get(`${did}/${rkey}`) ?? null,
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
const { resetHtmlHotCacheWarmupForTests } = await import('./html-prewarm')
const { serveFromCache } = await import('./file-serving')

const CID = (letter: string) => `bafkrei${letter.repeat(52)}`
const key = (cid: string, path: string, mimeType = 'text/html') => casKey({ cid, path, mimeType })
const url = (path: string) => `https://example.com/${path}`

function storeAt(storageKey: string, body: string, cid: string, mimeType = 'text/html') {
	storageData.set(storageKey, { data: new TextEncoder().encode(body), mimeType, sourceCid: cid })
}

// `file_objects` is read once each time a manifest is built from the row, so counting reads counts builds.
function site(rkey: string, fileCids: Record<string, string>, fileObjects: unknown) {
	const row: Record<string, unknown> = {
		did: DID,
		rkey,
		record_cid: 'record-cid',
		cached_at: 0,
		updated_at: 0,
		absent_since: null,
		file_cids: fileCids,
	}
	Object.defineProperty(row, 'file_objects', {
		enumerable: true,
		get: () => {
			fileObjectReads++
			return fileObjects
		},
	})
	siteRows.set(`${DID}/${rkey}`, row)
}

beforeEach(() => {
	storageData.clear()
	storageReads.length = 0
	revalidateCalls.length = 0
	fileObjectReads = 0
	siteRows.clear()
	for (const namespace of ['redirectRules', 'siteCache', 'siteFiles', 'sourceCidMismatches'] as const) {
		cache.clear(namespace)
	}
	resetHtmlHotCacheWarmupForTests()
})

describe('manifest memoization', () => {
	test('normalizes a cached site row once however many requests it serves', async () => {
		const home = key(CID('a'), 'index.html')
		const about = key(CID('b'), 'about.html')
		site(RKEY, { 'index.html': CID('a'), 'about.html': CID('b') }, { 'index.html': home, 'about.html': about })
		storeAt(home, 'home', CID('a'))
		storeAt(about, 'about', CID('b'))

		for (let i = 0; i < 3; i++) {
			expect(await (await serveFromCache(DID, RKEY, 'index.html', url('index.html'))).text()).toBe('home')
			expect(await (await serveFromCache(DID, RKEY, 'about.html', url('about.html'))).text()).toBe('about')
		}

		expect(fileObjectReads).toBe(1)
	})

	test('builds a new manifest when the cached row is replaced', async () => {
		const first = key(CID('a'), 'index.html')
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': first })
		storeAt(first, 'first', CID('a'))
		expect(await (await serveFromCache(DID, RKEY, 'index.html', url('index.html'))).text()).toBe('first')
		expect(fileObjectReads).toBe(1)

		// An update replaces the row (expiry or invalidation); the next request must see the new mapping.
		const second = key(CID('b'), 'index.html')
		site(RKEY, { 'index.html': CID('b') }, { 'index.html': second })
		storeAt(second, 'second', CID('b'))
		expect(await (await serveFromCache(DID, RKEY, 'index.html', url('index.html'))).text()).toBe('second')
		expect(fileObjectReads).toBe(2)
	})

	test('keeps serving a deleted site as an empty manifest', async () => {
		const home = key(CID('a'), 'index.html')
		site(RKEY, { 'index.html': CID('a') }, { 'index.html': home })
		storeAt(home, 'home', CID('a'))
		const row = siteRows.get(`${DID}/${RKEY}`) as Record<string, unknown>
		row.absent_since = 1

		expect((await serveFromCache(DID, RKEY, 'index.html', url('index.html'))).status).toBe(404)
		expect((await serveFromCache(DID, RKEY, 'index.html', url('index.html'))).status).toBe(404)
		expect(fileObjectReads).toBe(0)
	})
})
