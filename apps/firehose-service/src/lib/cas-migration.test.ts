import { beforeEach, describe, expect, test } from 'bun:test'
import { computeCID } from '@wispplace/atproto-utils'
import { casKey, type FileObjects } from '@wispplace/fs-utils'
import type { StorageMetadata } from '@wispplace/tiered-storage'
import {
	classifyLegacyFile,
	deleteLegacyObjects,
	type MigrationPorts,
	migrateSite,
	type SiteToMigrate,
	type SkipReason,
} from './cas-migration'

// One-shot conversion of {did}/{rkey}/{path} objects to CAS keys. It must reproduce exactly the key the
// cache writer derives from the manifest, copy inside storage, and never guess: anything it cannot
// classify from the object's own metadata is skipped and left for a normal repull from the PDS.

const DID = 'did:plc:alice'
const body = new TextEncoder().encode('body { color: red }')
const bodyCid = computeCID(body)
const otherCid = computeCID(new TextEncoder().encode('something else'))

type Custom = Record<string, string | undefined>

function legacyMetadata(custom: Custom | null, overrides: Partial<StorageMetadata> = {}): StorageMetadata {
	return {
		key: 'legacy',
		size: 19,
		createdAt: new Date('2024-01-01T00:00:00Z'),
		lastAccessed: new Date('2024-01-02T00:00:00Z'),
		accessCount: 3,
		compressed: false,
		checksum: 'sum-1',
		...(custom
			? {
					customMetadata: Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== undefined)) as Record<
						string,
						string
					>,
				}
			: {}),
		...overrides,
	}
}

const goodCustom = (extra: Custom = {}): Custom => ({
	sourceCid: bodyCid,
	sourceDid: DID,
	mimeType: 'text/css',
	base64: 'false',
	uncompressedSize: '19',
	...extra,
})

describe('classifyLegacyFile', () => {
	test('re-keys a gzip text file to the key the writer derives from a gzip manifest entry', () => {
		const result = classifyLegacyFile({ path: 'a.css', cid: bodyCid }, legacyMetadata(goodCustom({ encoding: 'gzip' })))

		expect(result).toMatchObject({
			kind: 'ready',
			key: casKey({ cid: bodyCid, path: 'a.css', mimeType: 'text/css', encoding: 'gzip', base64: false }),
		})
	})

	test('re-keys an identity file under a compressible type, which no gzip manifest could have produced', () => {
		const result = classifyLegacyFile({ path: 'a.css', cid: bodyCid }, legacyMetadata(goodCustom()))

		expect(result).toMatchObject({ kind: 'ready', key: casKey({ cid: bodyCid, path: 'a.css', mimeType: 'text/css' }) })
	})

	test('an identity file under a non-compressible type is ambiguous without the bytes', () => {
		const result = classifyLegacyFile(
			{ path: 'logo.png', cid: bodyCid },
			legacyMetadata(goodCustom({ mimeType: 'image/png' })),
		)

		expect(result.kind).toBe('needs-raw-check')
	})

	test('_redirects is stored decompressed even for a gzip manifest, so an identity one is ambiguous', () => {
		expect(
			classifyLegacyFile({ path: '_redirects', cid: bodyCid }, legacyMetadata(goodCustom({ mimeType: 'text/plain' })))
				.kind,
		).toBe('needs-raw-check')
	})

	test('keeps the base64 flag in the key', () => {
		const result = classifyLegacyFile({ path: 'a.css', cid: bodyCid }, legacyMetadata(goodCustom({ base64: 'true' })))

		expect(result).toMatchObject({
			kind: 'ready',
			key: casKey({ cid: bodyCid, path: 'a.css', mimeType: 'text/css', base64: true }),
		})
	})

	test('accepts a file with no mime type and keys it as such', () => {
		const result = classifyLegacyFile(
			{ path: 'data', cid: bodyCid },
			legacyMetadata(goodCustom({ mimeType: undefined })),
		)

		expect(result.kind === 'ready' || result.kind === 'needs-raw-check').toBe(true)
	})

	const skipCases: Array<[string, StorageMetadata | null, SkipReason]> = [
		['no object', null, 'missing-object'],
		['no custom metadata', legacyMetadata(null), 'no-source-cid'],
		[
			'no source CID (written before source CIDs were recorded)',
			legacyMetadata(goodCustom({ sourceCid: undefined })),
			'no-source-cid',
		],
		['a different source CID than the manifest', legacyMetadata(goodCustom({ sourceCid: otherCid })), 'cid-mismatch'],
		['a non-numeric logical size', legacyMetadata(goodCustom({ uncompressedSize: 'many' })), 'bad-metadata'],
		['a missing logical size', legacyMetadata(goodCustom({ uncompressedSize: undefined })), 'bad-metadata'],
		['a missing base64 flag', legacyMetadata(goodCustom({ base64: undefined })), 'bad-metadata'],
		['an unknown base64 flag', legacyMetadata(goodCustom({ base64: 'maybe' })), 'bad-metadata'],
		['an encoding other than gzip', legacyMetadata(goodCustom({ encoding: 'br' })), 'bad-metadata'],
		[
			'gzip content nothing could have made gzip',
			legacyMetadata(goodCustom({ mimeType: 'image/png', encoding: 'gzip' })),
			'bad-metadata',
		],
	]
	test.each(skipCases)('skips %s', (_name, metadata, reason) => {
		const result = classifyLegacyFile(
			{ path: _name.includes('gzip content') ? 'logo.png' : 'a.css', cid: bodyCid },
			metadata,
		)

		expect(result).toEqual({ kind: 'skip', reason })
	})
})

