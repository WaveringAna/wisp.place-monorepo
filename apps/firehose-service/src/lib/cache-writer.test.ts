import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { MAX_BLOB_SIZE, MAX_SITE_SIZE, MAX_SITE_SIZE_SUPPORTER } from '@wispplace/constants'
import { MAX_REDIRECT_FILE_BYTES } from '@wispplace/fs-utils'
import type { Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import { measureDecompressedSize, type StorageMetadata } from '@wispplace/tiered-storage'
import {
	AsyncWorkGate,
	assertLogicalFileSizeWithinLimit,
	createRewrittenHtmlMetadata,
	createSourceIdentityMetadata,
	executeSiteDelete,
	getLogicalFileSizeLimit,
	getStoredUncompressedSize,
	handleSettingsDelete,
	handleSettingsUpdate,
	handleSiteCreateOrUpdate,
	isDevLocalPdsFetchEnabled,
	listSiteRecordsForDid,
	planFileChanges,
	type RevalidationResources,
	readPdsRecordJsonResponse,
	reserveAndWriteWithinLogicalBudget,
	resolveCacheWriterResourceConfig,
	type SettingsWriteDependencies,
	type SiteDeleteDependencies,
	SiteLogicalQuotaExceededError,
	SiteLogicalSizeBudget,
	type SiteRecordListDependencies,
	type SiteUpdateHandlerDependencies,
	validateUncompressedSiteSize,
} from './cache-writer'
import { createRevalidationResourceContext, RevalidationDeadlineError } from './revalidate-resources'

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function serializedLock(): SiteUpdateHandlerDependencies['withSiteWriteLock'] &
	SettingsWriteDependencies['withSiteWriteLock'] {
	let tail: Promise<void> = Promise.resolve()
	return async <T>(_did: string, _rkey: string, operation: () => Promise<T>): Promise<T> => {
		const previous = tail
		let release!: () => void
		tail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			return await operation()
		} finally {
			release()
		}
	}
}

function siteRecord(site: string): WispFsRecord {
	return {
		$type: 'place.wisp.fs',
		site,
		root: { type: 'directory', entries: [] },
		createdAt: '2024-01-01T00:00:00.000Z',
	} as WispFsRecord
}

function settingsRecord(directoryListing: boolean): WispSettings {
	return {
		$type: 'place.wisp.settings',
		directoryListing,
		cleanUrls: true,
	}
}

function storageMetadata(customMetadata: Record<string, string>): StorageMetadata {
	return {
		key: 'did:plc:test/site/assets/app.css',
		size: 42,
		createdAt: new Date(0),
		lastAccessed: new Date(0),
		accessCount: 0,
		compressed: false,
		checksum: '',
		customMetadata,
	}
}

describe('PDS getRecord absence responses', () => {
	test('accepts the ATProto RecordNotFound XRPC error as authoritative absence', async () => {
		const response = new Response(JSON.stringify({ error: 'RecordNotFound', message: 'not found' }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		})
		expect(await readPdsRecordJsonResponse(response)).toEqual({ kind: 'absent' })
	})

	test('keeps an unrelated HTTP 400 retryable', async () => {
		const response = new Response(JSON.stringify({ error: 'InvalidRequest' }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		})
		await expect(readPdsRecordJsonResponse(response)).rejects.toMatchObject({ status: 400 })
	})

	test('accepts a gateway HTTP 404 as authoritative absence', async () => {
		expect(await readPdsRecordJsonResponse(new Response(null, { status: 404 }))).toEqual({ kind: 'absent' })
	})

	test('returns a successful bounded JSON response', async () => {
		const value = { value: { $type: 'place.wisp.fs' }, cid: 'bafytest' }
		expect(await readPdsRecordJsonResponse(new Response(JSON.stringify(value)))).toEqual({
			kind: 'present',
			value,
		})
	})
})

