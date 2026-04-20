import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Fake storage shared across tests; reset in beforeEach
type FakeEntry = { data: Uint8Array; mimeType?: string; encoding?: string; checksum?: string }
const storageData = new Map<string, FakeEntry>()

const fakeStorage = {
	async get(key: string) {
		const entry = storageData.get(key)
		return entry?.data ?? null
	},
	async getWithMetadata(key: string) {
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
				checksum: entry.checksum ?? 'test-checksum',
				customMetadata: { mimeType: entry.mimeType, encoding: entry.encoding },
			},
			source: 'cold' as const,
		}
	},
	async *listKeys(_prefix?: string): AsyncGenerator<string> {},
}

const noopTier = {
	async get() {
		return null
	},
	async getWithMetadata() {
		return null
	},
	async set() {},
	async delete() {},
	async deleteMany() {},
	async exists() {
		return false
	},
	async *listKeys() {},
	async getMetadata() {
		return null
	},
	async setMetadata() {},
	async getStats() {
		return { entries: 0, sizeBytes: 0 }
	},
	async clear() {},
}

mock.module('./storage', () => ({
	storage: fakeStorage,
	hotTier: noopTier,
	warmTier: undefined,
	getStorageConfig: () => ({}),
}))
mock.module('./db', () => ({
	getSiteCache: async () => null,
	getSiteSettingsCache: async () => null,
	CACHE_ONLY: true,
}))
mock.module('./utils', () => ({
	getCachedSettings: async () => null,
}))
mock.module('./on-demand-cache', () => ({
	fetchAndCacheSite: async () => false,
}))

const { serveFileInternal } = await import('./file-serving')

const DID = 'did:plc:test'
const RKEY = 'hydrant-docs'

function storeFile(path: string, body: string, mimeType = 'text/html') {
	storageData.set(`${DID}/${RKEY}/${path}`, {
		data: new TextEncoder().encode(body),
		mimeType,
	})
}

describe('serveFileInternal directory-index fallback for extensioned paths', () => {
	beforeEach(() => {
		storageData.clear()
	})

	test('serves index.html when requested path with .md extension is actually a directory', async () => {
		// Astro emits concepts/relay.md/ as a directory containing index.html
		storeFile('concepts/relay.md/index.html', '<html>relay docs</html>')

		const response = await serveFileInternal(DID, RKEY, 'concepts/relay.md')

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toContain('text/html')
		expect(await response.text()).toBe('<html>relay docs</html>')
	})

	test('still serves a direct file when both file and directory-style entry would match', async () => {
		// If the file exists directly, it wins over the directory-index fallback
		storeFile('concepts/relay.md', 'raw markdown', 'text/markdown')

		const response = await serveFileInternal(DID, RKEY, 'concepts/relay.md')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('raw markdown')
	})

	test('returns 404 when neither the file nor an index under it exists', async () => {
		const response = await serveFileInternal(DID, RKEY, 'concepts/missing.md')

		expect(response.status).toBe(404)
	})
})
