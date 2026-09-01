import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { gunzipSync, gzipSync } from 'node:zlib'
import { computeCID } from '@wispplace/atproto-utils'
import { MAX_BLOB_SIZE } from '@wispplace/constants'

const previousGzipProcessingConcurrency = process.env.HOSTING_GZIP_PROCESSING_CONCURRENCY
process.env.HOSTING_GZIP_PROCESSING_CONCURRENCY = '2'

// Fake storage shared across tests; reset in beforeEach
type FakeEntry = {
	data: Uint8Array
	mimeType?: string
	encoding?: string
	checksum?: string
	customMetadata?: Record<string, string>
	source?: 'hot' | 'warm' | 'cold'
	useManifestSourceCid?: boolean
	metadataSize?: number
}
class TestStorageUnavailableError extends Error {
	constructor(
		readonly operation = 'getWithMetadata',
		readonly kind = 'timeout',
	) {
		super('Storage temporarily unavailable')
		this.name = 'StorageUnavailableError'
	}
}

function isTestStorageUnavailableError(error: unknown): error is TestStorageUnavailableError {
	return error instanceof TestStorageUnavailableError
}

type FakeReadOutcome = FakeEntry | null | Error

const storageData = new Map<string, FakeEntry>()
const storageReadSequences = new Map<string, FakeReadOutcome[]>()
const storageGetFailures = new Map<string, Error>()
const storageGetKeys: string[] = []
const storageGetWithMetadataKeys: string[] = []
const evictedPublicCacheKeys: string[] = []
const revalidateCalls: Array<{ did: string; rkey: string; reason: string }> = []
const recordedStorageMisses: string[] = []
let evictPublicCacheKeyFailure: Error | null = null
let evictPublicCacheKeyGate: Promise<void> | null = null
let evictPublicCacheKeyStarted: (() => void) | null = null
let legacyMetadataHealResult: boolean | Error = true
const legacyMetadataHealCalls: Array<{ key: string; checksum: string; sourceCid: string }> = []
let siteFileCids: Record<string, string> | null = null
let gatedStorageReadKey: string | null = null
let gatedStorageReadStarted: (() => void) | null = null
let gatedStorageReadGate: Promise<void> | null = null

class TestDecompressionLimitError extends Error {
	constructor() {
		super('Decompressed data exceeds the test limit')
		this.name = 'DecompressionLimitError'
	}
}

const gzipWorkState = {
	active: 0,
	compressCalls: 0,
	decompressCalls: 0,
	forceDecompressLimitError: false,
	forceMeasureLimitError: false,
	holdWork: false,
	maxActive: 0,
	measureCalls: 0,
	waiters: [] as Array<() => void>,
	activeThreshold: null as { count: number; resolve: () => void } | null,
}

function resetGzipWorkState() {
	gzipWorkState.active = 0
	gzipWorkState.compressCalls = 0
	gzipWorkState.decompressCalls = 0
	gzipWorkState.forceDecompressLimitError = false
	gzipWorkState.forceMeasureLimitError = false
	gzipWorkState.holdWork = false
	gzipWorkState.maxActive = 0
	gzipWorkState.measureCalls = 0
	gzipWorkState.waiters.length = 0
	gzipWorkState.activeThreshold = null
}

function waitForGzipWorkActive(count: number): Promise<void> {
	if (gzipWorkState.active >= count) return Promise.resolve()
	return new Promise<void>((resolve) => {
		gzipWorkState.activeThreshold = { count, resolve }
	})
}

function releaseHeldGzipWork() {
	gzipWorkState.holdWork = false
	for (const resolve of gzipWorkState.waiters.splice(0)) resolve()
}

async function runFakeGzipWork<T>(work: () => T): Promise<T> {
	gzipWorkState.active++
	gzipWorkState.maxActive = Math.max(gzipWorkState.maxActive, gzipWorkState.active)
	if (gzipWorkState.activeThreshold && gzipWorkState.active >= gzipWorkState.activeThreshold.count) {
		gzipWorkState.activeThreshold.resolve()
		gzipWorkState.activeThreshold = null
	}

	try {
		if (gzipWorkState.holdWork) {
			await new Promise<void>((resolve) => gzipWorkState.waiters.push(resolve))
		}
		return work()
	} finally {
		gzipWorkState.active--
	}
}

function isTestGzip(data: Uint8Array): boolean {
	return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b
}

const fakeStorage = {
	async get(key: string) {
		storageGetKeys.push(key)
		const failure = storageGetFailures.get(key)
		if (failure) throw failure
		const entry = storageData.get(key)
		return entry?.data ?? null
	},
	async getWithMetadata(key: string) {
		storageGetWithMetadataKeys.push(key)
		if (key === gatedStorageReadKey && gatedStorageReadGate) {
			gatedStorageReadStarted?.()
			gatedStorageReadStarted = null
			await gatedStorageReadGate
		}
		const sequence = storageReadSequences.get(key)
		const entry = sequence && sequence.length > 0 ? sequence.shift() : storageData.get(key)
		if (entry instanceof Error) throw entry
		if (!entry) return null

		const relativePath = key.slice(`${DID}/${RKEY}/`.length)
		const sourcePath = relativePath.startsWith('.rewritten/') ? relativePath.slice('.rewritten/'.length) : relativePath
		const manifestSourceCid = entry.useManifestSourceCid === false ? undefined : siteFileCids?.[sourcePath]
		return {
			data: entry.data,
			metadata: {
				key,
				size: entry.metadataSize ?? entry.data.length,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				checksum: entry.checksum ?? 'test-checksum',
				customMetadata: {
					...(manifestSourceCid ? { sourceCid: manifestSourceCid } : {}),
					...entry.customMetadata,
					mimeType: entry.mimeType,
					encoding: entry.encoding,
				},
			},
			source: entry.source ?? ('cold' as const),
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
	StorageUnavailableError: TestStorageUnavailableError,
	isStorageUnavailableError: isTestStorageUnavailableError,
	addPublicSourceCidIfChecksumMatches: async (key: string, checksum: string, sourceCid: string) => {
		legacyMetadataHealCalls.push({ key, checksum, sourceCid })
		if (legacyMetadataHealResult instanceof Error) throw legacyMetadataHealResult
		return legacyMetadataHealResult
	},
	evictPublicCacheKey: async (key: string) => {
		evictedPublicCacheKeys.push(key)
		if (evictPublicCacheKeyFailure) throw evictPublicCacheKeyFailure
		if (evictPublicCacheKeyGate) {
			evictPublicCacheKeyStarted?.()
			evictPublicCacheKeyStarted = null
			await evictPublicCacheKeyGate
		}
	},
	getStorageConfig: () => ({}),
}))
mock.module('./db', () => ({
	getSiteCache: async () =>
		siteFileCids
			? {
					did: DID,
					rkey: RKEY,
					record_cid: 'record-cid',
					file_cids: siteFileCids,
					cached_at: 0,
					updated_at: 0,
				}
			: null,
	getSiteSettingsCache: async () => null,
	CACHE_ONLY: true,
}))
mock.module('./utils', () => ({
	getCachedSettings: async () => null,
}))
mock.module('./revalidate-metrics', () => ({
	recordStorageMiss: (path: string) => recordedStorageMisses.push(path),
}))
mock.module('./revalidate-queue', () => ({
	enqueueRevalidate: async (did: string, rkey: string, reason: string) => {
		revalidateCalls.push({ did, rkey, reason })
		return { enqueued: true, result: 'enqueued' as const }
	},
}))
const { cache } = await import('./cache-manager')
const { resetHtmlHotCacheWarmupForTests } = await import('./html-prewarm')
const { applyCacheInvalidationForTests } = await import('./cache-invalidation')
const {
	serveFileInternal,
	serveFileInternalWithRewrite,
	serveFromCache,
	serveFromCacheWithRewrite,
	setGzipOperationsForTests,
	SOURCE_CID_MISMATCH_TTL_MS,
} = await import('./file-serving')
if (previousGzipProcessingConcurrency === undefined) {
	delete process.env.HOSTING_GZIP_PROCESSING_CONCURRENCY
} else {
	process.env.HOSTING_GZIP_PROCESSING_CONCURRENCY = previousGzipProcessingConcurrency
}