describe('locked site/settings reconciliation', () => {
	test('fetches site state after lock acquisition and never materializes a stale hint', async () => {
		const firstFetchStarted = deferred<void>()
		const allowFirstFetch = deferred<void>()
		let authoritative = { record: siteRecord('C1'), cid: 'cid-C1' }
		let fetches = 0
		const materialized: Array<{ site: string; cid: string }> = []
		const lock = serializedLock()
		const dependencies: SiteUpdateHandlerDependencies = {
			fetchAuthoritativeSiteRecord: async () => {
				fetches++
				if (fetches === 1) {
					firstFetchStarted.resolve()
					await allowFirstFetch.promise
				}
				return authoritative
			},
			materializeCurrentRecord: async (_did, _rkey, record, cid) => {
				materialized.push({ site: record.site, cid })
			},
			withSiteWriteLock: lock,
		}

		const stale = handleSiteCreateOrUpdate('did:plc:test', 'site', siteRecord('C1'), 'cid-C1', undefined, dependencies)
		await firstFetchStarted.promise
		authoritative = { record: siteRecord('C2'), cid: 'cid-C2' }
		const fresh = handleSiteCreateOrUpdate('did:plc:test', 'site', siteRecord('C2'), 'cid-C2', undefined, dependencies)
		await Promise.resolve()
		expect(materialized).toEqual([])

		allowFirstFetch.resolve()
		await Promise.all([stale, fresh])
		expect(materialized).toEqual([
			{ site: 'C2', cid: 'cid-C2' },
			{ site: 'C2', cid: 'cid-C2' },
		])
	})

	test('treats an absent site update as a no-op rather than a delete', async () => {
		let materializations = 0
		const dependencies: SiteUpdateHandlerDependencies = {
			fetchAuthoritativeSiteRecord: async () => null,
			materializeCurrentRecord: async () => {
				materializations++
			},
			withSiteWriteLock: async (_did, _rkey, operation) => await operation(),
		}

		await handleSiteCreateOrUpdate('did:plc:test', 'site', siteRecord('hint'), 'cid-hint', undefined, dependencies)
		expect(materializations).toBe(0)
	})

	test('re-reads authoritative settings after lock and never writes a stale update hint', async () => {
		const firstWriteStarted = deferred<void>()
		const allowFirstWrite = deferred<void>()
		const writes: Array<{ directoryListing: boolean; cid: string }> = []
		const lookupContexts: RevalidationResources[] = []
		const dependencies: SettingsWriteDependencies = {
			fetchSettingsRecordOutcome: async (_did, _rkey, _endpoint, resources) => {
				if (!resources) throw new Error('expected a settings resource context')
				lookupContexts.push(resources)
				return {
					kind: 'present',
					record: settingsRecord(true),
					cid: 'cid-C2',
				}
			},
			upsertSiteSettingsCache: async (_did, _rkey, cid, settings) => {
				writes.push({ directoryListing: settings.directoryListing, cid })
				if (writes.length === 1) {
					firstWriteStarted.resolve()
					await allowFirstWrite.promise
				}
			},
			deleteSiteSettingsCache: async () => undefined,
			publishCacheInvalidation: async () => undefined,
			withSiteWriteLock: serializedLock(),
		}
		const staleResources = createRevalidationResourceContext(1_000, 8)
		const freshResources = createRevalidationResourceContext(1_000, 8)

		// The event payload is stale C1, but the PDS already contains C2.
		const stale = handleSettingsUpdate(
			'did:plc:test',
			'site',
			settingsRecord(false),
			'cid-C1',
			{ resources: staleResources },
			dependencies,
		)
		await firstWriteStarted.promise
		const fresh = handleSettingsUpdate(
			'did:plc:test',
			'site',
			settingsRecord(true),
			'cid-C2',
			{ resources: freshResources },
			dependencies,
		)
		await Promise.resolve()
		expect(writes).toEqual([{ directoryListing: true, cid: 'cid-C2' }])

		allowFirstWrite.resolve()
		await Promise.all([stale, fresh])
		expect(writes).toEqual([
			{ directoryListing: true, cid: 'cid-C2' },
			{ directoryListing: true, cid: 'cid-C2' },
		])
		expect(lookupContexts).toEqual([staleResources, freshResources])
		staleResources.close()
		freshResources.close()
	})

	test('reconciles a stale delete to the current settings record instead of deleting fresh state', async () => {
		const firstWriteStarted = deferred<void>()
		const allowFirstWrite = deferred<void>()
		const writes: Array<{ directoryListing: boolean; cid: string }> = []
		let deletes = 0
		const dependencies: SettingsWriteDependencies = {
			fetchSettingsRecordOutcome: async () => ({
				kind: 'present',
				record: settingsRecord(true),
				cid: 'cid-C2',
			}),
			upsertSiteSettingsCache: async (_did, _rkey, cid, settings) => {
				writes.push({ directoryListing: settings.directoryListing, cid })
				if (writes.length === 1) {
					firstWriteStarted.resolve()
					await allowFirstWrite.promise
				}
			},
			deleteSiteSettingsCache: async () => {
				deletes++
			},
			publishCacheInvalidation: async () => undefined,
			withSiteWriteLock: serializedLock(),
		}

		const fresh = handleSettingsUpdate('did:plc:test', 'site', settingsRecord(true), 'cid-C2', undefined, dependencies)
		await firstWriteStarted.promise
		const staleDelete = handleSettingsDelete('did:plc:test', 'site', dependencies)
		await Promise.resolve()
		expect(deletes).toBe(0)

		allowFirstWrite.resolve()
		await Promise.all([fresh, staleDelete])
		expect(writes).toEqual([
			{ directoryListing: true, cid: 'cid-C2' },
			{ directoryListing: true, cid: 'cid-C2' },
		])
		expect(deletes).toBe(0)
	})

	test('deletes settings only when the authoritative record is absent', async () => {
		let writes = 0
		let deletes = 0
		const dependencies: SettingsWriteDependencies = {
			fetchSettingsRecordOutcome: async () => ({ kind: 'absent' }),
			upsertSiteSettingsCache: async () => {
				writes++
			},
			deleteSiteSettingsCache: async () => {
				deletes++
			},
			publishCacheInvalidation: async () => undefined,
			withSiteWriteLock: async (_did, _rkey, operation) => await operation(),
		}

		await handleSettingsUpdate('did:plc:test', 'site', settingsRecord(false), 'cid-C1', undefined, dependencies)
		expect(writes).toBe(0)
		expect(deletes).toBe(1)
	})

	test('does not mutate settings cache when authoritative lookup is retryable or invalid', async () => {
		let lookupCount = 0
		let writes = 0
		let deletes = 0
		const dependencies: SettingsWriteDependencies = {
			fetchSettingsRecordOutcome: async () => {
				lookupCount++
				return lookupCount === 1
					? { kind: 'retryable' as const, error: 'FETCH_FAILED' as const }
					: { kind: 'retryable' as const, error: 'INVALID_RECORD' as const }
			},
			upsertSiteSettingsCache: async () => {
				writes++
			},
			deleteSiteSettingsCache: async () => {
				deletes++
			},
			publishCacheInvalidation: async () => undefined,
			withSiteWriteLock: async (_did, _rkey, operation) => await operation(),
		}

		await expect(
			handleSettingsUpdate('did:plc:test', 'site', settingsRecord(false), 'cid-C1', undefined, dependencies),
		).rejects.toMatchObject({ name: 'AuthoritativeSettingsRecordError', code: 'FETCH_FAILED' })
		await expect(handleSettingsDelete('did:plc:test', 'site', dependencies)).rejects.toMatchObject({
			name: 'AuthoritativeSettingsRecordError',
			code: 'INVALID_RECORD',
		})
		expect(writes).toBe(0)
		expect(deletes).toBe(0)
	})

	test('shares one transfer budget with the authoritative settings lookup', async () => {
		const resources = createRevalidationResourceContext(1_000, 8)
		let lookupResources: Parameters<NonNullable<SettingsWriteDependencies['fetchSettingsRecordOutcome']>>[3]
		let writes = 0
		const dependencies: SettingsWriteDependencies = {
			fetchSettingsRecordOutcome: async (_did, _rkey, _endpoint, currentResources) => {
				lookupResources = currentResources
				currentResources?.transferBudget.consume(3)
				currentResources?.transferBudget.consume(5)
				return { kind: 'present', record: settingsRecord(true), cid: 'cid-C2' }
			},
			upsertSiteSettingsCache: async () => {
				writes++
			},
			deleteSiteSettingsCache: async () => undefined,
			publishCacheInvalidation: async () => undefined,
			withSiteWriteLock: async (_did, _rkey, operation) => await operation(),
		}

		try {
			await handleSettingsUpdate('did:plc:test', 'site', settingsRecord(false), 'cid-C1', { resources }, dependencies)
			expect(lookupResources).toBe(resources)
			expect(resources.transferBudget.consumedBytes).toBe(8)
			expect(writes).toBe(1)
		} finally {
			resources.close()
		}
	})

	test('expires before lock acquisition and performs no settings mutation', async () => {
		const lockStarted = deferred<void>()
		const releaseLock = deferred<void>()
		const lock = serializedLock()
		const lockHolder = lock('did:plc:test', 'site', async () => {
			lockStarted.resolve()
			await releaseLock.promise
		})
		await lockStarted.promise

		const resources = createRevalidationResourceContext(10, 1024)
		let lookups = 0
		let writes = 0
		const dependencies: SettingsWriteDependencies = {
			fetchSettingsRecordOutcome: async () => {
				lookups++
				return { kind: 'present', record: settingsRecord(true), cid: 'cid-C2' }
			},
			upsertSiteSettingsCache: async () => {
				writes++
			},
			deleteSiteSettingsCache: async () => undefined,
			publishCacheInvalidation: async () => undefined,
			withSiteWriteLock: lock,
		}

		const update = handleSettingsUpdate(
			'did:plc:test',
			'site',
			settingsRecord(false),
			'cid-C1',
			{ resources },
			dependencies,
		)
		try {
			await new Promise((resolve) => setTimeout(resolve, 25))
			expect(resources.signal.aborted).toBe(true)
			releaseLock.resolve()
			await expect(update).rejects.toBeInstanceOf(RevalidationDeadlineError)
			expect(lookups).toBe(0)
			expect(writes).toBe(0)
		} finally {
			releaseLock.resolve()
			await lockHolder
			resources.close()
		}
	})

	test('checks resources after authoritative lookup before settings mutation', async () => {
		const upstream = new AbortController()
		const resources = createRevalidationResourceContext(1_000, 1024, upstream.signal)
		let writes = 0
		const dependencies: SettingsWriteDependencies = {
			fetchSettingsRecordOutcome: async () => {
				upstream.abort(new Error('firehose stopped'))
				return { kind: 'present', record: settingsRecord(true), cid: 'cid-C2' }
			},
			upsertSiteSettingsCache: async () => {
				writes++
			},
			deleteSiteSettingsCache: async () => undefined,
			publishCacheInvalidation: async () => undefined,
			withSiteWriteLock: async (_did, _rkey, operation) => await operation(),
		}

		try {
			await expect(
				handleSettingsUpdate('did:plc:test', 'site', settingsRecord(false), 'cid-C1', { resources }, dependencies),
			).rejects.toThrow('firehose stopped')
			expect(writes).toBe(0)
		} finally {
			resources.close()
		}
	})
})