class FakeStorage {
	objects = new Map<string, { data: Uint8Array; metadata: StorageMetadata }>()
	copies: Array<{ from: string; to: string; metadata: StorageMetadata; expectedChecksum: string }> = []
	registered: Array<{ key: string; size: number }> = []
	commits: Array<{ did: string; rkey: string; mapping: FileObjects }> = []
	deleted: string[] = []
	commitResult: 'committed' | 'stale' = 'committed'
	failCopyOf = new Set<string>()

	put(key: string, data: Uint8Array, custom: Custom | null, overrides: Partial<StorageMetadata> = {}) {
		this.objects.set(key, { data, metadata: legacyMetadata(custom, { key, size: data.byteLength, ...overrides }) })
	}

	ports(): MigrationPorts {
		return {
			getMetadata: async (key) => this.objects.get(key)?.metadata ?? null,
			readObject: async (key) => this.objects.get(key)?.data ?? null,
			copyObject: async (from, to, metadata, expectedChecksum) => {
				const source = this.objects.get(from)
				if (!source || this.failCopyOf.has(from) || source.metadata.checksum !== expectedChecksum) return false
				this.copies.push({ from, to, metadata, expectedChecksum })
				this.objects.set(to, { data: source.data, metadata })
				return true
			},
			registerObject: async (key, size) => {
				this.registered.push({ key, size })
			},
			commitMapping: async (did, rkey, _expected, mapping) => {
				this.commits.push({ did, rkey, mapping })
				return this.commitResult
			},
			deleteObject: async (key) => {
				this.deleted.push(key)
				this.objects.delete(key)
			},
			listLegacyKeys: async (prefix) => [...this.objects.keys()].filter((key) => key.startsWith(prefix)),
		}
	}
}

const site = (rkey: string, fileCids: Record<string, string>): SiteToMigrate => ({
	did: DID,
	rkey,
	fileCids,
	fileObjects: null,
	recordCid: 'cid',
	updatedAt: 1000,
})
let storage: FakeStorage

beforeEach(() => {
	storage = new FakeStorage()
})