function installFakeGzipOperations() {
	setGzipOperationsForTests({
		async compress(data: Uint8Array) {
			gzipWorkState.compressCalls++
			return await runFakeGzipWork(() => new Uint8Array(gzipSync(Buffer.from(data))))
		},
		async decompress(data: Uint8Array, maxOutputBytes: number) {
			gzipWorkState.decompressCalls++
			return await runFakeGzipWork(() => {
				if (gzipWorkState.forceDecompressLimitError) throw new TestDecompressionLimitError()
				if (!isTestGzip(data)) throw new Error('Invalid gzip data: missing magic bytes')
				const output = gunzipSync(Buffer.from(data))
				if (output.byteLength > maxOutputBytes) throw new TestDecompressionLimitError()
				return output
			})
		},
		async measureDecompressedSize(data: Uint8Array, maxOutputBytes: number) {
			gzipWorkState.measureCalls++
			return await runFakeGzipWork(() => {
				if (gzipWorkState.forceMeasureLimitError) throw new TestDecompressionLimitError()
				if (!isTestGzip(data)) throw new Error('Invalid gzip data: missing magic bytes')
				const output = gunzipSync(Buffer.from(data))
				if (output.byteLength > maxOutputBytes) throw new TestDecompressionLimitError()
				return output.byteLength
			})
		},
	})
}

const DID = 'did:plc:test'
const RKEY = 'hydrant-docs'

function storeFile(path: string, body: string, mimeType = 'text/html') {
	storageData.set(`${DID}/${RKEY}/${path}`, {
		data: new TextEncoder().encode(body),
		mimeType,
	})
}

function queueStorageReads(path: string, entries: FakeReadOutcome[]) {
	storageReadSequences.set(`${DID}/${RKEY}/${path}`, [...entries])
}

function failStorageGet(path: string, error: Error): void {
	storageGetFailures.set(`${DID}/${RKEY}/${path}`, error)
}

function resetServingState() {
	storageData.clear()
	storageReadSequences.clear()
	storageGetFailures.clear()
	storageGetKeys.length = 0
	storageGetWithMetadataKeys.length = 0
	evictedPublicCacheKeys.length = 0
	revalidateCalls.length = 0
	recordedStorageMisses.length = 0
	evictPublicCacheKeyFailure = null
	evictPublicCacheKeyGate = null
	evictPublicCacheKeyStarted = null
	legacyMetadataHealResult = true
	legacyMetadataHealCalls.length = 0
	siteFileCids = null
	gatedStorageReadKey = null
	gatedStorageReadStarted = null
	gatedStorageReadGate = null
	cache.clear('redirectRules')
	cache.clear('siteCache')
	cache.clear('siteFiles')
	cache.clear('sourceCidMismatches')
	resetGzipWorkState()
	installFakeGzipOperations()
	resetHtmlHotCacheWarmupForTests()
}

afterEach(() => setGzipOperationsForTests())