describe('devnet PDS fetch admission', () => {
	test('requires every explicit localhost gate', () => {
		const enabled = {
			NODE_ENV: 'development',
			LOCAL_DEV: 'true',
			WISP_ALLOW_LOCALHOST_FETCH: '1',
		}
		expect(isDevLocalPdsFetchEnabled(enabled)).toBe(true)
		expect(isDevLocalPdsFetchEnabled({ ...enabled, NODE_ENV: 'production' })).toBe(false)
		expect(isDevLocalPdsFetchEnabled({ ...enabled, LOCAL_DEV: 'false' })).toBe(false)
		expect(isDevLocalPdsFetchEnabled({ ...enabled, WISP_ALLOW_LOCALHOST_FETCH: '0' })).toBe(false)
		expect(isDevLocalPdsFetchEnabled({})).toBe(false)
	})
})

describe('uncompressed site-size accounting', () => {
	test('rejects many individually valid gzip expansions that exceed the site quota together', () => {
		const files = Array.from({ length: 10 }, (_value, index) => ({ path: `assets/${index}.txt` }))
		// These are the bounded decompressed sizes measured during ingestion. Their
		// compressed manifest blobs can all be tiny and still must not bypass quota.
		const expandedSize = Math.floor(MAX_SITE_SIZE / files.length) + 1
		const sizes = new Map(files.map((file) => [file.path, expandedSize]))

		expect(() => validateUncompressedSiteSize(files, sizes, MAX_SITE_SIZE)).toThrow(
			'Site exceeds uncompressed size limit',
		)
	})

	test('uses bounded gzip measurements rather than compressed blob lengths for aggregate quota', async () => {
		const original = Buffer.alloc(64 * 1024, 'a')
		const compressed = gzipSync(original)
		expect(compressed.byteLength).toBeLessThan(original.byteLength)

		const files = [{ path: 'one.css' }, { path: 'two.css' }, { path: 'three.css' }]
		const sizes = new Map<string, number>()
		for (const file of files) {
			sizes.set(file.path, await measureDecompressedSize(compressed, original.byteLength))
		}

		expect(() => validateUncompressedSiteSize(files, sizes, original.byteLength * 2)).toThrow(
			'Site exceeds uncompressed size limit',
		)
	})

	test('accepts a logical total exactly at the site quota', () => {
		const files = [{ path: 'a.txt' }, { path: 'b.txt' }]
		const sizes = new Map([
			['a.txt', MAX_SITE_SIZE / 2],
			['b.txt', MAX_SITE_SIZE / 2],
		])

		expect(validateUncompressedSiteSize(files, sizes, MAX_SITE_SIZE)).toBe(MAX_SITE_SIZE)
	})
})

