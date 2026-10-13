import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { BlobRef } from '@atproto/api'
import { casKey } from '@wispplace/fs-utils'
import type { Entry, Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { handleSiteCreateOrUpdate, type SiteMaterializerDependencies, verifySiteBlobs } from './cache-writer'
import {
	allowLoopbackFetch,
	type BlobRequest,
	createMemorySiteObjectStore,
	type LocalPds,
	recordNotFound,
	startLocalPds,
} from './local-pds.fixture'
import { createRevalidationResourceContext } from './revalidate-resources'
import { fingerprintSiteManifest } from './site-repair-protocol'
import type { SiteObjectStore } from './storage'

const did = 'did:plc:root'
const recordCid = 'current-record'
const bytes = Buffer.from('<html>good</html>')
let record: WispFsRecord
let blobCid: string
let body: Uint8Array | null = bytes
let status = 200
let strictFailure = false
let rewriteFailure = false
let quotaAdmission: (signal?: AbortSignal) => Promise<boolean> = async () => false
let oldLedger: Record<string, string> = {}
let store: SiteObjectStore
let blobsFetched: BlobRequest[] = []
let writes: Array<{ key: string; bytes: Uint8Array }> = []
let deleted: string[] = []
let commits = 0
let strictPublications = 0
let subfsRecord: unknown
const events: string[] = []

// Both PDSes answer from the same per-test state; which one served a blob is
// visible in its origin.
function respond(url: URL, origin: string): Response {
	if (url.pathname === '/xrpc/com.atproto.sync.getBlob') {
		blobsFetched.push({ did: url.searchParams.get('did'), cid: url.searchParams.get('cid'), pds: origin })
		return new Response(body === null ? null : new Uint8Array(body), { status })
	}
	if (
		url.pathname === '/xrpc/com.atproto.repo.getRecord' &&
		url.searchParams.get('collection') === 'place.wisp.subfs'
	) {
		return Response.json({ uri: `at://${url.searchParams.get('repo')}`, cid: 'subfs-cid', value: subfsRecord })
	}
	return recordNotFound()
}

let rootPds: LocalPds
let subPds: LocalPds
let restoreLoopbackFetch: () => void

beforeAll(() => {
	restoreLoopbackFetch = allowLoopbackFetch()
	rootPds = startLocalPds(respond)
	subPds = startLocalPds(respond)
})

afterAll(async () => {
	await Promise.all([rootPds.stop(), subPds.stop()])
	restoreLoopbackFetch()
})

function dependencies(): SiteMaterializerDependencies {
	return {
		getFileMetadata: store.getFileMetadata,
		readFile: store.readFile,
		writeFile: async (key, content, metadata) => {
			if (rewriteFailure && key.includes('/.rewritten/')) throw new Error('rewrite storage unavailable')
			await store.writeFile(key, content, metadata)
			writes.push({ key, bytes: content })
			events.push('write')
		},
		deleteFile: async (key) => {
			await store.deleteFile(key)
			deleted.push(key)
		},
		getSiteCache: async () => ({ cold_synced: true, file_cids: oldLedger, file_objects: null }),
		isSupporter: async (_did, signal) => quotaAdmission(signal),
		registerCasObject: async () => undefined,
		touchCasObjects: async (keys) => [...keys],
		upsertSiteCache: async () => {
			commits++
			events.push('commit')
		},
		upsertSiteSettingsCache: async () => undefined,
		publishCacheInvalidation: async () => undefined,
		publishCacheInvalidationStrict: async () => {
			strictPublications++
			events.push('publish')
			if (strictFailure) throw new Error('redis unavailable')
			return '123-0'
		},
		resolvePdsEndpoint: async (source) => (source === did ? rootPds.url : subPds.url),
		allowLocalhostPds: true,
	}
}

const stored = async (key: string) => (await store.readFile(key))?.data

async function fileEntry(name: string, content = bytes): Promise<Entry> {
	const cid = CID.createV1(0x55, await sha256.digest(content))
	return {
		name,
		node: {
			$type: 'place.wisp.fs#file',
			type: 'file',
			blob: new BlobRef(cid, 'text/html', content.length),
			mimeType: 'text/html',
		},
	}
}

beforeEach(async () => {
	blobCid = CID.createV1(0x55, await sha256.digest(bytes)).toString()
	record = {
		$type: 'place.wisp.fs',
		site: 'site',
		createdAt: '2024-01-01T00:00:00.000Z',
		root: { type: 'directory', entries: [await fileEntry('index.html')] },
	}
	body = bytes
	status = 200
	strictFailure = false
	rewriteFailure = false
	quotaAdmission = async () => false
	oldLedger = { 'index.html': blobCid, 'old.txt': 'old' }
	store = createMemorySiteObjectStore()
	blobsFetched = []
	writes = []
	deleted = []
	commits = 0
	strictPublications = 0
	events.length = 0
})

function update(options: Parameters<typeof handleSiteCreateOrUpdate>[4] = {}) {
	return handleSiteCreateOrUpdate(did, 'site', record, recordCid, options, {
		fetchAuthoritativeSiteRecord: async () => ({ record, cid: recordCid }),
		withSiteWriteLock: async (_did, _rkey, operation) => operation(new AbortController().signal),
		materializer: dependencies(),
	})
}

describe('verified cache materialization', () => {
	for (const failure of ['missing', 'empty', 'corrupt'])
		test(`retries ${failure} once without overwriting originals/rewrites or deleting recoverable files`, async () => {
			if (failure === 'missing') status = 404
			if (failure === 'empty') body = null
			if (failure === 'corrupt') body = Buffer.alloc(bytes.length, 'x')
			await expect(update({ forceDownload: true })).rejects.toMatchObject({
				name: 'BlobIntegrityError',
				details: { pds: rootPds.url, recordCid, path: 'index.html', blobCid, expectedSize: bytes.length },
			})
			expect(blobsFetched).toHaveLength(2)
			expect(writes).toEqual([])
			expect(deleted).toEqual([])
			expect(commits).toBe(0)
		})

	test('preflight verifies subfs blobs at the owning PDS without cache mutation', async () => {
		record.root.entries = [
			{
				name: 'mounted',
				node: { $type: 'place.wisp.fs#subfs', type: 'subfs', subject: 'at://did:plc:other/place.wisp.subfs/files' },
			},
		]
		subfsRecord = {
			$type: 'place.wisp.subfs',
			root: { type: 'directory', entries: [await fileEntry('index.html')] },
			createdAt: '2024-01-01T00:00:00.000Z',
		}
		const result = await verifySiteBlobs(did, 'site', record, recordCid, undefined, dependencies())
		expect(result).toMatchObject({ recordCid, fileCount: 1, totalBytes: bytes.length })
		expect(blobsFetched).toEqual([{ did: 'did:plc:other', cid: blobCid, pds: subPds.url }])
		expect(writes).toEqual([])
		expect(commits).toBe(0)
	})

	test('hashes encoded base64+gzip bytes before producing decoded HTML', async () => {
		const encoded = Buffer.from(gzipSync(bytes).toString('base64'))
		const entry = await fileEntry('index.html', encoded)
		if (!('type' in entry.node && entry.node.type === 'file')) throw new Error('expected file')
		entry.node.base64 = true
		entry.node.encoding = 'gzip'
		record.root.entries = [entry]
		body = encoded
		await update({ forceDownload: true })
		expect(writes).toHaveLength(2)
		expect(commits).toBe(1)
	})

	test('same-CID repair downloads every blob and reports proof only after strict publication', async () => {
		const preflight = await verifySiteBlobs(did, 'site', record, recordCid, undefined, dependencies())
		blobsFetched = []
		await update({
			verifiedRepair: { token: 'token', ...preflight },
			onVerifiedRepairComplete: async (proof) => {
				expect(proof).toMatchObject({
					recordCid,
					manifestFingerprint: preflight.manifestFingerprint,
					invalidationStreamId: '123-0',
				})
				events.push('proof')
			},
		})
		expect(blobsFetched).toHaveLength(1)
		expect(events).toEqual(['write', 'write', 'commit', 'publish', 'proof'])
	})

	test('rejects original/derived collisions in both preflight and locked repair before mutation', async () => {
		record.root.entries.push({
			name: '.rewritten',
			node: { $type: 'place.wisp.fs#directory', type: 'directory', entries: [await fileEntry('index.html')] },
		})
		await expect(verifySiteBlobs(did, 'site', record, recordCid, undefined, dependencies())).rejects.toThrow(
			'overlapping original and derived paths',
		)
		const verifiedRepair = {
			token: 'token',
			recordCid,
			manifestFingerprint: fingerprintSiteManifest(
				recordCid,
				record.root,
				new Map([
					['index.html', did],
					['.rewritten/index.html', did],
				]),
			),
		}
		await expect(update({ verifiedRepair })).rejects.toThrow('overlapping original and derived paths')
		expect(blobsFetched).toEqual([])
		expect(writes).toEqual([])
		expect(deleted).toEqual([])
	})

	test('does not delete a new derived output because it was an old original ledger path', async () => {
		oldLedger['.rewritten/index.html'] = 'old-raw-cid'
		const preflight = await verifySiteBlobs(did, 'site', record, recordCid, undefined, dependencies())
		await update({ verifiedRepair: { token: 'token', ...preflight } })
		const derived = `${did}/site/.rewritten/index.html`
		expect(deleted).not.toContain(derived)
		expect(await stored(derived)).toEqual(bytes)
	})

	test('removes MIME-only HTML variants rather than reporting a stale .shtml repair', async () => {
		record.root.entries = [await fileEntry('page.shtml')]
		const key = `${did}/site/.rewritten/page.shtml`
		await store.writeFile(key, Buffer.from('stale rewritten html'))
		const verifiedRepair = {
			token: 'token',
			recordCid,
			manifestFingerprint: fingerprintSiteManifest(recordCid, record.root, new Map([['page.shtml', did]])),
		}
		await update({
			verifiedRepair,
			onVerifiedRepairComplete: async () => {
				expect(await store.readFile(key)).toBeNull()
				expect(await stored(casKey({ cid: blobCid, path: 'page.shtml', mimeType: 'text/html' }))).toEqual(bytes)
			},
		})
		expect(deleted).toContain(key)
		expect(strictPublications).toBe(1)
	})

	test('cancels preflight quota admission before any blob download', async () => {
		const resources = createRevalidationResourceContext(10, 1024)
		quotaAdmission = (signal) =>
			new Promise((_resolve, reject) => {
				expect(signal).toBe(resources.signal)
				signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
		try {
			await expect(verifySiteBlobs(did, 'site', record, recordCid, resources, dependencies())).rejects.toMatchObject({
				name: 'RevalidationDeadlineError',
			})
			expect(blobsFetched).toEqual([])
			expect(writes).toEqual([])
		} finally {
			resources.close()
		}
	})

	test('does not report repair while a stale rewritten object survives a failed replacement', async () => {
		const key = `${did}/site/.rewritten/index.html`
		const stale = Buffer.from('corrupted rewritten html')
		await store.writeFile(key, stale)
		rewriteFailure = true
		const verifiedRepair = {
			token: 'token',
			recordCid,
			manifestFingerprint: fingerprintSiteManifest(recordCid, record.root, new Map([['index.html', did]])),
		}
		let proofs = 0
		await expect(
			update({
				verifiedRepair,
				onVerifiedRepairComplete: async () => {
					proofs++
				},
			}),
		).rejects.toThrow('Failed to download files')
		expect(blobsFetched).toHaveLength(2)
		expect(await stored(key)).toEqual(stale)
		expect(proofs).toBe(0)
		expect(commits).toBe(0)
		expect(strictPublications).toBe(0)
	})

	test('never reports proof on changed manifest or failed strict publication', async () => {
		const verifiedRepair = {
			token: 'token',
			recordCid,
			manifestFingerprint: fingerprintSiteManifest(recordCid, record.root, new Map([['index.html', did]])),
		}
		let proofs = 0
		const options = {
			verifiedRepair,
			onVerifiedRepairComplete: async () => {
				proofs++
			},
		}
		await expect(
			update({ ...options, verifiedRepair: { ...verifiedRepair, manifestFingerprint: 'changed' } }),
		).rejects.toThrow('source changed')
		expect(writes).toEqual([])
		strictFailure = true
		await expect(update(options)).rejects.toThrow('redis unavailable')
		expect(strictPublications).toBe(1)
		expect(proofs).toBe(0)
	})
})