describe('serveFileInternal directory-index fallback for extensioned paths', () => {
	beforeEach(resetServingState)

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

	test('builds a directory listing from manifest entries after its candidate stage misses', async () => {
		siteFileCids = {
			'guides/intro.txt': 'intro-cid',
			'guides/.rewritten/hidden.html': 'derived-cid',
			'guides/.metadata.json': 'metadata-cid',
		}

		const response = await serveFileInternal(DID, RKEY, 'guides', {
			$type: 'place.wisp.settings',
			directoryListing: true,
			cleanUrls: false,
		})

		expect(response.status).toBe(200)
		const html = await response.text()
		expect(html).toContain('intro.txt')
		expect(html).not.toContain('hidden.html')
		expect(html).not.toContain('.metadata.json')
		expect(storageGetWithMetadataKeys).toHaveLength(0)
	})

	test('uses the root directory-listing fallback only after file and fallback stages miss', async () => {
		siteFileCids = { 'visible.txt': 'visible-cid' }

		const response = await serveFileInternal(DID, RKEY, 'missing.md', {
			$type: 'place.wisp.settings',
			directoryListing: true,
			cleanUrls: false,
		})

		expect(response.status).toBe(404)
		expect(await response.text()).toContain('visible.txt')
	})

	test('does not re-probe failed direct and index candidates after directory fallback', async () => {
		const response = await serveFileInternal(DID, RKEY, 'missing')

		expect(response.status).toBe(404)
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/missing`)).toHaveLength(1)
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/missing/index.html`)).toHaveLength(1)
	})

	test('queues asynchronous repair for a missing manifest without probing storage', async () => {
		const response = await serveFromCache(DID, RKEY, 'index.html', 'https://example.com/index.html', {
			accept: 'application/octet-stream',
		})

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.get('Retry-After')).toBe('5')
		expect(storageGetWithMetadataKeys).toHaveLength(0)
		expect(recordedStorageMisses).toEqual(['manifest'])
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:manifest' }])
	})

	test('does not read _redirects when the manifest omits it', async () => {
		storeFile('index.html', '<html>index</html>')
		siteFileCids = { 'index.html': 'index-cid' }

		const response = await serveFromCache(DID, RKEY, 'index.html', 'https://example.com/index.html')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('<html>index</html>')
		expect(storageGetKeys).not.toContain(`${DID}/${RKEY}/_redirects`)
		expect(storageGetWithMetadataKeys).not.toContain(`${DID}/${RKEY}/_redirects`)
	})

	test('starts manifest prewarm only after the requested file resolves', async () => {
		storeFile('index.html', '<html>index</html>')
		storeFile('other.html', '<html>other</html>')
		siteFileCids = { 'index.html': 'index-cid', 'other.html': 'other-cid' }

		let releaseRequestedRead!: () => void
		const requestedRead = new Promise<void>((resolve) => {
			releaseRequestedRead = resolve
		})
		const requestedReadStarted = new Promise<void>((resolve) => {
			gatedStorageReadStarted = resolve
		})
		gatedStorageReadKey = `${DID}/${RKEY}/index.html`
		gatedStorageReadGate = requestedRead

		const responsePromise = serveFromCache(DID, RKEY, 'index.html', 'https://example.com/index.html')
		await requestedReadStarted
		expect(storageGetWithMetadataKeys).toEqual([`${DID}/${RKEY}/index.html`])

		releaseRequestedRead()
		const response = await responsePromise
		expect(response.status).toBe(200)
		await response.text()
		await new Promise<void>((resolve) => queueMicrotask(resolve))
		expect(storageGetWithMetadataKeys).toContain(`${DID}/${RKEY}/other.html`)
	})

	test('skips storage miss before redirect when manifest says extensioned direct file is absent', async () => {
		storeFile('_redirects', '/getting-started.md /docs/getting-started 301', 'text/plain')
		siteFileCids = {
			_redirects: 'redirects-cid',
			'getting-started.md/index.html': 'index-cid',
		}

		const response = await serveFromCache(
			DID,
			RKEY,
			'getting-started.md',
			'https://hydrant.klbr.net/getting-started.md',
		)

		expect(response.status).toBe(301)
		expect(response.headers.get('Location')).toBe('/docs/getting-started')
		expect(storageGetWithMetadataKeys).not.toContain(`${DID}/${RKEY}/getting-started.md`)
	})

	test('serves a direct file once before non-forced redirect when manifest says it exists', async () => {
		storeFile('_redirects', '/direct.md /elsewhere 301', 'text/plain')
		storeFile('direct.md', 'direct markdown', 'text/markdown')
		siteFileCids = {
			_redirects: 'redirects-cid',
			'direct.md': 'direct-cid',
		}

		const response = await serveFromCache(DID, RKEY, 'direct.md', 'https://hydrant.klbr.net/direct.md')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('direct markdown')
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/direct.md`)).toHaveLength(1)
	})

	test('serves decoded file names containing spaces', async () => {
		const path = '486x486bb 3.webp'
		storeFile(path, 'image bytes', 'image/webp')
		siteFileCids = { [path]: 'image-cid' }

		const response = await serveFileInternal(DID, RKEY, path)

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('image bytes')
		expect(storageGetWithMetadataKeys).toContain(`${DID}/${RKEY}/${path}`)
	})

	test('skips manifest-absent storage probes before clean URL html fallback', async () => {
		storeFile('modelapp.html', '<html>model app</html>')
		siteFileCids = {
			'modelapp.html': 'modelapp-cid',
		}

		const response = await serveFileInternal(DID, RKEY, 'modelapp', {
			$type: 'place.wisp.settings',
			directoryListing: false,
			cleanUrls: true,
		})

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('<html>model app</html>')
		expect(storageGetWithMetadataKeys).not.toContain(`${DID}/${RKEY}/modelapp`)
		expect(storageGetWithMetadataKeys).not.toContain(`${DID}/${RKEY}/modelapp/index.html`)
		expect(storageGetWithMetadataKeys).toContain(`${DID}/${RKEY}/modelapp.html`)
	})

	test('keeps fingerprinted javascript assets on the standard cache policy', async () => {
		storeFile('assets/typescript-COf36OFD.js', 'export const ts = true', 'text/javascript')

		const response = await serveFileInternal(DID, RKEY, 'assets/typescript-COf36OFD.js')

		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=600')
	})

	test('keeps non-fingerprinted javascript assets on the standard cache policy', async () => {
		storeFile('assets/app.js', 'export const app = true', 'text/javascript')

		const response = await serveFileInternal(DID, RKEY, 'assets/app.js')

		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=600')
	})

	test('returns standard cache headers on fingerprinted asset 304 responses', async () => {
		storeFile('assets/typescript-COf36OFD.js', 'export const ts = true', 'text/javascript')

		const response = await serveFileInternal(DID, RKEY, 'assets/typescript-COf36OFD.js', null, {
			'if-none-match': '"test-checksum"',
		})

		expect(response.status).toBe(304)
		expect(response.headers.get('ETag')).toBe('"test-checksum"')
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=600')
	})

	test('rejects absolute 200 rewrite targets without proxying them', async () => {
		siteFileCids = { _redirects: 'redirects-cid' }
		storeFile(
			'_redirects',
			'/.well-known/webfinger?resource=:resource https://webfinger.madoka-winter.workers.dev/?resource=:resource 200',
			'text/plain',
		)

		const response = await serveFromCache(
			DID,
			RKEY,
			'.well-known/webfinger',
			'https://madoka.example/.well-known/webfinger?resource=acct:ana@example.com',
			{ accept: 'application/jrd+json' },
		)

		expect(response.status).toBe(400)
		expect(await response.text()).toBe('Absolute URL rewrites are not supported')
		expect(storageGetWithMetadataKeys).not.toContain(
			`${DID}/${RKEY}/https://webfinger.madoka-winter.workers.dev/?resource=acct%3Aana%40example.com`,
		)
	})
})

describe('storage availability responses', () => {
	beforeEach(resetServingState)

	test('returns no-store 503 without repair for a transient expected-file read failure', async () => {
		siteFileCids = { 'unavailable.txt': 'expected-cid' }
		queueStorageReads('unavailable.txt', [new TestStorageUnavailableError('getWithMetadata', 'timeout')])

		const response = await serveFromCache(DID, RKEY, 'unavailable.txt', 'https://example.com/unavailable.txt', {
			accept: 'application/octet-stream',
		})

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.get('Retry-After')).toBe('5')
		expect(revalidateCalls).toEqual([])
		expect(recordedStorageMisses).toEqual([])
		expect(evictedPublicCacheKeys).toEqual([])
	})

	test('does not turn a transient cold retry failure into a source-CID repair', async () => {
		siteFileCids = { 'retry-unavailable.txt': 'expected-cid' }
		queueStorageReads('retry-unavailable.txt', [
			{
				data: new TextEncoder().encode('stale warm bytes'),
				mimeType: 'text/plain',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			new TestStorageUnavailableError('getWithMetadata', 'circuit-open'),
		])

		const response = await serveFromCache(
			DID,
			RKEY,
			'retry-unavailable.txt',
			'https://example.com/retry-unavailable.txt',
		)

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(evictedPublicCacheKeys).toEqual([`${DID}/${RKEY}/retry-unavailable.txt`])
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/retry-unavailable.txt`)).toHaveLength(2)
		expect(revalidateCalls).toEqual([])
		expect(recordedStorageMisses).toEqual([])
	})

	test('does not cache a transient cold outage as a source-CID mismatch', async () => {
		siteFileCids = { 'retry-recovery.txt': 'expected-cid' }
		queueStorageReads('retry-recovery.txt', [
			{
				data: new TextEncoder().encode('stale warm bytes'),
				mimeType: 'text/plain',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			new TestStorageUnavailableError('getWithMetadata', 'timeout'),
		])

		const unavailable = await serveFromCache(DID, RKEY, 'retry-recovery.txt', 'https://example.com/retry-recovery.txt')
		expect(unavailable.status).toBe(503)

		storageData.set(`${DID}/${RKEY}/retry-recovery.txt`, {
			data: new TextEncoder().encode('fresh cold bytes'),
			mimeType: 'text/plain',
			source: 'cold',
		})
		const recovered = await serveFromCache(DID, RKEY, 'retry-recovery.txt', 'https://example.com/retry-recovery.txt')
		expect(recovered.status).toBe(200)
		expect(await recovered.text()).toBe('fresh cold bytes')
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/retry-recovery.txt`)).toHaveLength(3)
		expect(evictedPublicCacheKeys).toHaveLength(1)
	})

	test('returns no-store 503 instead of ignoring a transient _redirects read failure', async () => {
		siteFileCids = { _redirects: 'redirects-cid' }
		failStorageGet('_redirects', new TestStorageUnavailableError('get', 'timeout'))

		const response = await serveFromCache(DID, RKEY, 'old', 'https://example.com/old')

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(revalidateCalls).toEqual([])
		expect(recordedStorageMisses).toEqual([])
	})
})