describe('cached source identity metadata', () => {
	const file = {
		path: 'assets/app.css',
		cid: 'bafyreinewsourcecid',
		ownerDid: 'did:plc:source',
		mimeType: 'text/css',
		base64: false,
	}

	test('marks a same-path object with an old source CID for refresh', () => {
		const metadata = storageMetadata({
			sourceCid: 'bafyreioldsourcecid',
			sourceDid: file.ownerDid,
			mimeType: file.mimeType,
			base64: 'false',
			uncompressedSize: '42',
		})

		// The update loop treats null as a required re-download, even when the
		// storage key/path and other metadata are unchanged.
		expect(getStoredUncompressedSize(metadata, file)).toBeNull()
	})

	test('accepts matching source identity metadata for unchanged-file accounting', () => {
		const metadata = storageMetadata({
			sourceCid: file.cid,
			sourceDid: file.ownerDid,
			mimeType: file.mimeType,
			base64: 'false',
			uncompressedSize: '42',
		})

		expect(getStoredUncompressedSize(metadata, file)).toBe(42)
	})

	test('recognizes normalized identity metadata for gzip _redirects sources', () => {
		const redirectsFile = { ...file, path: '_redirects', encoding: 'gzip' as const, mimeType: 'text/plain' }
		const metadata = storageMetadata({
			sourceCid: redirectsFile.cid,
			sourceDid: redirectsFile.ownerDid,
			mimeType: redirectsFile.mimeType,
			base64: 'false',
			uncompressedSize: '42',
		})

		expect(getStoredUncompressedSize(metadata, redirectsFile)).toBe(42)
	})

	test('puts the original source identity, not a PDS URL, on rewritten HTML', () => {
		const metadata = createRewrittenHtmlMetadata(file)

		expect(metadata).toEqual({
			mimeType: 'text/html',
			sourceCid: file.cid,
			sourceDid: file.ownerDid,
		})
		expect(metadata).not.toHaveProperty('sourceUrl')
	})

	test('bounds source identity metadata values before writing', () => {
		expect(() => createSourceIdentityMetadata({ ...file, cid: 'a'.repeat(513) })).toThrow('Invalid source CID')
		expect(() => createSourceIdentityMetadata({ ...file, ownerDid: 'https://pds.example' })).toThrow(
			'Invalid source DID',
		)
	})
})

