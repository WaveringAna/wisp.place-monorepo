import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { BlobRef } from '@atproto/api'
import * as atproto from '@wispplace/atproto-utils'
import { casKey, type FileObjects } from '@wispplace/fs-utils'
import type { Entry, Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import * as safeFetch from '@wispplace/safe-fetch'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { handleSiteCreateOrUpdate } from './cache-writer'
import { classifyLegacyFile } from './cas-migration'

// Site bodies are stored once, at a content-addressed key, and shared by every site that references
// them. Per-site state is only the manifest mapping and the pre-rewritten HTML.

const did = 'did:plc:root'
const recordCid = 'current-record'

type Stored = { data: Uint8Array; metadata: Record<string, string> }
const store = new Map<string, Stored>()
const siteRows = new Map<string, { file_cids: Record<string, string>; file_objects: unknown; cold_synced: boolean }>()
const bodies = new Map<string, Uint8Array>()
let blobsFetched: string[] = []
let writes: string[] = []
let deleted: string[] = []
let registered: Array<{ key: string; size: number }> = []
let touched: string[][] = []
let commits: Array<{ rkey: string; fileCids: Record<string, string>; fileObjects: FileObjects | null }> = []
let unreadable = new Set<string>()
let collected = new Set<string>()
const events: string[] = []

mock.module('@wispplace/atproto-utils', () => ({ ...atproto, getPdsForDid: async () => 'https://root.pds' }))
mock.module('@wispplace/safe-fetch', () => ({
	...safeFetch,
	safeFetch: async (url: string) => {
		const parsed = new URL(url)
		if (!parsed.pathname.endsWith('getBlob')) return new Response(null, { status: 404 })
		const cid = parsed.searchParams.get('cid') ?? ''
		blobsFetched.push(cid)
		const body = bodies.get(cid)
		return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response(null, { status: 404 })
	},
	safeFetchJson: async () => ({ value: undefined }),
}))
mock.module('./db', () => ({
	deleteSiteSettingsCache: async () => undefined,
	getSiteCache: async (_did: string, rkey: string) => siteRows.get(`${_did}/${rkey}`) ?? null,
	isSupporter: async () => false,
	markSiteCacheDeleted: async () => undefined,
	registerCasObject: async (key: string, size: number) => {
		registered.push({ key, size })
		events.push('register')
	},
	touchCasObjects: async (keys: string[]) => {
		touched.push([...keys])
		events.push('touch')
		return keys.filter((key) => !collected.has(key))
	},
	upsertSiteCache: async (
		_did: string,
		rkey: string,
		_recordCid: string,
		fileCids: Record<string, string>,
		_coldSynced?: boolean,
		fileObjects: FileObjects | null = null,
	) => {
		commits.push({ rkey, fileCids, fileObjects })
		siteRows.set(`${_did}/${rkey}`, { file_cids: fileCids, file_objects: fileObjects, cold_synced: true })
		events.push('commit')
	},
	upsertSiteSettingsCache: async () => undefined,
	withSiteWriteLock: async (_d: string, _r: string, op: (signal: AbortSignal) => Promise<unknown>) =>
		op(new AbortController().signal),
}))
mock.module('./storage', () => ({
	deleteFile: async (key: string) => {
		store.delete(key)
		deleted.push(key)
	},
	getFileMetadata: async (key: string) => {
		const entry = store.get(key)
		return entry ? { key, size: entry.data.length, customMetadata: entry.metadata } : null
	},
	readFile: async (key: string) => {
		if (unreadable.has(key)) throw new Error('storage unavailable')
		const entry = store.get(key)
		return entry
			? { data: entry.data, metadata: { key, size: entry.data.length, customMetadata: entry.metadata } }
			: null
	},
	listFiles: async () => [],
	writeFile: async (key: string, content: Uint8Array, metadata: Record<string, string> = {}) => {
		store.set(key, { data: content, metadata })
		writes.push(key)
		events.push('write')
	},
}))
mock.module('./cache-invalidation', () => ({
	publishCacheInvalidation: async () => undefined,
	publishCacheInvalidationStrict: async () => '1-0',
}))

type Spec = { name: string; content: string; mimeType?: string; gzip?: boolean; undeclared?: boolean }

async function fileEntry({
	name,
	content,
	mimeType = 'text/html',
	gzip = false,
	undeclared = false,
}: Spec): Promise<Entry> {
	const raw = new TextEncoder().encode(content)
	const bytes = gzip ? new Uint8Array(gzipSync(raw)) : raw
	const cid = CID.createV1(0x55, await sha256.digest(bytes))
	bodies.set(cid.toString(), bytes)
	return {
		name,
		node: {
			$type: 'place.wisp.fs#file',
			type: 'file',
			blob: new BlobRef(cid, mimeType, bytes.length),
			mimeType,
			...(gzip && !undeclared ? { encoding: 'gzip' as const } : {}),
		},
	}
}

async function recordOf(...specs: Spec[]): Promise<WispFsRecord> {
	return {
		$type: 'place.wisp.fs',
		site: 'site',
		createdAt: '2024-01-01T00:00:00.000Z',
		root: { type: 'directory', entries: await Promise.all(specs.map(fileEntry)) },
	}
}

const cidOf = (record: WispFsRecord, name: string): string => {
	const entry = record.root.entries.find((candidate) => candidate.name === name)
	const node = entry?.node as { blob: BlobRef }
	return node.blob.ref.toString()
}

const keyOf = (record: WispFsRecord, name: string, mimeType = 'text/html') =>
	casKey({ cid: cidOf(record, name), path: name, mimeType })

function update(
	rkey: string,
	record: WispFsRecord,
	options: Parameters<typeof handleSiteCreateOrUpdate>[4] = {},
	owner = did,
) {
	return handleSiteCreateOrUpdate(owner, rkey, record, recordCid, options, {
		fetchAuthoritativeSiteRecord: async () => ({ record, cid: recordCid }),
		withSiteWriteLock: async (_d, _r, operation) => operation(new AbortController().signal),
	})
}

const lastCommit = () => commits[commits.length - 1]
const bodyWrites = () => writes.filter((key) => key.startsWith('cas/'))
const rewrittenWrites = (rkey: string) => writes.filter((key) => key.startsWith(`${did}/${rkey}/.rewritten/`))

beforeEach(() => {
	store.clear()
	siteRows.clear()
	bodies.clear()
	blobsFetched = []
	writes = []
	deleted = []
	registered = []
	touched = []
	commits = []
	unreadable = new Set()
	collected = new Set()
	events.length = 0
})

describe('CAS cache writer', () => {
	test('stores each body once at its CAS key, rewritten HTML per site, and commits the mapping', async () => {
		const record = await recordOf(
			{ name: 'index.html', content: '<h1>home</h1>' },
			{ name: 'style.css', content: 'body{}', mimeType: 'text/css' },
		)

		await update('site-a', record)

		const indexKey = keyOf(record, 'index.html')
		const styleKey = keyOf(record, 'style.css', 'text/css')
		expect(bodyWrites().sort()).toEqual([indexKey, styleKey].sort())
		expect(writes.filter((key) => key.startsWith(`${did}/site-a/`) && !key.includes('/.rewritten/'))).toEqual([])
		expect(rewrittenWrites('site-a')).toEqual([`${did}/site-a/.rewritten/index.html`])
		expect(commits).toHaveLength(1)
		expect(commits[0]?.fileObjects).toEqual({ 'index.html': indexKey, 'style.css': styleKey })
		expect(registered.map((r) => r.key).sort()).toEqual([indexKey, styleKey].sort())
	})

	test('a second site with identical files fetches no blobs and writes no bodies', async () => {
		const record = await recordOf(
			{ name: 'index.html', content: '<h1>home</h1>' },
			{ name: 'style.css', content: 'body{}', mimeType: 'text/css' },
		)
		await update('site-a', record)
		blobsFetched = []
		writes = []
		registered = []

		await update('site-b', record)

		expect(blobsFetched).toEqual([])
		expect(bodyWrites()).toEqual([])
		expect(registered).toEqual([])
		// Pre-rewritten HTML embeds the site's own path prefix, so the new site still gets its own copy,
		// built from the stored body rather than from the PDS.
		expect(rewrittenWrites('site-b')).toEqual([`${did}/site-b/.rewritten/index.html`])
		const rewritten = new TextDecoder().decode(store.get(`${did}/site-b/.rewritten/index.html`)?.data)
		expect(rewritten).toContain('home')
		expect(lastCommit()?.fileObjects).toEqual({
			'index.html': keyOf(record, 'index.html'),
			'style.css': keyOf(record, 'style.css', 'text/css'),
		})
	})

	test('another account referencing the same blob reuses the body instead of fetching it', async () => {
		const record = await recordOf({ name: 'index.html', content: '<h1>shared</h1>' })
		await update('site-a', record)
		blobsFetched = []
		writes = []

		await update('site-a', record, {}, 'did:plc:someone-else')

		expect(blobsFetched).toEqual([])
		expect(bodyWrites()).toEqual([])
		expect(lastCommit()?.fileObjects).toEqual({ 'index.html': keyOf(record, 'index.html') })
	})

	test('an update fetches and writes only the file that changed', async () => {
		const first = await recordOf(
			{ name: 'index.html', content: '<h1>v1</h1>' },
			{ name: 'app.js', content: 'console.log(1)', mimeType: 'text/javascript' },
		)
		await update('site-a', first)
		blobsFetched = []
		writes = []

		const second = await recordOf(
			{ name: 'index.html', content: '<h1>v1</h1>' },
			{ name: 'app.js', content: 'console.log(2)', mimeType: 'text/javascript' },
		)
		await update('site-a', second)

		expect(blobsFetched).toEqual([cidOf(second, 'app.js')])
		expect(bodyWrites()).toEqual([keyOf(second, 'app.js', 'text/javascript')])
		expect(rewrittenWrites('site-a')).toEqual([])
	})

	test('one blob referenced with different flags is stored as two objects, each served as declared', async () => {
		const plain = await recordOf({ name: 'data.txt', content: 'hello', mimeType: 'text/plain' })
		const asJson = await recordOf({ name: 'data.txt', content: 'hello', mimeType: 'application/json' })
		expect(cidOf(plain, 'data.txt')).toBe(cidOf(asJson, 'data.txt'))

		await update('site-a', plain)
		await update('site-b', asJson)

		const keyA = keyOf(plain, 'data.txt', 'text/plain')
		const keyB = keyOf(asJson, 'data.txt', 'application/json')
		expect(keyA).not.toBe(keyB)
		expect(store.get(keyA)?.metadata.mimeType).toBe('text/plain')
		expect(store.get(keyB)?.metadata.mimeType).toBe('application/json')
	})

	test('a removed path loses its per-site rewritten HTML but never its shared body', async () => {
		const first = await recordOf(
			{ name: 'index.html', content: '<h1>home</h1>' },
			{ name: 'old.html', content: '<h1>old</h1>' },
		)
		await update('site-a', first)
		const oldKey = keyOf(first, 'old.html')

		const second = await recordOf({ name: 'index.html', content: '<h1>home</h1>' })
		await update('site-a', second)

		expect(deleted).toEqual([`${did}/site-a/.rewritten/old.html`])
		expect(store.has(oldKey)).toBe(true)
		expect(lastCommit()?.fileObjects).toEqual({ 'index.html': keyOf(second, 'index.html') })
	})

	test('registers a body before writing it, so the collector never sees an object without a fresh row', async () => {
		const record = await recordOf({ name: 'style.css', content: 'body{}', mimeType: 'text/css' })

		await update('site-a', record)

		expect(events.indexOf('register')).toBeGreaterThanOrEqual(0)
		expect(events.indexOf('register')).toBeLessThan(events.indexOf('write'))
	})

	test('fetches a reused body again when it was collected after it was found', async () => {
		const record = await recordOf({ name: 'index.html', content: '<h1>home</h1>' })
		await update('site-a', record)
		collected = new Set([keyOf(record, 'index.html')])
		blobsFetched = []
		writes = []

		await update('site-b', record)

		expect(blobsFetched).toEqual([cidOf(record, 'index.html')])
		expect(bodyWrites()).toEqual([keyOf(record, 'index.html')])
		expect(rewrittenWrites('site-b')).toEqual([`${did}/site-b/.rewritten/index.html`])
		expect(lastCommit()?.fileObjects).toEqual({ 'index.html': keyOf(record, 'index.html') })
	})

	test('registers new bodies and touches reused ones before the mapping commits', async () => {
		const record = await recordOf({ name: 'index.html', content: '<h1>home</h1>' })
		await update('site-a', record)
		expect(events.indexOf('register')).toBeLessThan(events.indexOf('commit'))

		events.length = 0
		await update('site-b', record)

		expect(touched).toEqual([[keyOf(record, 'index.html')]])
		expect(events.indexOf('touch')).toBeLessThan(events.indexOf('commit'))
	})

	test('a forced repair refetches and rewrites bodies even though they exist', async () => {
		const record = await recordOf({ name: 'index.html', content: '<h1>home</h1>' })
		await update('site-a', record)
		blobsFetched = []
		writes = []

		await update('site-a', record, { forceDownload: true })

		expect(blobsFetched).toEqual([cidOf(record, 'index.html')])
		expect(bodyWrites()).toEqual([keyOf(record, 'index.html')])
	})

	test('repairs an unconverted site with null file_objects under forceDownload', async () => {
		const record = await recordOf(
			{ name: 'index.html', content: '<h1>unconverted</h1>' },
			{ name: 'app.css', content: 'body{}', mimeType: 'text/css' },
		)
		const indexCid = cidOf(record, 'index.html')
		const cssCid = cidOf(record, 'app.css')
		siteRows.set(`${did}/unconverted`, {
			file_cids: { 'index.html': indexCid, 'app.css': cssCid },
			file_objects: null,
			cold_synced: false,
		})

		await update('unconverted', record, { forceDownload: true })

		const indexKey = keyOf(record, 'index.html')
		const cssKey = keyOf(record, 'app.css', 'text/css')
		expect(bodyWrites().sort()).toEqual([indexKey, cssKey].sort())
		expect(touched).toEqual([])
		expect(lastCommit()?.fileObjects).toEqual({ 'index.html': indexKey, 'app.css': cssKey })
		expect(registered.map((r) => r.key).sort()).toEqual([indexKey, cssKey].sort())
	})

	test('blob download failure during repair does not commit mapping or partial state', async () => {
		const record = await recordOf({ name: 'missing.bin', content: 'lost' })
		const missingCid = cidOf(record, 'missing.bin')
		bodies.delete(missingCid) // safeFetch will 404
		siteRows.set(`${did}/unconverted`, {
			file_cids: { 'missing.bin': missingCid },
			file_objects: null,
			cold_synced: false,
		})

		await expect(update('unconverted', record, { forceDownload: true })).rejects.toThrow()
		expect(commits).toHaveLength(0)
		expect(siteRows.get(`${did}/unconverted`)?.file_objects).toBeNull()
	})

	test('a stored body with unusable accounting metadata is fetched again instead of trusted', async () => {
		const record = await recordOf({ name: 'index.html', content: '<h1>home</h1>' })
		await update('site-a', record)
		const key = keyOf(record, 'index.html')
		const stored = store.get(key) as Stored
		store.set(key, { data: stored.data, metadata: { ...stored.metadata, uncompressedSize: 'not-a-number' } })
		blobsFetched = []

		await update('site-b', record)

		expect(blobsFetched).toEqual([cidOf(record, 'index.html')])
	})

	test('reuses a stored gzip body for another site and rewrites its HTML from the decompressed text', async () => {
		const record = await recordOf({ name: 'index.html', content: '<h1>zipped home</h1>', gzip: true })
		await update('site-a', record)
		blobsFetched = []
		writes = []

		await update('site-b', record)

		expect(blobsFetched).toEqual([])
		expect(bodyWrites()).toEqual([])
		const rewritten = new TextDecoder().decode(store.get(`${did}/site-b/.rewritten/index.html`)?.data)
		expect(rewritten).toContain('zipped home')
	})

	test('falls back to the PDS when a reusable body cannot be read for the HTML rewrite', async () => {
		const record = await recordOf({ name: 'index.html', content: '<h1>home</h1>' })
		await update('site-a', record)
		unreadable = new Set([keyOf(record, 'index.html')])
		blobsFetched = []

		await update('site-b', record)

		expect(blobsFetched).toEqual([cidOf(record, 'index.html')])
		expect(rewrittenWrites('site-b')).toEqual([`${did}/site-b/.rewritten/index.html`])
	})

	test('does not commit when a download fails, so the mapping never points at a missing body', async () => {
		const record = await recordOf({ name: 'index.html', content: '<h1>home</h1>' })
		bodies.clear()

		await expect(update('site-a', record)).rejects.toThrow()

		expect(commits).toEqual([])
	})
})

describe('migration classifier parity', () => {
	// The migrator re-keys legacy objects from their metadata alone. For every kind of file the current
	// writer produces, that inversion must land on the writer's own key (or decline), never a different one.
	async function writtenBody(spec: Spec) {
		const record = await recordOf(spec)
		await update('parity', record)
		const writerKey = bodyWrites()[0] as string
		const stored = store.get(writerKey) as Stored
		const metadata = {
			key: 'legacy',
			size: stored.data.byteLength,
			createdAt: new Date(),
			lastAccessed: new Date(),
			accessCount: 0,
			compressed: false,
			checksum: 'x',
			customMetadata: { ...stored.metadata, sourceDid: did },
		}
		return {
			record,
			writerKey,
			stored,
			classification: classifyLegacyFile({ path: spec.name, cid: cidOf(record, spec.name) }, metadata),
		}
	}

	const matching: Array<[string, Spec]> = [
		['declared gzip html', { name: 'index.html', content: '<h1>x</h1>', gzip: true }],
		['identity css', { name: 'a.css', content: 'body{}', mimeType: 'text/css' }],
		['identity png bytes', { name: 'logo.png', content: 'not really a png', mimeType: 'image/png' }],
		['identity _redirects', { name: '_redirects', content: '/a /b 301', mimeType: 'text/plain' }],
	]

	test.each(matching)('%s keeps the writer key', async (_name, spec) => {
		const { writerKey, stored, record, classification } = await writtenBody(spec)

		expect(classification.kind === 'ready' || classification.kind === 'needs-raw-check').toBe(true)
		if (classification.kind === 'skip') return
		expect(classification.key).toBe(writerKey)
		if (classification.kind === 'needs-raw-check') {
			// The bytes are the blob itself, which is exactly what the raw check accepts.
			expect(new TextDecoder().decode(stored.data)).toBe(spec.content)
			expect(cidOf(record, spec.name)).toBe((await import('@wispplace/atproto-utils')).computeCID(stored.data))
		}
	})

	const declined: Array<[string, Spec]> = [
		[
			'a gzip manifest entry the writer decompressed (forced gzip on an image)',
			{ name: 'logo.png', content: 'pixels', mimeType: 'image/png', gzip: true },
		],
		[
			'a gzip _redirects the writer decompressed',
			{ name: '_redirects', content: '/a /b 301', mimeType: 'text/plain', gzip: true },
		],
	]

	test.each(declined)('%s is declined, not mis-keyed', async (_name, spec) => {
		const { stored, record, classification } = await writtenBody(spec)

		// The stored bytes are not the blob, so the raw check rejects them and the site is repulled.
		expect(classification.kind).toBe('needs-raw-check')
		expect((await import('@wispplace/atproto-utils')).computeCID(stored.data)).not.toBe(cidOf(record, spec.name))
	})
})