describe('shared-origin file-serving strategy', () => {
	beforeEach(resetServingState)

	test('prefers pre-rewritten HTML and applies shared-origin header restrictions', async () => {
		const settings = {
			$type: 'place.wisp.settings' as const,
			directoryListing: false,
			cleanUrls: false,
			headers: [
				{ name: 'Service-Worker-Allowed', value: '/' },
				{ name: 'X-Site-Header', value: 'shared' },
			],
		}
		storeFile('page.html', '<html>original</html>')
		storeFile('.rewritten/page.html', '<html>pre-rewritten</html>')
		siteFileCids = {
			'page.html': 'page-cid',
			'.rewritten/page.html': 'rewritten-page-cid',
		}

		const directResponse = await serveFileInternal(DID, RKEY, 'page.html', settings)
		expect(await directResponse.text()).toBe('<html>original</html>')
		expect(directResponse.headers.get('Service-Worker-Allowed')).toBe('/')

		const sharedResponse = await serveFileInternalWithRewrite(DID, RKEY, 'page.html', '/did/site/', settings)
		expect(await sharedResponse.text()).toBe('<html>pre-rewritten</html>')
		expect(sharedResponse.headers.get('Service-Worker-Allowed')).toBeNull()
		expect(sharedResponse.headers.get('X-Site-Header')).toBe('shared')
	})

	test('adds the shared path to relative redirect targets only on sites.wisp.place', async () => {
		siteFileCids = { _redirects: 'redirects-cid' }
		storeFile('_redirects', '/old /new 301', 'text/plain')

		const directResponse = await serveFromCache(DID, RKEY, 'old', 'https://custom.example/old')
		expect(directResponse.status).toBe(301)
		expect(directResponse.headers.get('Location')).toBe('/new')

		const sharedResponse = await serveFromCacheWithRewrite(
			DID,
			RKEY,
			'old',
			'/did/site/',
			'https://sites.wisp.place/did/site/old',
		)
		expect(sharedResponse.status).toBe(301)
		expect(sharedResponse.headers.get('Location')).toBe('/did/site/new')
	})

	test('uses request headers when a shared-origin expected file is missing from storage', async () => {
		siteFileCids = { 'missing.html': 'missing-cid' }

		const response = await serveFileInternalWithRewrite(DID, RKEY, 'missing.html', '/did/site/', null, {
			accept: 'text/html',
		})

		expect(response.status).toBe(503)
		expect(response.headers.get('Content-Type')).toContain('text/html')
		expect(await response.text()).toContain('Site Updating')
	})

	test('serves a durable empty manifest tombstone as 404 instead of a retryable storage miss', async () => {
		siteFileCids = {}
		const response = await serveFromCache(DID, RKEY, 'index.html', 'https://example.com/index.html')
		expect(response.status).toBe(404)
		expect(revalidateCalls).toHaveLength(0)
	})

	test('serves one byte range and reports an unsatisfiable range without the full entity', async () => {
		const body = Buffer.from('0123456789abcdef')
		storageData.set(`${DID}/${RKEY}/range.txt`, { data: body, mimeType: 'text/plain' })

		const partial = await serveFileInternal(DID, RKEY, 'range.txt', null, { range: 'bytes=3-7' })
		expect(partial.status).toBe(206)
		expect(partial.headers.get('Accept-Ranges')).toBe('bytes')
		expect(partial.headers.get('Content-Range')).toBe('bytes 3-7/16')
		expect(partial.headers.get('Content-Length')).toBe('5')
		expect(await partial.text()).toBe('34567')

		const unsatisfiable = await serveFileInternal(DID, RKEY, 'range.txt', null, { range: 'bytes=16-20' })
		expect(unsatisfiable.status).toBe(416)
		expect(unsatisfiable.headers.get('Content-Range')).toBe('bytes */16')
		expect(unsatisfiable.headers.get('Content-Length')).toBe('0')
		expect(await unsatisfiable.arrayBuffer()).toHaveLength(0)
	})

	test('honors gzip q=0, varies by Accept-Encoding, and uses representation-specific ETags', async () => {
		const body = 'body { color: rebeccapurple; }'
		storageData.set(`${DID}/${RKEY}/styles.css`, {
			data: gzipSync(Buffer.from(body)),
			mimeType: 'text/css',
			encoding: 'gzip',
		})

		const uncompressedResponse = await serveFileInternal(DID, RKEY, 'styles.css', null, {
			'accept-encoding': 'gzip;q=0',
		})
		const identityEtag = uncompressedResponse.headers.get('ETag')
		expect(uncompressedResponse.headers.get('Content-Encoding')).toBeNull()
		expect(uncompressedResponse.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')
		expect(await uncompressedResponse.text()).toBe(body)

		const compressedResponse = await serveFileInternal(DID, RKEY, 'styles.css', null, {
			'accept-encoding': 'gzip',
		})
		const gzipEtag = compressedResponse.headers.get('ETag')
		expect(compressedResponse.headers.get('Content-Encoding')).toBe('gzip')
		expect(compressedResponse.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')
		expect(gzipEtag).not.toBe(identityEtag)
		expect(new TextDecoder().decode(gunzipSync(Buffer.from(await compressedResponse.arrayBuffer())))).toBe(body)

		const identityWithGzipValidator = await serveFileInternal(DID, RKEY, 'styles.css', null, {
			'accept-encoding': 'gzip;q=0',
			'if-none-match': gzipEtag ?? '',
		})
		expect(identityWithGzipValidator.status).toBe(200)
		expect(await identityWithGzipValidator.text()).toBe(body)

		const gzipWithIdentityValidator = await serveFileInternal(DID, RKEY, 'styles.css', null, {
			'accept-encoding': 'gzip',
			'if-none-match': identityEtag ?? '',
		})
		expect(gzipWithIdentityValidator.status).toBe(200)
		expect(gzipWithIdentityValidator.headers.get('Content-Encoding')).toBe('gzip')

		const gzipNotModifiedResponse = await serveFileInternal(DID, RKEY, 'styles.css', null, {
			'accept-encoding': 'gzip',
			'if-none-match': gzipEtag ?? '',
		})
		expect(gzipNotModifiedResponse.status).toBe(304)
		expect(gzipNotModifiedResponse.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')

		const identityNotModifiedResponse = await serveFileInternal(DID, RKEY, 'styles.css', null, {
			'accept-encoding': 'gzip;q=0',
			'if-none-match': identityEtag ?? '',
		})
		expect(identityNotModifiedResponse.status).toBe(304)
		expect(identityNotModifiedResponse.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')
	})

	test('negotiates gzip-magic text content even when legacy metadata omits encoding', async () => {
		const body = 'body { display: grid; }'
		storageData.set(`${DID}/${RKEY}/legacy.css`, {
			data: gzipSync(Buffer.from(body)),
			mimeType: 'text/css',
		})

		const identityResponse = await serveFileInternal(DID, RKEY, 'legacy.css', null, {
			'accept-encoding': 'gzip;q=0',
		})
		expect(identityResponse.headers.get('Content-Encoding')).toBeNull()
		expect(identityResponse.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')
		expect(await identityResponse.text()).toBe(body)

		const gzipResponse = await serveFileInternal(DID, RKEY, 'legacy.css', null, {
			'accept-encoding': 'gzip',
		})
		expect(gzipResponse.headers.get('Content-Encoding')).toBe('gzip')
		expect(gzipResponse.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')
		expect(new TextDecoder().decode(gunzipSync(Buffer.from(await gzipResponse.arrayBuffer())))).toBe(body)
	})

	test('measures legacy gzip passthrough and rejects oversized or malformed compressed bytes', async () => {
		const legacyBomb = gzipSync(Buffer.from('legacy compressed payload'))
		storageData.set(`${DID}/${RKEY}/legacy-bomb.css`, {
			data: legacyBomb,
			mimeType: 'text/css',
		})
		gzipWorkState.forceMeasureLimitError = true

		const oversizedResponse = await serveFileInternal(DID, RKEY, 'legacy-bomb.css', null, {
			'accept-encoding': 'gzip',
		})
		expect(oversizedResponse.status).toBe(422)
		expect(oversizedResponse.headers.get('Content-Encoding')).toBeNull()
		expect(oversizedResponse.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')
		expect(await oversizedResponse.text()).toBe('Stored file could not be decompressed safely')
		expect(gzipWorkState.measureCalls).toBe(1)

		gzipWorkState.forceMeasureLimitError = false
		storageData.set(`${DID}/${RKEY}/legacy-malformed.css`, {
			data: Buffer.from([0x1f, 0x8b, 0x00]),
			mimeType: 'text/css',
		})
		const malformedResponse = await serveFileInternal(DID, RKEY, 'legacy-malformed.css', null, {
			'accept-encoding': 'gzip',
		})
		expect(malformedResponse.status).toBe(422)
		expect(malformedResponse.headers.get('Content-Encoding')).toBeNull()
		expect(malformedResponse.headers.get('Cache-Control')).toBe('no-store')
		expect(gzipWorkState.measureCalls).toBe(2)
	})

	test('uses valid firehose uncompressed-size metadata without remeasuring gzip passthrough', async () => {
		const body = 'body { display: contents; }'
		storageData.set(`${DID}/${RKEY}/accounted.css`, {
			data: gzipSync(Buffer.from(body)),
			mimeType: 'text/css',
			encoding: 'gzip',
			customMetadata: { uncompressedSize: `${Buffer.byteLength(body)}` },
		})

		const response = await serveFileInternal(DID, RKEY, 'accounted.css', null, {
			'accept-encoding': 'gzip',
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Encoding')).toBe('gzip')
		expect(new TextDecoder().decode(gunzipSync(Buffer.from(await response.arrayBuffer())))).toBe(body)
		expect(gzipWorkState.measureCalls).toBe(0)
		expect(gzipWorkState.decompressCalls).toBe(0)

		storageData.set(`${DID}/${RKEY}/over-accounted.css`, {
			data: gzipSync(Buffer.from(body)),
			mimeType: 'text/css',
			encoding: 'gzip',
			customMetadata: { uncompressedSize: `${MAX_BLOB_SIZE + 1}` },
		})
		const overLimitResponse = await serveFileInternal(DID, RKEY, 'over-accounted.css', null, {
			'accept-encoding': 'gzip',
		})
		expect(overLimitResponse.status).toBe(422)
		expect(overLimitResponse.headers.get('Content-Encoding')).toBeNull()
		expect(gzipWorkState.measureCalls).toBe(0)

		storageData.set(`${DID}/${RKEY}/invalid-accounted.css`, {
			data: gzipSync(Buffer.from(body)),
			mimeType: 'text/css',
			encoding: 'gzip',
			customMetadata: { uncompressedSize: 'not-a-size' },
		})
		const remeasuredResponse = await serveFileInternal(DID, RKEY, 'invalid-accounted.css', null, {
			'accept-encoding': 'gzip',
		})
		expect(remeasuredResponse.status).toBe(200)
		expect(remeasuredResponse.headers.get('Content-Encoding')).toBe('gzip')
		expect(gzipWorkState.measureCalls).toBe(1)
	})

	test('returns a safe error instead of falling back after gzip decode or limit failures during HTML rewrite', async () => {
		storageData.set(`${DID}/${RKEY}/broken-rewrite.html`, {
			data: Buffer.from([0x1f, 0x8b, 0x00]),
			mimeType: 'text/html',
			encoding: 'gzip',
		})

		const response = await serveFileInternalWithRewrite(DID, RKEY, 'broken-rewrite.html', '/did/site/', null, {
			'accept-encoding': 'gzip',
		})
		expect(response.status).toBe(422)
		expect(response.headers.get('Content-Encoding')).toBeNull()
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(await response.text()).toBe('Stored file could not be decompressed safely')

		gzipWorkState.forceDecompressLimitError = true
		storageData.set(`${DID}/${RKEY}/limited-rewrite.html`, {
			data: gzipSync(Buffer.from('<html>within source limit</html>')),
			mimeType: 'text/html',
			encoding: 'gzip',
		})
		const limitResponse = await serveFileInternalWithRewrite(DID, RKEY, 'limited-rewrite.html', '/did/site/', null, {
			'accept-encoding': 'gzip',
		})
		expect(limitResponse.status).toBe(422)
		expect(limitResponse.headers.get('Content-Encoding')).toBeNull()
		expect(await limitResponse.text()).toBe('Stored file could not be decompressed safely')
		gzipWorkState.forceDecompressLimitError = false
	})

	test('limits concurrent gzip identity decoding across requests', async () => {
		const body = 'body { color: slateblue; }'
		const compressed = gzipSync(Buffer.from(body))
		for (const filePath of ['first.css', 'second.css', 'third.css']) {
			storageData.set(`${DID}/${RKEY}/${filePath}`, {
				data: compressed,
				mimeType: 'text/css',
				encoding: 'gzip',
				customMetadata: { uncompressedSize: `${Buffer.byteLength(body)}` },
			})
		}

		gzipWorkState.holdWork = true
		const responses = ['first.css', 'second.css', 'third.css'].map((filePath) =>
			serveFileInternal(DID, RKEY, filePath, null, { 'accept-encoding': 'gzip;q=0' }),
		)
		try {
			await waitForGzipWorkActive(2)
			expect(gzipWorkState.active).toBe(2)
			expect(gzipWorkState.maxActive).toBe(2)
		} finally {
			releaseHeldGzipWork()
		}

		for (const response of await Promise.all(responses)) {
			expect(response.status).toBe(200)
			expect(await response.text()).toBe(body)
		}
		expect(gzipWorkState.maxActive).toBe(2)
	})

	test('rewrites gzip HTML with asynchronous recompression and still honors q=0', async () => {
		const body = '<html><body><a href="/docs">Docs</a></body></html>'
		storageData.set(`${DID}/${RKEY}/rewrite.html`, {
			data: gzipSync(Buffer.from(body)),
			mimeType: 'text/html',
			encoding: 'gzip',
		})

		const gzipResponse = await serveFileInternalWithRewrite(DID, RKEY, 'rewrite.html', '/did/site/', null, {
			'accept-encoding': 'gzip',
		})
		expect(gzipResponse.headers.get('Content-Encoding')).toBe('gzip')
		expect(new TextDecoder().decode(gunzipSync(Buffer.from(await gzipResponse.arrayBuffer())))).toContain(
			'/did/site/docs',
		)

		const identityResponse = await serveFileInternalWithRewrite(DID, RKEY, 'rewrite.html', '/did/site/', null, {
			'accept-encoding': 'gzip;q=0',
		})
		expect(identityResponse.headers.get('Content-Encoding')).toBeNull()
		expect(await identityResponse.text()).toContain('/did/site/docs')
	})

	test('varies dynamically rewritten identity HTML by Accept-Encoding', async () => {
		const body = '<html><body><a href="/docs">Docs</a></body></html>'
		storageData.set(`${DID}/${RKEY}/identity-rewrite.html`, {
			data: Buffer.from(body),
			mimeType: 'text/html',
		})

		const gzipResponse = await serveFileInternalWithRewrite(DID, RKEY, 'identity-rewrite.html', '/did/site/', null, {
			'accept-encoding': 'gzip',
		})
		expect(gzipResponse.headers.get('Content-Encoding')).toBe('gzip')
		expect(gzipResponse.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')
		expect(new TextDecoder().decode(gunzipSync(Buffer.from(await gzipResponse.arrayBuffer())))).toContain(
			'/did/site/docs',
		)

		const identityResponse = await serveFileInternalWithRewrite(
			DID,
			RKEY,
			'identity-rewrite.html',
			'/did/site/',
			null,
			{ 'accept-encoding': 'gzip;q=0' },
		)
		expect(identityResponse.headers.get('Content-Encoding')).toBeNull()
		expect(identityResponse.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')
		expect(await identityResponse.text()).toContain('/did/site/docs')
	})

	test('rejects malformed gzip metadata instead of serving raw bytes as gzip', async () => {
		storageData.set(`${DID}/${RKEY}/broken.css`, {
			data: Buffer.from('not actually gzip'),
			mimeType: 'text/css',
			encoding: 'gzip',
		})

		const response = await serveFileInternal(DID, RKEY, 'broken.css', null, {
			'accept-encoding': 'gzip;q=0',
		})

		expect(response.status).toBe(422)
		expect(response.headers.get('Content-Encoding')).toBeNull()
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.get('Vary')?.toLowerCase()).toContain('accept-encoding')
		expect(await response.text()).not.toContain('not actually gzip')
	})
})

describe('manifest source CID validation', () => {
	beforeEach(resetServingState)

	test('shares one source-CID validation retry across a request burst', async () => {
		siteFileCids = { 'burst.txt': 'expected-cid' }
		queueStorageReads('burst.txt', [
			{
				data: new TextEncoder().encode('stale warm bytes'),
				mimeType: 'text/plain',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			{
				data: new TextEncoder().encode('stale cold bytes'),
				mimeType: 'text/plain',
				source: 'cold',
				customMetadata: { sourceCid: 'old-cid' },
			},
		])

		const responses = await Promise.all(
			Array.from({ length: 5 }, () => serveFromCache(DID, RKEY, 'burst.txt', 'https://example.com/burst.txt')),
		)

		expect(responses.map((response) => response.status)).toEqual([503, 503, 503, 503, 503])
		expect(evictedPublicCacheKeys).toEqual([`${DID}/${RKEY}/burst.txt`])
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/burst.txt`)).toHaveLength(2)
		expect(revalidateCalls).toHaveLength(5)

		// The marker is checked before storage, so later requests do not repeat the
		// hot/warm read, cold retry, eviction, or mismatch logging.
		const repeated = await serveFromCache(DID, RKEY, 'burst.txt', 'https://example.com/burst.txt')
		expect(repeated.status).toBe(503)
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/burst.txt`)).toHaveLength(2)
		expect(evictedPublicCacheKeys).toHaveLength(1)
	})

	test('expires a source-CID mismatch marker so a later cold recovery is visible', async () => {
		const originalNow = Date.now
		let now = 1_000_000
		Date.now = () => now

		try {
			siteFileCids = { 'ttl.txt': 'expected-cid' }
			queueStorageReads('ttl.txt', [
				{
					data: new TextEncoder().encode('stale warm bytes'),
					mimeType: 'text/plain',
					source: 'warm',
					customMetadata: { sourceCid: 'old-cid' },
				},
				{
					data: new TextEncoder().encode('stale cold bytes'),
					mimeType: 'text/plain',
					source: 'cold',
					customMetadata: { sourceCid: 'old-cid' },
				},
			])

			const failed = await serveFromCache(DID, RKEY, 'ttl.txt', 'https://example.com/ttl.txt')
			expect(failed.status).toBe(503)
			const readsBeforeExpiry = storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/ttl.txt`)
			expect(readsBeforeExpiry).toHaveLength(2)

			storageData.set(`${DID}/${RKEY}/ttl.txt`, {
				data: new TextEncoder().encode('fresh cold bytes'),
				mimeType: 'text/plain',
				source: 'cold',
			})
			now += SOURCE_CID_MISMATCH_TTL_MS + 1

			const recovered = await serveFromCache(DID, RKEY, 'ttl.txt', 'https://example.com/ttl.txt')
			expect(recovered.status).toBe(200)
			expect(await recovered.text()).toBe('fresh cold bytes')
			expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/ttl.txt`)).toHaveLength(3)
		} finally {
			Date.now = originalNow
		}
	})

	test('site invalidation clears a source-CID marker before cold recovery', async () => {
		siteFileCids = { 'invalidated.txt': 'expected-cid' }
		queueStorageReads('invalidated.txt', [
			{
				data: new TextEncoder().encode('stale warm bytes'),
				mimeType: 'text/plain',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			{
				data: new TextEncoder().encode('stale cold bytes'),
				mimeType: 'text/plain',
				source: 'cold',
				customMetadata: { sourceCid: 'old-cid' },
			},
		])

		const failed = await serveFromCache(DID, RKEY, 'invalidated.txt', 'https://example.com/invalidated.txt')
		expect(failed.status).toBe(503)

		storageData.set(`${DID}/${RKEY}/invalidated.txt`, {
			data: new TextEncoder().encode('fresh cold bytes'),
			mimeType: 'text/plain',
			source: 'cold',
		})
		await applyCacheInvalidationForTests({ did: DID, rkey: RKEY, action: 'update' }, 'pubsub', {
			storage: {
				async invalidateUpperCaches() {
					return { hotDeleted: 0, warmDeleted: 0, failures: [] }
				},
			},
			cache,
		})

		const recovered = await serveFromCache(DID, RKEY, 'invalidated.txt', 'https://example.com/invalidated.txt')
		expect(recovered.status).toBe(200)
		expect(await recovered.text()).toBe('fresh cold bytes')
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/invalidated.txt`)).toHaveLength(3)
	})

	test('fences a pending mismatch retry when site invalidation arrives', async () => {
		siteFileCids = { 'pending-invalidation.txt': 'expected-cid' }
		queueStorageReads('pending-invalidation.txt', [
			{
				data: new TextEncoder().encode('stale warm bytes'),
				mimeType: 'text/plain',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			{
				data: new TextEncoder().encode('stale cold bytes'),
				mimeType: 'text/plain',
				source: 'cold',
				customMetadata: { sourceCid: 'old-cid' },
			},
		])

		let releaseEviction!: () => void
		evictPublicCacheKeyGate = new Promise<void>((resolve) => {
			releaseEviction = resolve
		})
		const evictionStarted = new Promise<void>((resolve) => {
			evictPublicCacheKeyStarted = resolve
		})
		const pendingResponse = serveFromCache(
			DID,
			RKEY,
			'pending-invalidation.txt',
			'https://example.com/pending-invalidation.txt',
		)
		await evictionStarted

		// Prefix invalidation fences the pending getOrFetch, so its stale result
		// cannot repopulate the marker after this update.
		await applyCacheInvalidationForTests({ did: DID, rkey: RKEY, action: 'settings' })
		storageData.set(`${DID}/${RKEY}/pending-invalidation.txt`, {
			data: new TextEncoder().encode('fresh cold bytes'),
			mimeType: 'text/plain',
			source: 'cold',
		})
		evictPublicCacheKeyGate = null
		releaseEviction()

		const staleResponse = await pendingResponse
		expect(staleResponse.status).toBe(503)
		const recovered = await serveFromCache(
			DID,
			RKEY,
			'pending-invalidation.txt',
			'https://example.com/pending-invalidation.txt',
		)
		expect(recovered.status).toBe(200)
		expect(await recovered.text()).toBe('fresh cold bytes')
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/pending-invalidation.txt`)).toHaveLength(
			3,
		)
	})

	test('evicts a stale warm object and serves the matching cold object', async () => {
		siteFileCids = { 'asset.txt': 'new-cid' }
		queueStorageReads('asset.txt', [
			{
				data: new TextEncoder().encode('stale warm bytes'),
				mimeType: 'text/plain',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			{
				data: new TextEncoder().encode('fresh cold bytes'),
				mimeType: 'text/plain',
				source: 'cold',
				customMetadata: { sourceCid: 'new-cid' },
			},
		])

		const response = await serveFromCache(DID, RKEY, 'asset.txt', 'https://example.com/asset.txt')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('fresh cold bytes')
		expect(evictedPublicCacheKeys).toEqual([`${DID}/${RKEY}/asset.txt`])
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/asset.txt`)).toHaveLength(2)
		expect(revalidateCalls).toHaveLength(0)
	})

	test('does not turn a source-CID repair response into a redirect-defined 404', async () => {
		siteFileCids = {
			_redirects: 'redirects-cid',
			'stale.html': 'expected-cid',
		}
		storeFile('_redirects', '/old /stale.html 404', 'text/plain')
		queueStorageReads('stale.html', [
			{
				data: new TextEncoder().encode('stale warm HTML'),
				mimeType: 'text/html',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			{
				data: new TextEncoder().encode('stale cold HTML'),
				mimeType: 'text/html',
				source: 'cold',
				customMetadata: { sourceCid: 'another-old-cid' },
			},
		])

		const response = await serveFromCache(DID, RKEY, 'old', 'https://example.com/old', {
			accept: 'application/octet-stream',
		})

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:stale.html' }])
	})

	test('serves a verified legacy object and requests one source-CID backfill', async () => {
		const body = new TextEncoder().encode('legacy bytes that still match the blob')
		siteFileCids = { 'legacy-match.txt': computeCID(Buffer.from(body)) }
		queueStorageReads('legacy-match.txt', [
			{ data: body, mimeType: 'text/plain', source: 'cold', useManifestSourceCid: false },
		])

		const response = await serveFromCache(DID, RKEY, 'legacy-match.txt', 'https://example.com/legacy-match.txt')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('legacy bytes that still match the blob')
		expect(revalidateCalls).toEqual([])
		expect(legacyMetadataHealCalls).toEqual([expect.objectContaining({ sourceCid: siteFileCids['legacy-match.txt'] })])
	})

	test('falls back to durable repair when the conditional legacy metadata heal is unavailable', async () => {
		const body = new TextEncoder().encode('legacy bytes needing a failed heal')
		const failureDid = `${DID}:legacy-heal-failure`
		siteFileCids = { 'legacy-heal-failure.txt': computeCID(Buffer.from(body)) }
		legacyMetadataHealResult = false
		storageData.set(`${failureDid}/${RKEY}/legacy-heal-failure.txt`, {
			data: body,
			mimeType: 'text/plain',
			useManifestSourceCid: false,
		})

		const response = await serveFromCache(
			failureDid,
			RKEY,
			'legacy-heal-failure.txt',
			'https://example.com/legacy-heal-failure.txt',
		)

		expect(response.status).toBe(200)
		expect(revalidateCalls).toEqual([
			{ did: failureDid, rkey: RKEY, reason: 'storage-miss:legacy-source-cid-backfill' },
		])
	})

	test('heals each verified legacy file while deduping a burst for the same file', async () => {
		const first = new TextEncoder().encode('first legacy file')
		const second = new TextEncoder().encode('second legacy file')
		siteFileCids = {
			'legacy-first.txt': computeCID(Buffer.from(first)),
			'legacy-second.txt': computeCID(Buffer.from(second)),
		}
		storageData.set(`${DID}/${RKEY}/legacy-first.txt`, {
			data: first,
			mimeType: 'text/plain',
			useManifestSourceCid: false,
		})
		storageData.set(`${DID}/${RKEY}/legacy-second.txt`, {
			data: second,
			mimeType: 'text/plain',
			useManifestSourceCid: false,
		})

		const responses = await Promise.all([
			serveFromCache(DID, RKEY, 'legacy-first.txt', 'https://example.com/legacy-first.txt'),
			serveFromCache(DID, RKEY, 'legacy-first.txt', 'https://example.com/legacy-first.txt'),
			serveFromCache(DID, RKEY, 'legacy-second.txt', 'https://example.com/legacy-second.txt'),
		])
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
		await Promise.resolve()
		expect(legacyMetadataHealCalls.map((call) => call.key).sort()).toEqual([
			`${DID}/${RKEY}/legacy-first.txt`,
			`${DID}/${RKEY}/legacy-second.txt`,
		])
	})

	test('rejects an oversized legacy object before CID calculation', async () => {
		const body = new TextEncoder().encode('small body with untrusted oversized metadata')
		siteFileCids = { 'legacy-oversized.txt': computeCID(Buffer.from(body)) }
		queueStorageReads('legacy-oversized.txt', [
			{
				data: body,
				metadataSize: MAX_BLOB_SIZE + 1,
				mimeType: 'text/plain',
				source: 'cold',
				useManifestSourceCid: false,
			},
		])

		const response = await serveFromCache(DID, RKEY, 'legacy-oversized.txt', 'https://example.com/legacy-oversized.txt')

		expect(response.status).toBe(503)
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:legacy-oversized.txt' }])
	})

	test('dedupes legacy source-CID backfill requests during a request burst', async () => {
		const body = new TextEncoder().encode('deduped legacy bytes')
		siteFileCids = { 'legacy-dedupe.txt': computeCID(Buffer.from(body)) }
		const dedupeDid = `${DID}:legacy-dedupe`
		storageData.set(`${dedupeDid}/${RKEY}/legacy-dedupe.txt`, {
			data: body,
			mimeType: 'text/plain',
			useManifestSourceCid: false,
		})

		const responses = await Promise.all([
			serveFromCache(dedupeDid, RKEY, 'legacy-dedupe.txt', 'https://example.com/legacy-dedupe.txt'),
			serveFromCache(dedupeDid, RKEY, 'legacy-dedupe.txt', 'https://example.com/legacy-dedupe.txt'),
		])

		expect(responses.map((response) => response.status)).toEqual([200, 200])
		expect(revalidateCalls).toEqual([])
		expect(legacyMetadataHealCalls).toHaveLength(1)
	})

	test('fails closed and repairs when legacy objects have no source CID metadata', async () => {
		siteFileCids = { 'legacy.txt': 'expected-cid' }
		queueStorageReads('legacy.txt', [
			{
				data: new TextEncoder().encode('legacy warm bytes'),
				mimeType: 'text/plain',
				source: 'warm',
				useManifestSourceCid: false,
			},
			{
				data: new TextEncoder().encode('legacy cold bytes'),
				mimeType: 'text/plain',
				source: 'cold',
				useManifestSourceCid: false,
			},
		])

		const response = await serveFromCache(DID, RKEY, 'legacy.txt', 'https://example.com/legacy.txt')

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(await response.text()).not.toContain('legacy')
		expect(evictedPublicCacheKeys).toEqual([`${DID}/${RKEY}/legacy.txt`])
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/legacy.txt`)).toHaveLength(2)
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:legacy.txt' }])
	})

	test('uses the original manifest CID to validate pre-rewritten HTML', async () => {
		siteFileCids = {
			'page.html': 'original-source-cid',
			'.rewritten/page.html': 'derived-cache-cid',
		}
		queueStorageReads('.rewritten/page.html', [
			{
				data: new TextEncoder().encode('<html>pre-rewritten</html>'),
				mimeType: 'text/html',
				source: 'cold',
				customMetadata: { sourceCid: 'original-source-cid' },
			},
		])

		const response = await serveFromCacheWithRewrite(
			DID,
			RKEY,
			'page.html',
			'/did/site/',
			'https://sites.wisp.place/did/site/page.html',
		)

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('<html>pre-rewritten</html>')
		expect(evictedPublicCacheKeys).toHaveLength(0)
		const rewrittenRead = storageGetWithMetadataKeys.indexOf(`${DID}/${RKEY}/.rewritten/page.html`)
		const originalRead = storageGetWithMetadataKeys.indexOf(`${DID}/${RKEY}/page.html`)
		// The requested preferred representation must win before background prewarm
		// starts its independent read of the original HTML.
		expect(rewrittenRead).toBeGreaterThanOrEqual(0)
		expect(originalRead).toBeGreaterThan(rewrittenRead)
	})

	test('returns repair 503 instead of falling through to an SPA after a source CID mismatch', async () => {
		siteFileCids = {
			'asset.js': 'expected-cid',
			'index.html': 'spa-cid',
		}
		storeFile('index.html', '<html>SPA fallback</html>')
		queueStorageReads('asset.js', [
			{
				data: new TextEncoder().encode('stale warm javascript'),
				mimeType: 'text/javascript',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			{
				data: new TextEncoder().encode('wrong cold javascript'),
				mimeType: 'text/javascript',
				source: 'cold',
				customMetadata: { sourceCid: 'another-old-cid' },
			},
		])

		const response = await serveFileInternal(DID, RKEY, 'asset.js', {
			$type: 'place.wisp.settings',
			directoryListing: false,
			cleanUrls: false,
			spaMode: 'index.html',
		})

		expect(response.status).toBe(503)
		expect(await response.text()).not.toContain('SPA fallback')
		expect(storageGetWithMetadataKeys).not.toContain(`${DID}/${RKEY}/index.html`)
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:asset.js' }])
	})

	test('repairs a rewritten-only manifest entry that lacks an original source CID', async () => {
		siteFileCids = { '.rewritten/orphan.html': 'derived-cache-cid' }

		const response = await serveFromCacheWithRewrite(
			DID,
			RKEY,
			'orphan.html',
			'/did/site/',
			'https://sites.wisp.place/did/site/orphan.html',
		)

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(storageGetWithMetadataKeys).toHaveLength(0)
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:orphan.html' }])
	})

	test('fails closed when local-cache eviction fails', async () => {
		siteFileCids = { 'eviction-failure.txt': 'expected-cid' }
		evictPublicCacheKeyFailure = new Error('warm disk delete failed')
		queueStorageReads('eviction-failure.txt', [
			{
				data: new TextEncoder().encode('stale bytes'),
				mimeType: 'text/plain',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
		])

		const response = await serveFromCache(DID, RKEY, 'eviction-failure.txt', 'https://example.com/eviction-failure.txt')

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(await response.text()).not.toContain('stale bytes')
		expect(evictedPublicCacheKeys).toEqual([`${DID}/${RKEY}/eviction-failure.txt`])
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/eviction-failure.txt`)).toHaveLength(1)
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:eviction-failure.txt' }])
	})

	test('does not emit a matching 304 before source CID validation succeeds', async () => {
		siteFileCids = { 'conditional.txt': 'expected-cid' }
		queueStorageReads('conditional.txt', [
			{
				data: new TextEncoder().encode('stale warm bytes'),
				mimeType: 'text/plain',
				checksum: 'stale-validator',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			{
				data: new TextEncoder().encode('stale cold bytes'),
				mimeType: 'text/plain',
				checksum: 'stale-validator',
				source: 'cold',
				customMetadata: { sourceCid: 'another-old-cid' },
			},
		])

		const response = await serveFromCache(DID, RKEY, 'conditional.txt', 'https://example.com/conditional.txt', {
			'if-none-match': '"stale-validator"',
		})

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:conditional.txt' }])
	})

	test('never serves bytes whose warm and cold source CIDs both mismatch', async () => {
		siteFileCids = { 'mismatched.txt': 'expected-cid' }
		queueStorageReads('mismatched.txt', [
			{
				data: new TextEncoder().encode('warm stale bytes'),
				mimeType: 'text/plain',
				source: 'warm',
				customMetadata: { sourceCid: 'old-cid' },
			},
			{
				data: new TextEncoder().encode('cold wrong bytes'),
				mimeType: 'text/plain',
				source: 'cold',
				customMetadata: { sourceCid: 'another-old-cid' },
			},
		])

		const response = await serveFromCache(DID, RKEY, 'mismatched.txt', 'https://example.com/mismatched.txt')

		expect(response.status).toBe(503)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(await response.text()).not.toContain('wrong bytes')
		expect(evictedPublicCacheKeys).toEqual([`${DID}/${RKEY}/mismatched.txt`])
		expect(storageGetWithMetadataKeys.filter((key) => key === `${DID}/${RKEY}/mismatched.txt`)).toHaveLength(2)
		expect(revalidateCalls).toEqual([{ did: DID, rkey: RKEY, reason: 'storage-miss:mismatched.txt' }])
	})
})