const LISTED_SITE_DID = 'did:plc:listingtest'
const LISTED_SITE_RECORD = {
	$type: 'place.wisp.fs',
	site: 'site',
	root: { type: 'directory', entries: [] },
	createdAt: '2024-01-01T00:00:00.000Z',
}

function listedSiteRow(rkey: string, did = LISTED_SITE_DID): Record<string, unknown> {
	return {
		uri: `at://${did}/place.wisp.fs/${rkey}`,
		cid: 'bafyreilistrecordcid',
		value: LISTED_SITE_RECORD,
	}
}

function siteRecordListDependencies(pages: unknown[]): SiteRecordListDependencies {
	let nextPage = 0
	return {
		resolvePdsEndpoint: async () => 'https://pds.example',
		fetchPage: async () => {
			const page = pages[nextPage]
			nextPage++
			if (page === undefined) throw new Error('Unexpected extra record-list page request')
			return page
		},
	}
}

describe('bounded site record listing', () => {
	test('fails the full DID scan when a cursor repeats', async () => {
		const dependencies = siteRecordListDependencies([
			{ records: [listedSiteRow('first')], cursor: 'repeat-me' },
			{ records: [listedSiteRow('second')], cursor: 'repeat-me' },
		])

		await expect(listSiteRecordsForDid(LISTED_SITE_DID, dependencies)).rejects.toMatchObject({
			code: 'REPEATED_CURSOR',
		})
	})

	test('rejects an oversized opaque cursor before a follow-up request', async () => {
		const dependencies = siteRecordListDependencies([
			{ records: [listedSiteRow('first')], cursor: 'x'.repeat(4 * 1024 + 1) },
		])

		await expect(listSiteRecordsForDid(LISTED_SITE_DID, dependencies)).rejects.toMatchObject({ code: 'CURSOR_LIMIT' })
	})

	test('rejects a row whose canonical AT-URI belongs to another DID or collection', async () => {
		const wrongDid = siteRecordListDependencies([{ records: [listedSiteRow('site', 'did:plc:other')] }])
		await expect(listSiteRecordsForDid(LISTED_SITE_DID, wrongDid)).rejects.toMatchObject({ code: 'INVALID_URI' })

		const wrongCollection = siteRecordListDependencies([
			{
				records: [{ ...listedSiteRow('site'), uri: `at://${LISTED_SITE_DID}/place.wisp.subfs/site` }],
			},
		])
		await expect(listSiteRecordsForDid(LISTED_SITE_DID, wrongCollection)).rejects.toMatchObject({ code: 'INVALID_URI' })
	})

	test('does not return a partial DID scan when a later PDS page fails', async () => {
		let calls = 0
		const dependencies: SiteRecordListDependencies = {
			resolvePdsEndpoint: async () => 'https://pds.example',
			fetchPage: async () => {
				calls++
				if (calls === 1) return { records: [listedSiteRow('first')], cursor: 'next' }
				throw new Error('HTTP 503')
			},
		}

		await expect(listSiteRecordsForDid(LISTED_SITE_DID, dependencies)).rejects.toThrow('HTTP 503')
	})

	test('rejects a page beyond the aggregate logical byte budget before parsing rows', async () => {
		const hugeValue = {
			...LISTED_SITE_RECORD,
			padding: 'x'.repeat(10 * 1024 * 1024),
		}
		const dependencies = siteRecordListDependencies([
			{
				records: [{ ...listedSiteRow('site'), value: hugeValue }],
			},
		])

		await expect(listSiteRecordsForDid(LISTED_SITE_DID, dependencies)).rejects.toMatchObject({
			code: 'LOGICAL_SIZE_LIMIT',
		})
	})
})