describe('migrateSite', () => {
	test('copies each legacy object to its CAS key with metadata rewritten for the new key', async () => {
		storage.put(`${DID}/blog/a.css`, body, goodCustom({ encoding: 'gzip' }))

		const report = await migrateSite(site('blog', { 'a.css': bodyCid }), storage.ports(), { dryRun: false })

		const key = casKey({ cid: bodyCid, path: 'a.css', mimeType: 'text/css', encoding: 'gzip', base64: false })
		expect(report).toMatchObject({ status: 'migrated', copied: 1, reused: 0 })
		expect(storage.copies).toHaveLength(1)
		const copy = storage.copies[0]
		expect(copy?.from).toBe(`${DID}/blog/a.css`)
		expect(copy?.to).toBe(key)
		expect(copy?.expectedChecksum).toBe('sum-1')
		// The stored metadata embeds its own key, so a copy must not keep the legacy one.
		expect(copy?.metadata.key).toBe(key)
		expect(copy?.metadata.checksum).toBe('sum-1')
		expect(copy?.metadata.customMetadata).toEqual({
			sourceCid: bodyCid,
			mimeType: 'text/css',
			encoding: 'gzip',
			base64: 'false',
			uncompressedSize: '19',
		})
		expect(storage.registered).toEqual([{ key, size: 19 }])
		expect(storage.commits).toEqual([{ did: DID, rkey: 'blog', mapping: { 'a.css': key } }])
	})

	test('leaves the legacy object in place', async () => {
		storage.put(`${DID}/blog/a.css`, body, goodCustom())

		await migrateSite(site('blog', { 'a.css': bodyCid }), storage.ports(), { dryRun: false })

		expect(storage.objects.has(`${DID}/blog/a.css`)).toBe(true)
		expect(storage.deleted).toEqual([])
	})

	test('reuses a body another site already migrated instead of copying again', async () => {
		storage.put(`${DID}/one/a.css`, body, goodCustom())
		storage.put(`${DID}/two/a.css`, body, goodCustom())

		await migrateSite(site('one', { 'a.css': bodyCid }), storage.ports(), { dryRun: false })
		const second = await migrateSite(site('two', { 'a.css': bodyCid }), storage.ports(), { dryRun: false })

		expect(second).toMatchObject({ status: 'migrated', copied: 0, reused: 1 })
		expect(storage.copies).toHaveLength(1)
		expect(storage.commits).toHaveLength(2)
	})

	test('a rerun is a no-op copy-wise and commits the same mapping', async () => {
		storage.put(`${DID}/blog/a.css`, body, goodCustom())

		await migrateSite(site('blog', { 'a.css': bodyCid }), storage.ports(), { dryRun: false })
		const again = await migrateSite(site('blog', { 'a.css': bodyCid }), storage.ports(), { dryRun: false })

		expect(again).toMatchObject({ copied: 0, reused: 1 })
		expect(storage.copies).toHaveLength(1)
		expect(storage.commits[1]?.mapping).toEqual(storage.commits[0]?.mapping)
	})

	test('skips files it cannot trust and still maps the rest, reporting them as a partial site', async () => {
		storage.put(`${DID}/blog/a.css`, body, goodCustom())
		storage.put(`${DID}/blog/old.css`, body, goodCustom({ sourceCid: undefined }))

		const report = await migrateSite(
			site('blog', { 'a.css': bodyCid, 'old.css': bodyCid, 'gone.css': bodyCid }),
			storage.ports(),
			{ dryRun: false },
		)

		expect(report.status).toBe('partial')
		expect(report.copied).toBe(1)
		expect(report.skipped).toMatchObject({ 'no-source-cid': 1, 'missing-object': 1 })
		expect(Object.keys(storage.commits[0]?.mapping ?? {})).toEqual(['a.css'])
	})

	test('does not map a file whose source changed while it was being copied', async () => {
		storage.put(`${DID}/blog/a.css`, body, goodCustom())
		storage.failCopyOf.add(`${DID}/blog/a.css`)

		const report = await migrateSite(site('blog', { 'a.css': bodyCid }), storage.ports(), { dryRun: false })

		expect(report.skipped['changed-during-copy']).toBe(1)
		expect(report.copied).toBe(0)
		expect(storage.commits).toEqual([])
	})

	test('reports a stale site when its row changed under the migration', async () => {
		storage.put(`${DID}/blog/a.css`, body, goodCustom())
		storage.commitResult = 'stale'

		const report = await migrateSite(site('blog', { 'a.css': bodyCid }), storage.ports(), { dryRun: false })

		expect(report.status).toBe('stale')
	})

	test('an identity file under a non-compressible type is migrated only if its bytes are the blob', async () => {
		storage.put(`${DID}/blog/raw.png`, body, goodCustom({ mimeType: 'image/png' }))
		storage.put(
			`${DID}/blog/dec.png`,
			new TextEncoder().encode('decompressed payload'),
			goodCustom({ mimeType: 'image/png' }),
		)

		const report = await migrateSite(site('blog', { 'raw.png': bodyCid, 'dec.png': bodyCid }), storage.ports(), {
			dryRun: false,
		})

		expect(report.copied).toBe(1)
		expect(report.skipped['not-raw-blob']).toBe(1)
		expect(Object.keys(storage.commits[0]?.mapping ?? {})).toEqual(['raw.png'])
	})

	test('a dry run classifies and counts without copying, registering or committing', async () => {
		storage.put(`${DID}/blog/a.css`, body, goodCustom())
		storage.put(`${DID}/blog/old.css`, body, goodCustom({ sourceCid: undefined }))

		const report = await migrateSite(site('blog', { 'a.css': bodyCid, 'old.css': bodyCid }), storage.ports(), {
			dryRun: true,
		})

		expect(report).toMatchObject({ status: 'dry-run', copied: 1, skipped: { 'no-source-cid': 1 } })
		expect(storage.copies).toEqual([])
		expect(storage.registered).toEqual([])
		expect(storage.commits).toEqual([])
	})

	test('a site with nothing migratable commits nothing', async () => {
		const report = await migrateSite(site('blog', { 'a.css': bodyCid }), storage.ports(), { dryRun: false })

		expect(report.status).toBe('empty')
		expect(storage.commits).toEqual([])
	})
})