describe('ingest resource and logical quota guards', () => {
	test('plans changed and removed files before the accounting and download stages', () => {
		const files = [
			{ path: 'unchanged.css', cid: 'same' },
			{ path: 'changed.js', cid: 'new' },
			{ path: 'page.html', cid: 'same-page' },
		]
		const oldFileCids = {
			'unchanged.css': 'same',
			'changed.js': 'old',
			'page.html': 'same-page',
			'removed.txt': 'gone',
		}

		const standard = planFileChanges(files, oldFileCids, false, false)
		expect([...standard.downloadPaths]).toEqual(['changed.js'])
		expect(standard.pathsToDelete).toEqual(['removed.txt'])

		const forcedRewrite = planFileChanges(files, oldFileCids, false, true)
		expect([...forcedRewrite.downloadPaths]).toEqual(['changed.js', 'page.html'])

		const duplicatePath = planFileChanges(
			[
				{ path: 'duplicate.txt', cid: 'old' },
				{ path: 'duplicate.txt', cid: 'new' },
			],
			{ 'duplicate.txt': 'old' },
			false,
			false,
		)
		expect(duplicatePath.downloadFileCids.get('duplicate.txt')).toBe('new')
	})

	test('falls back to safe resource settings for invalid backoff and concurrency values', () => {
		expect(
			resolveCacheWriterResourceConfig({
				BLOB_500_BACKOFF_MS: 'not-a-number',
				FIREHOSE_DOWNLOAD_CONCURRENCY: '20',
			}),
		).toEqual({ blob500BackoffMs: 10 * 60 * 1000, downloadConcurrency: 1 })
		expect(resolveCacheWriterResourceConfig({ BLOB_500_BACKOFF_MS: '1000' }).blob500BackoffMs).toBe(1000)
	})

	test('serializes twenty simulated huge HTML fetch/process operations', async () => {
		const gate = new AsyncWorkGate(1)
		let active = 0
		let maxActive = 0

		await Promise.all(
			Array.from({ length: 20 }, () =>
				gate.run(async () => {
					active++
					maxActive = Math.max(maxActive, active)
					await Promise.resolve()
					active--
				}),
			),
		)

		expect(maxActive).toBe(1)
	})

	test('releases a heavy-work permit after an aborted operation', async () => {
		const gate = new AsyncWorkGate(1)
		let nextOperationRan = false
		const aborted = gate.run(async () => {
			await Promise.resolve()
			throw new Error('aborted fetch')
		})
		const next = gate.run(async () => {
			nextOperationRan = true
		})

		await expect(aborted).rejects.toThrow('aborted fetch')
		await next
		expect(nextOperationRan).toBe(true)
	})

	test('reserves unchanged logical sizes before accepting new writes', () => {
		const budget = new SiteLogicalSizeBudget(100, new Map([['unchanged.css', 60]]))

		expect(budget.reserve('new.css', 40)).toBe(true)
		expect(budget.totalSize).toBe(100)
		expect(() => budget.reserve('one-too-many.css', 1)).toThrow(SiteLogicalQuotaExceededError)
	})

	test('stops simulated writes before a lying compressed size can exceed the quota', async () => {
		const budget = new SiteLogicalSizeBudget(100)
		const writes: string[] = []
		const writeAfterLogicalMeasurement = (path: string, logicalSize: number) =>
			reserveAndWriteWithinLogicalBudget(budget, path, logicalSize, async () => {
				writes.push(path)
			})

		await writeAfterLogicalMeasurement('first.css', 60)
		await expect(writeAfterLogicalMeasurement('bomb.css', 50)).rejects.toBeInstanceOf(SiteLogicalQuotaExceededError)
		expect(writes).toEqual(['first.css'])
		expect(budget.totalSize).toBe(60)
	})

	test('does not double-charge a failed-write retry for the same immutable file', async () => {
		const budget = new SiteLogicalSizeBudget(100)
		let successfulWrites = 0

		await expect(
			reserveAndWriteWithinLogicalBudget(budget, 'retry.css', 75, async () => {
				throw new Error('temporary storage failure')
			}),
		).rejects.toThrow('temporary storage failure')
		await reserveAndWriteWithinLogicalBudget(budget, 'retry.css', 75, async () => {
			successfulWrites++
		})
		expect(successfulWrites).toBe(1)
		expect(budget.totalSize).toBe(75)
		expect(budget.reservedFileCount).toBe(1)
	})

	test('enforces the supporter quota before the next file write', () => {
		const budget = new SiteLogicalSizeBudget(MAX_SITE_SIZE_SUPPORTER)
		for (let index = 0; index < 3; index++) {
			budget.reserve(`large-${index}.bin`, MAX_BLOB_SIZE)
		}

		const remaining = MAX_SITE_SIZE_SUPPORTER - budget.totalSize
		expect(() => budget.reserve('too-large.bin', remaining + 1)).toThrow(SiteLogicalQuotaExceededError)
		expect(budget.totalSize).toBe(MAX_BLOB_SIZE * 3)
	})

	test('uses the shared redirect byte cap as an inclusive logical ingest boundary', () => {
		expect(getLogicalFileSizeLimit('_redirects')).toBe(MAX_REDIRECT_FILE_BYTES)
		expect(() => assertLogicalFileSizeWithinLimit('_redirects', MAX_REDIRECT_FILE_BYTES)).not.toThrow()
		expect(() => assertLogicalFileSizeWithinLimit('_redirects', MAX_REDIRECT_FILE_BYTES + 1)).toThrow(
			'_redirects exceeds',
		)
		expect(getLogicalFileSizeLimit('assets/app.js')).toBe(MAX_BLOB_SIZE)
	})
})

interface SiteDeleteTestHarness {
	dependencies: SiteDeleteDependencies
	publications: Array<{ action: 'updating' | 'delete'; token?: string }>
}

function createSiteDeleteTestHarness(
	events: string[],
	options: { files?: string[]; deleteFileFailure?: Error; publisherFailure?: boolean } = {},
): SiteDeleteTestHarness {
	const publications: Array<{ action: 'updating' | 'delete'; token?: string }> = []
	const files = options.files ?? ['did:plc:test/site/index.html', 'did:plc:test/site/app.js']

	return {
		dependencies: {
			listFiles: async (prefix) => {
				events.push(`list:${prefix}`)
				return files
			},
			deleteFile: async (key) => {
				events.push(`delete-file:${key}`)
				if (options.deleteFileFailure) throw options.deleteFileFailure
			},
			markSiteCacheDeleted: async (did, rkey) => {
				events.push(`tombstone-db:${did}/${rkey}`)
			},
			publishCacheInvalidation: async (_did, _rkey, action, token) => {
				if (action !== 'updating' && action !== 'delete') throw new Error(`Unexpected action ${action}`)
				events.push(`publish:${action}`)
				publications.push({ action, token })
				if (options.publisherFailure) throw new Error('publisher unavailable')
			},
		},
		publications,
	}
}