describe('deleteLegacyObjects', () => {
	const key = casKey({ cid: bodyCid, path: 'a.css', mimeType: 'text/css' })

	function migrated() {
		storage.put(`${DID}/blog/a.css`, body, goodCustom())
		storage.put(`${DID}/blog/page.html`, body, goodCustom({ mimeType: 'text/html' }))
		storage.put(`${DID}/blog/.rewritten/page.html`, body, goodCustom({ mimeType: 'text/html' }))
		storage.put(key, body, goodCustom())
		storage.put(
			casKey({ cid: bodyCid, path: 'page.html', mimeType: 'text/html' }),
			body,
			goodCustom({ mimeType: 'text/html' }),
		)
	}

	const target = (fileObjects: FileObjects | null) => ({
		...site('blog', { 'a.css': bodyCid, 'page.html': bodyCid }),
		fileObjects,
	})
	const full = {
		'a.css': key,
		'page.html': casKey({ cid: bodyCid, path: 'page.html', mimeType: 'text/html' }),
	}

	test('deletes the legacy originals of a fully migrated site, never rewritten HTML or CAS objects', async () => {
		migrated()

		const result = await deleteLegacyObjects(target(full), storage.ports())

		expect(result).toEqual({ deleted: 2 })
		expect(storage.deleted.sort()).toEqual([`${DID}/blog/a.css`, `${DID}/blog/page.html`])
		expect(storage.objects.has(`${DID}/blog/.rewritten/page.html`)).toBe(true)
		expect(storage.objects.has(key)).toBe(true)
	})

	test('deletes nothing when a manifest path is unmapped', async () => {
		migrated()

		const result = await deleteLegacyObjects(target({ 'a.css': key }), storage.ports())

		expect(result).toEqual({ deleted: 0, skipped: 'incomplete-mapping' })
		expect(storage.deleted).toEqual([])
	})

	test('deletes nothing when a mapped CAS object is missing from storage', async () => {
		migrated()
		storage.objects.delete(key)

		const result = await deleteLegacyObjects(target(full), storage.ports())

		expect(result).toEqual({ deleted: 0, skipped: 'missing-object' })
		expect(storage.deleted).toEqual([])
	})

	test('deletes nothing for a site with no mapping', async () => {
		migrated()

		expect(await deleteLegacyObjects(target(null), storage.ports())).toEqual({
			deleted: 0,
			skipped: 'incomplete-mapping',
		})
	})
})