describe('site delete invalidation ordering', () => {
	test('marks updating before destructive work and completes with a matching delete token', async () => {
		const events: string[] = []
		const { dependencies, publications } = createSiteDeleteTestHarness(events)

		await executeSiteDelete('did:plc:test', 'site', dependencies)

		expect(events).toEqual([
			'publish:updating',
			'list:did:plc:test/site/',
			'delete-file:did:plc:test/site/index.html',
			'delete-file:did:plc:test/site/app.js',
			'tombstone-db:did:plc:test/site',
			'publish:delete',
		])
		expect(publications).toHaveLength(2)
		expect(publications[0]).toMatchObject({ action: 'updating', token: expect.any(String) })
		expect(publications[1]).toEqual({ action: 'delete', token: publications[0]?.token })
	})

	test('leaves the updating marker in place when destructive deletion fails', async () => {
		const events: string[] = []
		const { dependencies, publications } = createSiteDeleteTestHarness(events, {
			files: ['did:plc:test/site/index.html'],
			deleteFileFailure: new Error('storage unavailable'),
		})

		await expect(executeSiteDelete('did:plc:test', 'site', dependencies)).rejects.toThrow('storage unavailable')

		expect(events).toEqual(['publish:updating', 'list:did:plc:test/site/', 'delete-file:did:plc:test/site/index.html'])
		expect(publications.map((publication) => publication.action)).toEqual(['updating'])
	})

	test('does not let invalidation publisher failures prevent a complete delete', async () => {
		const events: string[] = []
		const { dependencies, publications } = createSiteDeleteTestHarness(events, {
			files: [],
			publisherFailure: true,
		})

		await expect(executeSiteDelete('did:plc:test', 'site', dependencies)).resolves.toBeUndefined()

		expect(events).toEqual([
			'publish:updating',
			'list:did:plc:test/site/',
			'tombstone-db:did:plc:test/site',
			'publish:delete',
		])
		expect(publications).toHaveLength(2)
	})
})
