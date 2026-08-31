/**
 * Cache writer - downloads blobs from PDS and writes to S3
 * Handles incremental updates by comparing CIDs
 */

import {
	expandSubfs,
	extractBlobCid,
	getPdsForDid,
	SubfsExpansionError,
	type SubfsSubject,
} from '@wispplace/atproto-utils'
import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression'
import { MAX_BLOB_SIZE, MAX_FILE_COUNT, MAX_SITE_SIZE, MAX_SITE_SIZE_SUPPORTER } from '@wispplace/constants'
import {
	collectFileCidsFromEntries,
	countFilesInDirectory,
	MAX_REDIRECT_FILE_BYTES,
	normalizeFileCids,
} from '@wispplace/fs-utils'
import { isHtmlContent, rewriteHtmlPaths } from '@wispplace/fs-utils/html-rewriter'
import { parseLexiconJson } from '@wispplace/lexicons/public-json'
import type { Directory, Entry, File, Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { validateRecord as validateFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import { validateRecord as validateSettingsRecord } from '@wispplace/lexicons/types/place/wisp/settings'
import { createLogger } from '@wispplace/observability'
import { SafeFetchHttpError, safeFetch, safeFetchBlob, safeFetchJson } from '@wispplace/safe-fetch'
import {
	DecompressionLimitError,
	decompress,
	isGzipped,
	measureDecompressedSize,
	type StorageMetadata,
} from '@wispplace/tiered-storage'
import { publishCacheInvalidation } from './cache-invalidation'
import {
	deleteSiteSettingsCache,
	getSiteCache,
	isSupporter,
	markSiteCacheDeleted,
	upsertSiteCache,
	upsertSiteSettingsCache,
	withSiteWriteLock,
} from './db'
import { assertRevalidationActive, type RevalidationResourceContext } from './revalidate-resources'
import { deleteFile, getFileMetadata, listFiles, writeFile } from './storage'

const logger = createLogger('firehose-service')
const SUBFS_EXPANSION_LIMITS = {
	maxConcurrentFetches: 4,
	maxDepth: 10,
	maxEntries: MAX_FILE_COUNT * 4,
	maxFiles: MAX_FILE_COUNT,
	maxRecords: 100,
} as const

export type RevalidationResources = Pick<RevalidationResourceContext, 'signal' | 'transferBudget' | 'deadlineAt'>
function getBoundedEnvironmentInteger(
	environment: Record<string, string | undefined>,
	name: string,
	defaultValue: number,
	minimum: number,
	maximum: number,
): number {
	const rawValue = environment[name]
	if (!rawValue) return defaultValue

	const value = Number(rawValue)
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : defaultValue
}

export interface CacheWriterResourceConfig {
	blob500BackoffMs: number
	downloadConcurrency: number
}

/** Resolve resource settings without accepting unsafe zero, NaN, or huge values. */
export function resolveCacheWriterResourceConfig(
	environment: Record<string, string | undefined> = process.env,
): CacheWriterResourceConfig {
	return {
		blob500BackoffMs: getBoundedEnvironmentInteger(
			environment,
			'BLOB_500_BACKOFF_MS',
			10 * 60 * 1000,
			1_000,
			24 * 60 * 60 * 1000,
		),
		// Blob reads deliberately remain serial within a site update. A value
		// other than one is rejected rather than allowing several 200 MiB buffers
		// to queue before a quota violation can stop the batch.
		downloadConcurrency: getBoundedEnvironmentInteger(environment, 'FIREHOSE_DOWNLOAD_CONCURRENCY', 1, 1, 1),
	}
}

const resourceConfig = resolveCacheWriterResourceConfig()
const BLOB_500_BACKOFF_MS = resourceConfig.blob500BackoffMs
const DOWNLOAD_CONCURRENCY = resourceConfig.downloadConcurrency
const blob500BackoffUntil = new Map<string, number>()

/**
 * A FIFO permit gate for work that can buffer a full blob, decode base64/gzip,
 * or allocate HTML rewrite output. The direct handoff keeps the active count
 * reserved while a waiter starts, and `finally` always releases failed work.
 */
export class AsyncWorkGate {
	private active = 0
	private readonly waiters: Array<() => void> = []

	constructor(private readonly concurrency: number) {
		if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
			throw new RangeError('AsyncWorkGate concurrency must be a positive safe integer')
		}
	}

	async run<T>(work: () => Promise<T>): Promise<T> {
		if (this.active >= this.concurrency) {
			await new Promise<void>((resolve) => this.waiters.push(resolve))
		} else {
			this.active++
		}

		try {
			return await work()
		} finally {
			const next = this.waiters.shift()
			if (next) {
				next()
			} else {
				this.active--
			}
		}
	}
}

// Do not make this configurable above one: it starts before safeFetchBlob and
// therefore bounds buffered binary downloads as well as gzip/HTML work.
const blobProcessingGate = new AsyncWorkGate(1)

/**
 * Localhost PDS access requires all three dev-only gates. Production remains
 * HTTPS-only, and callers still opt in explicitly at both the identity and
 * pinned HTTP fetch layers.
 */
export function isDevLocalPdsFetchEnabled(environment: Record<string, string | undefined> = process.env): boolean {
	return (
		environment.NODE_ENV === 'development' &&
		environment.LOCAL_DEV === 'true' &&
		environment.WISP_ALLOW_LOCALHOST_FETCH === '1'
	)
}

const allowDevLocalPdsFetch = isDevLocalPdsFetchEnabled()
const pdsIdentityFetch: Parameters<typeof getPdsForDid>[1] = (url, options) =>
	safeFetch(url, {
		signal: options?.signal,
		byteBudget: options?.byteBudget,
		allowLocalhost: allowDevLocalPdsFetch,
	})
const pdsEndpointOptions = allowDevLocalPdsFetch ? { allowLoopback: true } : undefined
const pdsRequestOptions = allowDevLocalPdsFetch ? { allowLocalhost: true } : undefined
const MAX_PDS_RECORD_RESPONSE_BYTES = 64 * 1024

export type PdsRecordJsonResponse<T> = { kind: 'present'; value: T } | { kind: 'absent' }

/**
 * Interpret the ATProto getRecord response without treating every HTTP 400 as
 * absence. Conformant PDS implementations report a missing record as the typed
 * XRPC error `RecordNotFound` with status 400; some gateways use 404 instead.
 * The response body is bounded by safeFetch before this function reads it.
 */
export async function readPdsRecordJsonResponse<T>(response: Response): Promise<PdsRecordJsonResponse<T>> {
	if (response.ok) return { kind: 'present', value: (await response.json()) as T }
	if (response.status === 404) {
		void response.body?.cancel().catch(() => undefined)
		return { kind: 'absent' }
	}
	if (response.status === 400) {
		let errorBody: unknown
		try {
			errorBody = await response.json()
		} catch {
			// Preserve the typed HTTP error for malformed or oversized bodies.
		}
		if (
			typeof errorBody === 'object' &&
			errorBody !== null &&
			(errorBody as { error?: unknown }).error === 'RecordNotFound'
		) {
			return { kind: 'absent' }
		}
	}
	void response.body?.cancel().catch(() => undefined)
	throw new SafeFetchHttpError(response)
}

async function fetchPdsRecordJson<T>(
	url: string,
	resources?: RevalidationResources,
): Promise<PdsRecordJsonResponse<T>> {
	assertRevalidationActive(resources)
	const response = await safeFetch(url, {
		...(pdsRequestOptions ?? {}),
		maxSize: MAX_PDS_RECORD_RESPONSE_BYTES,
		signal: resources?.signal,
		byteBudget: resources?.transferBudget,
	})
	return await readPdsRecordJsonResponse<T>(response)
}

async function resolvePdsEndpoint(did: string, resources?: RevalidationResources): Promise<string | null> {
	assertRevalidationActive(resources)
	return await getPdsForDid(did, pdsIdentityFetch, pdsEndpointOptions, {
		signal: resources?.signal,
		byteBudget: resources?.transferBudget,
	})
}

const pdsFetchRewrite = (() => {
	const rewriteFrom = process.env.PDS_FETCH_REWRITE_FROM
	const rewriteTo = process.env.PDS_FETCH_REWRITE_TO
	if (!rewriteFrom && !rewriteTo) return undefined
	if (!rewriteFrom || !rewriteTo) {
		throw new Error('PDS_FETCH_REWRITE_FROM and PDS_FETCH_REWRITE_TO must be set together')
	}
	if (process.env.LOCAL_DEV !== 'true') {
		throw new Error('PDS fetch rewriting requires LOCAL_DEV=true')
	}
	return { from: new URL(rewriteFrom), to: new URL(rewriteTo) }
})()

function rewritePdsEndpoint(endpoint: string): string {
	if (!pdsFetchRewrite) return endpoint
	const original = new URL(endpoint)
	if (original.origin !== pdsFetchRewrite.from.origin) return endpoint
	return new URL(`${original.pathname}${original.search}${original.hash}`, pdsFetchRewrite.to)
		.toString()
		.replace(/\/$/, '')
}

type PdsEndpointResolver = (did: string, resources?: RevalidationResources) => Promise<string>

function createPdsEndpointResolver(rootDid: string, rootPdsEndpoint: string): PdsEndpointResolver {
	const endpoints = new Map<string, Promise<string>>([[rootDid, Promise.resolve(rootPdsEndpoint)]])

	return (sourceDid, resources) => {
		assertRevalidationActive(resources)
		const existing = endpoints.get(sourceDid)
		if (existing) return existing

		const pending = (async () => {
			const resolved = await resolvePdsEndpoint(sourceDid, resources)
			const endpoint = resolved ? rewritePdsEndpoint(resolved) : null
			if (!endpoint) throw new SubfsExpansionError('FETCH_FAILED')
			return endpoint
		})()
		endpoints.set(sourceDid, pending)
		return pending
	}
}

async function fetchSubfsRecord(
	subject: SubfsSubject,
	resolvePdsEndpoint: PdsEndpointResolver,
	resources?: RevalidationResources,
): Promise<unknown> {
	assertRevalidationActive(resources)
	const pdsEndpoint = await resolvePdsEndpoint(subject.repo, resources)
	const query = new URLSearchParams({
		repo: subject.repo,
		collection: subject.collection,
		rkey: subject.rkey,
	})
	const response = await safeFetchJson<{ value?: unknown }>(
		`${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?${query.toString()}`,
		{
			...(pdsRequestOptions ?? {}),
			signal: resources?.signal,
			byteBudget: resources?.transferBudget,
			maxSize: MAX_PDS_RECORD_RESPONSE_BYTES,
		},
	)
	return response.value
}

class Blob500BackoffError extends Error {
	constructor(
		public readonly blobKey: string,
		public readonly until: number,
		public readonly originalError?: unknown,
	) {
		super(`Blob fetch backoff active until ${new Date(until).toISOString()}`)
		this.name = 'Blob500BackoffError'
	}
}

export class SiteBlobBackoffError extends Error {
	constructor(
		public readonly did: string,
		public readonly rkey: string,
		public readonly until: number,
		public readonly failures: number,
	) {
		super(`Site blob fetch backoff active until ${new Date(until).toISOString()}`)
		this.name = 'SiteBlobBackoffError'
	}
}

function isHttp500Error(err: unknown): boolean {
	if (typeof err === 'object' && err !== null) {
		const value = err as Record<string, unknown>
		const status = value.status ?? value.statusCode
		if (typeof status === 'number' && status === 500) return true
		if (typeof status === 'string' && status === '500') return true
	}

	const msg = err instanceof Error ? err.message : String(err)
	return /\bHTTP\s*500\b/i.test(msg)
}

function getBackoffUntil(blobKey: string): number | null {
	const until = blob500BackoffUntil.get(blobKey)
	if (!until) return null
	if (Date.now() >= until) {
		blob500BackoffUntil.delete(blobKey)
		return null
	}
	return until
}

function set500Backoff(blobKey: string): number {
	const until = Date.now() + BLOB_500_BACKOFF_MS
	blob500BackoffUntil.set(blobKey, until)
	return until
}

function getBlobBackoffUntil(error: unknown): number | null {
	if (error instanceof Blob500BackoffError) return error.until
	return null
}

export type AuthoritativeSiteRecord = { record: WispFsRecord; cid: string }

export type AuthoritativeSiteRecordErrorCode = 'PDS_UNRESOLVED' | 'INVALID_RECORD' | 'MISSING_CID'

/** A fail-closed authoritative record lookup error with no hostile response data. */
export class AuthoritativeSiteRecordError extends Error {
	constructor(readonly code: AuthoritativeSiteRecordErrorCode) {
		super(`Authoritative site record lookup failed: ${code}`)
		this.name = 'AuthoritativeSiteRecordError'
	}
}

/**
 * Read current PDS state without conflating absence with transport or validation
 * failure. Only a typed HTTP 404 is authoritative absence; every other failure
 * is retryable by the caller.
 */
export async function fetchAuthoritativeSiteRecord(
	did: string,
	rkey: string,
	resources?: RevalidationResources,
): Promise<AuthoritativeSiteRecord | null> {
	assertRevalidationActive(resources)
	const resolvedPdsEndpoint = await resolvePdsEndpoint(did, resources)
	const pdsEndpoint = resolvedPdsEndpoint ? rewritePdsEndpoint(resolvedPdsEndpoint) : null
	if (!pdsEndpoint) throw new AuthoritativeSiteRecordError('PDS_UNRESOLVED')

	const query = new URLSearchParams({ repo: did, collection: 'place.wisp.fs', rkey })
	const response = await fetchPdsRecordJson<{ value?: unknown; cid?: unknown }>(
		`${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?${query.toString()}`,
		resources,
	)
	if (response.kind === 'absent') return null
	const data = response.value

	const record = parseLexiconJson<WispFsRecord>(data.value)
	if (!validateFsRecord(record).success) throw new AuthoritativeSiteRecordError('INVALID_RECORD')
	if (typeof data.cid !== 'string' || data.cid.length === 0 || data.cid.length > 256) {
		throw new AuthoritativeSiteRecordError('MISSING_CID')
	}
	return { record, cid: data.cid }
}

export type SiteRecordFetchOutcome =
	| { kind: 'present'; record: WispFsRecord; cid: string }
	| { kind: 'absent' }
	| { kind: 'retryable'; error: 'PDS_UNRESOLVED' | 'INVALID_RECORD' | 'MISSING_CID' | 'FETCH_FAILED' }

/** A revalidation-safe PDS lookup. Only an actual HTTP 404 is `absent`. */
export async function fetchSiteRecordOutcome(
	did: string,
	rkey: string,
	resources?: RevalidationResources,
): Promise<SiteRecordFetchOutcome> {
	try {
		const result = await fetchAuthoritativeSiteRecord(did, rkey, resources)
		return result ? { kind: 'present', ...result } : { kind: 'absent' }
	} catch (error) {
		if (error instanceof AuthoritativeSiteRecordError) return { kind: 'retryable', error: error.code }
		return { kind: 'retryable', error: 'FETCH_FAILED' }
	}
}

/**
 * Fetch a site record from the PDS for non-destructive create/update recovery.
 */
export async function fetchSiteRecord(
	did: string,
	rkey: string,
	resources?: RevalidationResources,
): Promise<{ record: WispFsRecord; cid: string } | null> {
	try {
		assertRevalidationActive(resources)
		const resolvedPdsEndpoint = await resolvePdsEndpoint(did, resources)
		const pdsEndpoint = resolvedPdsEndpoint ? rewritePdsEndpoint(resolvedPdsEndpoint) : null
		if (!pdsEndpoint) {
			logger.error('Failed to get PDS endpoint for DID', undefined, { did, rkey })
			return null
		}

		const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.fs&rkey=${encodeURIComponent(rkey)}`
		const data = (await safeFetchJson(url, {
			...(pdsRequestOptions ?? {}),
			maxSize: MAX_PDS_RECORD_RESPONSE_BYTES,
			signal: resources?.signal,
			byteBudget: resources?.transferBudget,
		})) as { value: unknown; cid?: string }

		const record = parseLexiconJson<WispFsRecord>(data.value)
		const validation = validateFsRecord(record)
		if (!validation.success) {
			logger.warn('Rejected invalid site record', { did, rkey })
			return null
		}

		return {
			record,
			cid: data.cid || '',
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		if (errorMsg.includes('HTTP 404') || errorMsg.includes('Not Found')) {
			logger.info('Site record not found', { did, rkey })
		} else {
			logger.error('Failed to fetch site record', undefined, { did, rkey })
		}
		return null
	}
}

const SITE_RECORD_COLLECTION = 'place.wisp.fs'
const MAX_SITE_RECORD_LIST_PAGES = 20
const MAX_SITE_RECORDS_PER_PAGE = 100
const MAX_SITE_RECORD_LIST_RECORDS = MAX_SITE_RECORD_LIST_PAGES * MAX_SITE_RECORDS_PER_PAGE
const MAX_SITE_RECORD_LIST_PAGE_BYTES = 1024 * 1024
const MAX_SITE_RECORD_LIST_LOGICAL_BYTES = 10 * 1024 * 1024
const MAX_SITE_RECORD_LIST_CURSOR_BYTES = 4 * 1024
const MAX_SITE_RECORD_URI_BYTES = 4 * 1024
const MAX_SITE_RECORD_CID_BYTES = 512
const MAX_SITE_RECORD_DID_BYTES = 2 * 1024
const DID_IDENTIFIER_PATTERN = /^did:[a-z]+:(?:[a-zA-Z0-9._:-]|%[0-9A-F]{2})*[a-zA-Z0-9._-]$/
const RECORD_KEY_PATTERN = /^[a-zA-Z0-9_~.:-]{1,512}$/

export type SiteRecordListingErrorCode =
	| 'INVALID_DID'
	| 'PDS_UNRESOLVED'
	| 'MALFORMED_PAGE'
	| 'PAGE_LIMIT'
	| 'RECORD_LIMIT'
	| 'LOGICAL_SIZE_LIMIT'
	| 'CURSOR_LIMIT'
	| 'REPEATED_CURSOR'
	| 'INVALID_URI'
	| 'INVALID_RECORD'

/** A fail-closed listing error that never includes a hostile PDS value. */
export class SiteRecordListingError extends Error {
	constructor(readonly code: SiteRecordListingErrorCode) {
		super(`Site record listing failed: ${code}`)
		this.name = 'SiteRecordListingError'
	}
}

interface ListedSiteRecord {
	rkey: string
	record: WispFsRecord
	cid: string
}

interface ParsedSiteRecordsPage {
	records: unknown[]
	cursor?: string
	logicalBytes: number
}

export interface SiteRecordListDependencies {
	resolvePdsEndpoint(did: string, resources?: RevalidationResources): Promise<string | null>
	fetchPage(pdsEndpoint: string, did: string, cursor?: string, resources?: RevalidationResources): Promise<unknown>
}

function throwSiteRecordListingError(code: SiteRecordListingErrorCode): never {
	throw new SiteRecordListingError(code)
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, 'utf8')
}

function measureListingPageBytes(page: unknown): number {
	try {
		const serialized = JSON.stringify(page)
		if (typeof serialized !== 'string') throwSiteRecordListingError('MALFORMED_PAGE')
		return byteLength(serialized)
	} catch (error) {
		if (error instanceof SiteRecordListingError) throw error
		throwSiteRecordListingError('MALFORMED_PAGE')
	}
}

function validateRequestedDid(did: string): void {
	if (byteLength(did) > MAX_SITE_RECORD_DID_BYTES || !DID_IDENTIFIER_PATTERN.test(did)) {
		throwSiteRecordListingError('INVALID_DID')
	}
}

function parseListedRecordUri(uri: string, did: string): string {
	const prefix = `at://${did}/${SITE_RECORD_COLLECTION}/`
	if (byteLength(uri) > MAX_SITE_RECORD_URI_BYTES || !uri.startsWith(prefix)) {
		throwSiteRecordListingError('INVALID_URI')
	}
	const rkey = uri.slice(prefix.length)
	if (!RECORD_KEY_PATTERN.test(rkey) || rkey === '.' || rkey === '..' || uri !== `${prefix}${rkey}`) {
		throwSiteRecordListingError('INVALID_URI')
	}
	return rkey
}

function parseListedSiteRecord(row: unknown, did: string): ListedSiteRecord {
	if (!isJsonObject(row) || typeof row.uri !== 'string' || typeof row.cid !== 'string' || !('value' in row)) {
		throwSiteRecordListingError('INVALID_RECORD')
	}
	if (
		row.cid.length === 0 ||
		byteLength(row.cid) > MAX_SITE_RECORD_CID_BYTES ||
		hasUnsafeIdentifierCharacter(row.cid)
	) {
		throwSiteRecordListingError('INVALID_RECORD')
	}
	const rkey = parseListedRecordUri(row.uri, did)
	try {
		const record = parseLexiconJson<WispFsRecord>(row.value)
		if (!validateFsRecord(record).success) throwSiteRecordListingError('INVALID_RECORD')
		return { rkey, record, cid: row.cid }
	} catch (error) {
		if (error instanceof SiteRecordListingError) throw error
		throwSiteRecordListingError('INVALID_RECORD')
	}
}

function parseSiteRecordsPage(page: unknown): ParsedSiteRecordsPage {
	if (!isJsonObject(page) || !Array.isArray(page.records) || page.records.length > MAX_SITE_RECORDS_PER_PAGE) {
		throwSiteRecordListingError('MALFORMED_PAGE')
	}
	const cursorValue = page.cursor
	if (cursorValue !== undefined && typeof cursorValue !== 'string') throwSiteRecordListingError('MALFORMED_PAGE')
	if (
		cursorValue !== undefined &&
		(cursorValue.length === 0 || byteLength(cursorValue) > MAX_SITE_RECORD_LIST_CURSOR_BYTES)
	) {
		throwSiteRecordListingError('CURSOR_LIMIT')
	}
	return { records: page.records, cursor: cursorValue, logicalBytes: measureListingPageBytes(page) }
}

async function resolveSiteRecordListPdsEndpoint(
	did: string,
	resources?: RevalidationResources,
): Promise<string | null> {
	const resolvedPdsEndpoint = await resolvePdsEndpoint(did, resources)
	return resolvedPdsEndpoint ? rewritePdsEndpoint(resolvedPdsEndpoint) : null
}

async function fetchSiteRecordsPage(
	pdsEndpoint: string,
	did: string,
	cursor?: string,
	resources?: RevalidationResources,
): Promise<unknown> {
	const params = new URLSearchParams({
		repo: did,
		collection: SITE_RECORD_COLLECTION,
		limit: `${MAX_SITE_RECORDS_PER_PAGE}`,
	})
	if (cursor) params.set('cursor', cursor)
	return await safeFetchJson<unknown>(`${pdsEndpoint}/xrpc/com.atproto.repo.listRecords?${params.toString()}`, {
		maxSize: MAX_SITE_RECORD_LIST_PAGE_BYTES,
		allowLocalhost: allowDevLocalPdsFetch,
		signal: resources?.signal,
		byteBudget: resources?.transferBudget,
	})
}

const defaultSiteRecordListDependencies: SiteRecordListDependencies = {
	resolvePdsEndpoint: resolveSiteRecordListPdsEndpoint,
	fetchPage: fetchSiteRecordsPage,
}

function addListingCursor(cursor: string, seenCursors: Set<string>): void {
	if (seenCursors.has(cursor)) throwSiteRecordListingError('REPEATED_CURSOR')
	seenCursors.add(cursor)
}

/**
 * List a bounded, canonically validated set of place.wisp.fs records for a DID.
 * Rows are handled one at a time so only accepted records, not raw pages, stay
 * resident after each fetch.
 */
export async function listSiteRecordsForDid(
	did: string,
	dependencies: SiteRecordListDependencies = defaultSiteRecordListDependencies,
	resources?: RevalidationResources,
): Promise<ListedSiteRecord[]> {
	assertRevalidationActive(resources)
	validateRequestedDid(did)
	const pdsEndpoint = await dependencies.resolvePdsEndpoint(did, resources)
	if (!pdsEndpoint) throwSiteRecordListingError('PDS_UNRESOLVED')

	const records: ListedSiteRecord[] = []
	const seenCursors = new Set<string>()
	let cursor: string | undefined
	let logicalBytes = 0
	for (let pageNumber = 0; pageNumber < MAX_SITE_RECORD_LIST_PAGES; pageNumber++) {
		assertRevalidationActive(resources)
		const page = parseSiteRecordsPage(await dependencies.fetchPage(pdsEndpoint, did, cursor, resources))
		logicalBytes += page.logicalBytes
		if (logicalBytes > MAX_SITE_RECORD_LIST_LOGICAL_BYTES) throwSiteRecordListingError('LOGICAL_SIZE_LIMIT')
		if (page.records.length > MAX_SITE_RECORD_LIST_RECORDS - records.length) {
			throwSiteRecordListingError('RECORD_LIMIT')
		}
		for (const row of page.records) records.push(parseListedSiteRecord(row, did))
		if (!page.cursor) return records
		addListingCursor(page.cursor, seenCursors)
		cursor = page.cursor
	}
	throwSiteRecordListingError('PAGE_LIMIT')
}

export type SettingsRecordFetchOutcome =
	| { kind: 'present'; record: WispSettings; cid: string }
	| { kind: 'absent' }
	| { kind: 'retryable'; error: 'PDS_UNRESOLVED' | 'INVALID_RECORD' | 'MISSING_CID' | 'FETCH_FAILED' }

export type AuthoritativeSettingsRecordErrorCode = Extract<SettingsRecordFetchOutcome, { kind: 'retryable' }>['error']

/** A fail-closed authoritative settings lookup error with no hostile response data. */
export class AuthoritativeSettingsRecordError extends Error {
	constructor(readonly code: AuthoritativeSettingsRecordErrorCode) {
		super(`Authoritative settings record lookup failed: ${code}`)
		this.name = 'AuthoritativeSettingsRecordError'
	}
}

/**
 * Revalidation-safe settings lookup. `pdsEndpoint` remains available to the
 * create/update path; only SafeFetchHttpError 404 is authoritative absence.
 */
export async function fetchSettingsRecordOutcome(
	did: string,
	rkey: string,
	pdsEndpoint?: string,
	resources?: RevalidationResources,
): Promise<SettingsRecordFetchOutcome> {
	try {
		assertRevalidationActive(resources)
		const resolvedEndpoint = pdsEndpoint ?? (await resolvePdsEndpoint(did, resources))
		const endpoint = resolvedEndpoint ? rewritePdsEndpoint(resolvedEndpoint) : null
		if (!endpoint) return { kind: 'retryable', error: 'PDS_UNRESOLVED' }
		const url = `${endpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.settings&rkey=${encodeURIComponent(rkey)}`
		let response: PdsRecordJsonResponse<{ value?: unknown; cid?: unknown }>
		try {
			response = await fetchPdsRecordJson(url, resources)
		} catch {
			return { kind: 'retryable', error: 'FETCH_FAILED' }
		}
		if (response.kind === 'absent') return { kind: 'absent' }
		const data = response.value
		const record = parseLexiconJson<WispSettings>(data.value)
		if (!validateSettingsRecord(record).success) return { kind: 'retryable', error: 'INVALID_RECORD' }
		if (typeof data.cid !== 'string' || data.cid.length === 0 || data.cid.length > 256) {
			return { kind: 'retryable', error: 'MISSING_CID' }
		}
		return { kind: 'present', record, cid: data.cid }
	} catch {
		return { kind: 'retryable', error: 'FETCH_FAILED' }
	}
}

/** Fetch a settings record for non-destructive callers. */
export async function fetchSettingsRecord(
	did: string,
	rkey: string,
	pdsEndpoint?: string,
	resources?: RevalidationResources,
): Promise<{ record: WispSettings; cid: string } | null> {
	const outcome = await fetchSettingsRecordOutcome(did, rkey, pdsEndpoint, resources)
	return outcome.kind === 'present' ? { record: outcome.record, cid: outcome.cid } : null
}

/**
 * Calculate total blob size from directory tree
 */
function calculateTotalBlobSize(directory: Directory): number {
	let totalSize = 0

	function sumBlobSizes(entries: Entry[]) {
		for (const entry of entries) {
			const node = entry.node
			if ('type' in node && node.type === 'directory' && 'entries' in node) {
				sumBlobSizes(node.entries)
			} else if ('type' in node && node.type === 'file' && 'blob' in node) {
				totalSize += node.blob.size
			}
		}
	}

	sumBlobSizes(directory.entries)
	return totalSize
}

interface FileInfo {
	path: string
	cid: string
	blob: File['blob']
	ownerDid: string
	encoding?: 'gzip'
	mimeType?: string
	base64?: boolean
}

type CachedFileMetadataExpectation = Pick<FileInfo, 'path' | 'cid' | 'ownerDid' | 'encoding' | 'mimeType' | 'base64'>
type SourceFileIdentity = Pick<FileInfo, 'cid' | 'ownerDid'>

// Blob CIDs are normally much shorter than this (for example, a CIDv1
// SHA-256 is 59 characters). These defensive bounds keep untrusted record
// values from becoming oversized S3 metadata or request URL components.
const MAX_SOURCE_CID_LENGTH = 512
const MAX_SOURCE_DID_LENGTH = 2048

/**
 * Metadata that binds a cached object to the immutable blob and repository
 * that produced it. Do not store a PDS endpoint here: it is mutable and can
 * contain credentials or other URL-sensitive data.
 */
function hasUnsafeIdentifierCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code <= 0x20 || code === 0x7f) return true
	}
	return false
}

function assertSourceIdentityIsBounded(file: SourceFileIdentity): void {
	if (
		file.cid.length === 0 ||
		file.cid.length > MAX_SOURCE_CID_LENGTH ||
		file.cid.includes('/') ||
		file.cid.includes('\\') ||
		hasUnsafeIdentifierCharacter(file.cid)
	) {
		throw new Error(`Invalid source CID for cached file (length ${file.cid.length})`)
	}
	if (
		!file.ownerDid.startsWith('did:') ||
		file.ownerDid.length > MAX_SOURCE_DID_LENGTH ||
		file.ownerDid.includes('/') ||
		file.ownerDid.includes('?') ||
		file.ownerDid.includes('#') ||
		hasUnsafeIdentifierCharacter(file.ownerDid)
	) {
		throw new Error('Invalid source DID for cached file')
	}
}

export function createSourceIdentityMetadata(file: SourceFileIdentity): Record<'sourceCid' | 'sourceDid', string> {
	assertSourceIdentityIsBounded(file)
	return { sourceCid: file.cid, sourceDid: file.ownerDid }
}

/** @internal Shared by original and rewritten file writes. */
export function createRewrittenHtmlMetadata(file: SourceFileIdentity): Record<string, string> {
	return { mimeType: 'text/html', ...createSourceIdentityMetadata(file) }
}

export function getStoredUncompressedSize(
	metadata: StorageMetadata | null,
	file: CachedFileMetadataExpectation,
): number | null {
	const custom = metadata?.customMetadata
	if (!custom) return null

	// Reprocess a same-CID file if manifest metadata changed. Its bytes may be
	// identical while its gzip/base64 interpretation (and therefore logical size)
	// changes. Non-compressible gzip inputs are normalized to identity before write.
	const expectedStoredEncoding =
		file.encoding === 'gzip' && !isRedirectsFile(file.path) && shouldCompressMimeType(file.mimeType)
			? 'gzip'
			: undefined
	const encodingMatches =
		custom.encoding === expectedStoredEncoding ||
		(file.encoding === undefined && custom.encoding === 'gzip' && isTextLikeMime(file.mimeType, file.path))
	if (
		custom.sourceCid !== file.cid ||
		custom.sourceDid !== file.ownerDid ||
		custom.mimeType !== file.mimeType ||
		!encodingMatches ||
		custom.base64 !== `${file.base64 === true}`
	) {
		return null
	}

	const rawSize = custom.uncompressedSize
	if (!rawSize || !/^\d+$/.test(rawSize)) return null
	const size = Number(rawSize)
	return Number.isSafeInteger(size) && size >= 0 && size <= getLogicalFileSizeLimit(file.path) ? size : null
}

export function validateUncompressedSiteSize(
	files: Iterable<{ path: string }>,
	uncompressedSizes: ReadonlyMap<string, number>,
	sizeLimit: number,
): number {
	let totalUncompressedSize = 0
	for (const file of files) {
		const fileSize = uncompressedSizes.get(file.path)
		if (fileSize === undefined) {
			throw new Error(`Missing uncompressed-size accounting for ${file.path}`)
		}
		if (!Number.isSafeInteger(fileSize) || fileSize < 0 || fileSize > MAX_BLOB_SIZE) {
			throw new Error(`Invalid uncompressed size for ${file.path}`)
		}

		totalUncompressedSize += fileSize
		if (totalUncompressedSize > sizeLimit) {
			throw new Error(`Site exceeds uncompressed size limit at ${file.path}`)
		}
	}
	return totalUncompressedSize
}

function isRedirectsFile(filePath: string): boolean {
	return filePath === '_redirects'
}

/**
 * `_redirects` is parsed at request time, so its logical (decoded) body must
 * never exceed the same shared byte cap the loader accepts. Other site files
 * retain the normal per-blob limit.
 */
export function getLogicalFileSizeLimit(filePath: string): number {
	return isRedirectsFile(filePath) ? MAX_REDIRECT_FILE_BYTES : MAX_BLOB_SIZE
}

export class FileLogicalSizeLimitError extends Error {
	readonly filePath: string
	readonly size: number
	readonly limit: number

	constructor(filePath: string, size: number, limit: number) {
		super(
			isRedirectsFile(filePath)
				? `_redirects exceeds the ${limit}-byte logical size limit`
				: 'File exceeds logical size limit',
		)
		this.name = 'FileLogicalSizeLimitError'
		this.filePath = filePath
		this.size = size
		this.limit = limit
	}
}

export function assertLogicalFileSizeWithinLimit(filePath: string, size: number): void {
	const limit = getLogicalFileSizeLimit(filePath)
	if (!Number.isSafeInteger(size) || size < 0 || size > limit) {
		throw new FileLogicalSizeLimitError(filePath, size, limit)
	}
}

/** Raised before a storage write would make a site's logical total exceed its plan limit. */
export class SiteLogicalQuotaExceededError extends Error {
	readonly filePath: string
	readonly attemptedSize: number
	readonly totalBeforeReserve: number
	readonly sizeLimit: number

	constructor(filePath: string, attemptedSize: number, totalBeforeReserve: number, sizeLimit: number) {
		super('Site exceeds logical size limit')
		this.name = 'SiteLogicalQuotaExceededError'
		this.filePath = filePath
		this.attemptedSize = attemptedSize
		this.totalBeforeReserve = totalBeforeReserve
		this.sizeLimit = sizeLimit
	}
}

/**
 * Holds per-update logical-size reservations. `reserve` has no await points,
 * so competing asynchronous download completions cannot over-allocate it.
 * Reservations intentionally survive a failed write until the update exits:
 * a retry for the same immutable blob cannot double-charge the site budget.
 */
export class SiteLogicalSizeBudget {
	private total = 0
	private readonly reservedSizes = new Map<string, number>()

	constructor(
		private readonly sizeLimit: number,
		initialSizes: ReadonlyMap<string, number> = new Map(),
	) {
		if (!Number.isSafeInteger(sizeLimit) || sizeLimit < 0) {
			throw new RangeError('Site logical size limit must be a non-negative safe integer')
		}
		for (const [filePath, size] of initialSizes) this.reserve(filePath, size)
	}

	get totalSize(): number {
		return this.total
	}

	get reservedFileCount(): number {
		return this.reservedSizes.size
	}

	reserve(filePath: string, size: number): boolean {
		if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BLOB_SIZE) {
			throw new RangeError('File logical size must be a non-negative safe integer within the blob limit')
		}

		const previousSize = this.reservedSizes.get(filePath)
		if (previousSize !== undefined) {
			if (previousSize !== size) {
				throw new Error('Conflicting logical sizes for the same file path')
			}
			return false
		}

		if (size > this.sizeLimit - this.total) {
			throw new SiteLogicalQuotaExceededError(filePath, size, this.total, this.sizeLimit)
		}
		this.reservedSizes.set(filePath, size)
		this.total += size
		return true
	}
}

/** Reserve the measured bytes synchronously before invoking the storage write. */
export async function reserveAndWriteWithinLogicalBudget<T>(
	budget: SiteLogicalSizeBudget,
	filePath: string,
	logicalSize: number,
	write: () => Promise<T>,
): Promise<T> {
	budget.reserve(filePath, logicalSize)
	return await write()
}

const TEXT_LIKE_MIME_TYPES = new Set([
	'text/html',
	'text/css',
	'text/javascript',
	'application/javascript',
	'application/json',
	'application/xml',
	'image/svg+xml',
])
const TEXT_LIKE_PATH_SUFFIXES = ['.html', '.htm', '.css', '.js', '.json', '.xml', '.svg']

function isTextLikeMime(mimeType?: string, path?: string): boolean {
	if (mimeType && TEXT_LIKE_MIME_TYPES.has(mimeType)) return true
	if (!path) return false
	const lowerPath = path.toLowerCase()
	return (
		lowerPath === '_redirects' ||
		lowerPath.endsWith('/_redirects') ||
		TEXT_LIKE_PATH_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix))
	)
}

function looksLikeBase64(content: Uint8Array): boolean {
	if (content.length === 0) return false
	let nonWhitespace = 0
	for (const byte of content) {
		const char = byte
		if (char === 0x0a || char === 0x0d || char === 0x20 || char === 0x09) {
			continue
		}
		nonWhitespace++
		const isBase64Char =
			(char >= 0x41 && char <= 0x5a) || // A-Z
			(char >= 0x61 && char <= 0x7a) || // a-z
			(char >= 0x30 && char <= 0x39) || // 0-9
			char === 0x2b || // +
			char === 0x2f || // /
			char === 0x3d // =
		if (!isBase64Char) return false
	}

	// Base64 length should be divisible by 4 (ignoring whitespace)
	return nonWhitespace % 4 === 0
}

function tryDecodeBase64(content: Uint8Array): Uint8Array | null {
	if (!looksLikeBase64(content)) return null
	const base64String = new TextDecoder().decode(content).replace(/\s+/g, '')
	try {
		return Buffer.from(base64String, 'base64')
	} catch {
		return null
	}
}

function isSafeEntryName(name: string): boolean {
	return (
		name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
	)
}

/** Build a storage-safe path for one untrusted manifest entry. */
function appendSafeEntryPath(pathPrefix: string, entryName: string): string {
	const currentPath = pathPrefix ? `${pathPrefix}/${entryName}` : entryName
	if (!isSafeEntryName(entryName)) throw new Error(`Unsafe filesystem entry name: ${currentPath}`)
	return currentPath
}

function createFileInfo(
	node: Entry['node'],
	path: string,
	ownerDidByFilePath: ReadonlyMap<string, string>,
): FileInfo | null {
	if (!('type' in node && node.type === 'file' && 'blob' in node)) return null
	const cid = extractBlobCid(node.blob)
	if (!cid) return null
	const ownerDid = ownerDidByFilePath.get(path)
	if (!ownerDid) throw new Error('Expanded file is missing its source repository')
	assertSourceIdentityIsBounded({ cid, ownerDid })
	return {
		path,
		cid,
		blob: node.blob,
		ownerDid,
		encoding: node.encoding,
		mimeType: node.mimeType,
		base64: node.base64,
	}
}

function collectFileInfoForEntry(
	entry: Entry,
	ownerDidByFilePath: ReadonlyMap<string, string>,
	pathPrefix: string,
): FileInfo[] {
	const path = appendSafeEntryPath(pathPrefix, entry.name)
	const node = entry.node
	if ('type' in node && node.type === 'directory' && 'entries' in node) {
		return collectFileInfo(node.entries, ownerDidByFilePath, path)
	}
	const file = createFileInfo(node, path, ownerDidByFilePath)
	return file ? [file] : []
}

/** Collect file metadata after SubFS expansion preserves source ownership. */
function collectFileInfo(
	entries: Entry[],
	ownerDidByFilePath: ReadonlyMap<string, string>,
	pathPrefix: string = '',
): FileInfo[] {
	return entries.flatMap((entry) => collectFileInfoForEntry(entry, ownerDidByFilePath, pathPrefix))
}

/**
 * Download a blob and write to S3
 */
interface DownloadedBlob {
	uncompressedSize: number
}

async function downloadAndWriteBlob(
	did: string,
	rkey: string,
	file: FileInfo,
	pdsEndpoint: string,
	logicalSizeBudget: SiteLogicalSizeBudget,
	resources?: RevalidationResources,
): Promise<DownloadedBlob> {
	assertRevalidationActive(resources)
	const blobUrl = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(file.ownerDid)}&cid=${encodeURIComponent(file.cid)}`
	const blobKey = `${file.ownerDid}:${file.cid}`

	const backoffUntil = getBackoffUntil(blobKey)
	if (backoffUntil) {
		throw new Blob500BackoffError(blobKey, backoffUntil)
	}

	// The permit begins before safeFetchBlob. It covers the whole lifetime of a
	// possibly 200 MiB body, base64/gzip expansion, HTML rewrite, and storage
	// write, rather than only the gzip portion after bytes are already buffered.
	return await blobProcessingGate.run(async () => {
		logger.debug(`Downloading ${file.path}`)

		let content: Uint8Array
		try {
			content = await safeFetchBlob(blobUrl, {
				maxSize: MAX_BLOB_SIZE,
				timeout: 300000,
				allowLocalhost: allowDevLocalPdsFetch,
				signal: resources?.signal,
				byteBudget: resources?.transferBudget,
			})
		} catch (err) {
			if (isHttp500Error(err)) {
				const until = set500Backoff(blobKey)
				logger.warn(`Caching blob HTTP 500 for ${BLOB_500_BACKOFF_MS}ms`, {
					did,
					rkey,
					path: file.path,
					cid: file.cid,
					sourceDid: file.ownerDid,
					backoffUntil: new Date(until).toISOString(),
				})
				throw new Blob500BackoffError(blobKey, until, err)
			}
			throw err
		}
		blob500BackoffUntil.delete(blobKey)
		const encoding = file.encoding

		// Decode base64 before gzip detection so legacy base64-wrapped gzip gets the
		// same bounded processing and logical-size accounting as normal gzip data.
		if (file.base64) {
			const base64String = new TextDecoder().decode(content)
			content = Buffer.from(base64String, 'base64')
		} else if (isTextLikeMime(file.mimeType, file.path)) {
			const decoded = tryDecodeBase64(content)
			if (decoded) {
				logger.warn(`Decoded base64 fallback for ${file.path} (base64 flag missing)`)
				content = decoded
			}
		}

		return await writePreparedBlob(did, rkey, file, content, encoding, logicalSizeBudget, resources)
	})
}

interface NormalizedBlobContent {
	content: Uint8Array
	encoding: FileInfo['encoding']
	shouldStayCompressed: boolean
}

interface MeasuredBlobContent {
	content: Uint8Array
	encoding: FileInfo['encoding']
	uncompressedSize: number
	decodedHtml?: Buffer<ArrayBuffer>
}

function normalizeBlobContent(
	file: FileInfo,
	inputContent: Uint8Array,
	initialEncoding: FileInfo['encoding'],
): NormalizedBlobContent {
	let content = inputContent
	let encoding = initialEncoding
	if (encoding === 'gzip' && !isGzipped(content)) {
		const decoded = tryDecodeBase64(content)
		if (!decoded || !isGzipped(decoded)) {
			throw new Error(`File ${file.path} is marked gzip but does not contain valid gzip data`)
		}
		logger.warn(`Decoded base64+gzip fallback for ${file.path}`)
		content = decoded
	}
	if (!encoding && isTextLikeMime(file.mimeType, file.path) && isGzipped(content)) encoding = 'gzip'
	return {
		content,
		encoding,
		shouldStayCompressed: !isRedirectsFile(file.path) && shouldCompressMimeType(file.mimeType),
	}
}

async function measureBlobContent(file: FileInfo, normalized: NormalizedBlobContent): Promise<MeasuredBlobContent> {
	const logicalSizeLimit = getLogicalFileSizeLimit(file.path)
	if (normalized.encoding !== 'gzip') {
		return { ...normalized, uncompressedSize: normalized.content.byteLength }
	}
	if (!normalized.shouldStayCompressed) {
		const content = await decompress(normalized.content, logicalSizeLimit)
		return {
			content,
			encoding: undefined,
			uncompressedSize: content.byteLength,
			...(isHtmlContent(file.path) ? { decodedHtml: content } : {}),
		}
	}
	if (isHtmlContent(file.path)) {
		const decodedHtml = await decompress(normalized.content, logicalSizeLimit)
		return { ...normalized, uncompressedSize: decodedHtml.byteLength, decodedHtml }
	}
	const uncompressedSize = await measureDecompressedSize(normalized.content, logicalSizeLimit)
	return { ...normalized, uncompressedSize }
}

function createOriginalFileMetadata(
	file: FileInfo,
	encoding: FileInfo['encoding'],
	uncompressedSize: number,
): Record<string, string> {
	const metadata: Record<string, string> = {
		base64: `${file.base64 === true}`,
		uncompressedSize: `${uncompressedSize}`,
		...createSourceIdentityMetadata(file),
	}
	if (encoding) metadata.encoding = encoding
	if (file.mimeType) metadata.mimeType = file.mimeType
	return metadata
}

async function writeRewrittenHtml(
	did: string,
	rkey: string,
	file: FileInfo,
	prepared: MeasuredBlobContent,
	resources?: RevalidationResources,
): Promise<void> {
	if (!isHtmlContent(file.path)) return
	try {
		assertRevalidationActive(resources)
		const htmlString = new TextDecoder().decode(prepared.decodedHtml ?? prepared.content)
		const rewritten = await rewriteHtmlPaths(htmlString, `/${did}/${rkey}/`)
		const rewrittenContent = new TextEncoder().encode(rewritten)
		assertRevalidationActive(resources)
		if (rewrittenContent.byteLength > MAX_BLOB_SIZE) {
			throw new Error(`Rewritten HTML exceeds the ${MAX_BLOB_SIZE}-byte file limit`)
		}
		const rewrittenKey = `${did}/${rkey}/.rewritten/${file.path}`
		await writeFile(rewrittenKey, rewrittenContent, createRewrittenHtmlMetadata(file))
		logger.debug(`Wrote rewritten HTML: ${rewrittenKey}`)
	} catch {
		logger.error(`Failed to cache rewritten HTML for ${file.path}; continuing with original`, undefined, {
			did,
			rkey,
			path: file.path,
		})
	}
}

async function writePreparedBlob(
	did: string,
	rkey: string,
	file: FileInfo,
	inputContent: Uint8Array,
	initialEncoding: FileInfo['encoding'],
	logicalSizeBudget: SiteLogicalSizeBudget,
	resources?: RevalidationResources,
): Promise<DownloadedBlob> {
	assertRevalidationActive(resources)
	const prepared = await measureBlobContent(file, normalizeBlobContent(file, inputContent, initialEncoding))
	assertRevalidationActive(resources)
	assertLogicalFileSizeWithinLimit(file.path, prepared.uncompressedSize)
	const key = `${did}/${rkey}/${file.path}`
	const metadata = createOriginalFileMetadata(file, prepared.encoding, prepared.uncompressedSize)
	await reserveAndWriteWithinLogicalBudget(logicalSizeBudget, file.path, prepared.uncompressedSize, () =>
		writeFile(key, prepared.content, metadata),
	)
	await writeRewrittenHtml(did, rkey, file, prepared, resources)
	logger.debug(
		`Stored ${file.path} (${prepared.content.length} stored bytes, ${prepared.uncompressedSize} logical bytes)`,
	)
	return { uncompressedSize: prepared.uncompressedSize }
}

export interface SiteUpdateOptions {
	forceRewriteHtml?: boolean
	skipInvalidation?: boolean
	forceDownload?: boolean
	/** Caller-owned wall deadline and transfer budget for firehose recovery. */
	resources?: RevalidationResources
}

interface SiteUpdateRequest {
	did: string
	rkey: string
	record: WispFsRecord
	recordCid: string
	forceRewriteHtml: boolean
	forceDownload: boolean
	skipInvalidation: boolean
	resources?: RevalidationResources
}

interface ValidatedSiteUpdate {
	request: SiteUpdateRequest
	pdsEndpoint: string
	resolveSourcePdsEndpoint: PdsEndpointResolver
	expandedRoot: Directory
	ownerDidByFilePath: ReadonlyMap<string, string>
	sizeLimit: number
	resources?: RevalidationResources
}

interface SiteUpdateLedger {
	oldFileCids: Record<string, string>
	effectiveForceDownload: boolean
}

interface SiteFilePlan {
	update: ValidatedSiteUpdate
	invalidationToken?: string
	newFileCids: Record<string, string>
	newFiles: FileInfo[]
	filesToDownload: FileInfo[]
	pathsToDelete: string[]
}

interface AccountedSiteFilePlan extends SiteFilePlan {
	uncompressedSizes: Map<string, number>
	logicalSizeBudget: SiteLogicalSizeBudget
}

interface DownloadFailure {
	path: string
	error: unknown
}

interface DeleteFailure {
	key: string
	error: unknown
}

function createSiteUpdateRequest(
	did: string,
	rkey: string,
	record: WispFsRecord,
	recordCid: string,
	options?: SiteUpdateOptions,
): SiteUpdateRequest {
	return {
		did,
		rkey,
		record,
		recordCid,
		forceRewriteHtml: options?.forceRewriteHtml === true,
		forceDownload: options?.forceDownload === true,
		skipInvalidation: options?.skipInvalidation === true,
		resources: options?.resources,
	}
}

async function resolveSiteUpdatePdsEndpoint(
	request: SiteUpdateRequest,
	resources?: RevalidationResources,
): Promise<string | null> {
	assertRevalidationActive(resources)
	const resolved = await resolvePdsEndpoint(request.did, resources)
	const pdsEndpoint = resolved ? rewritePdsEndpoint(resolved) : null
	if (!pdsEndpoint) logger.error('Could not resolve PDS', undefined, { did: request.did })
	return pdsEndpoint
}

async function expandSiteUpdateRoot(
	request: SiteUpdateRequest,
	root: Directory,
	resolveSourcePdsEndpoint: PdsEndpointResolver,
	resources?: RevalidationResources,
): Promise<{ expandedRoot: Directory; ownerDidByFilePath: ReadonlyMap<string, string> }> {
	try {
		const expanded = await expandSubfs(root, {
			rootOwnerDid: request.did,
			fetchSubfsRecord: (subject) => fetchSubfsRecord(subject, resolveSourcePdsEndpoint, resources),
			signal: resources?.signal,
			byteBudget: resources?.transferBudget,
			limits: SUBFS_EXPANSION_LIMITS,
		})
		return { expandedRoot: expanded.root, ownerDidByFilePath: expanded.ownerDidByFilePath }
	} catch (error) {
		const code = error instanceof SubfsExpansionError ? error.code : 'FETCH_FAILED'
		logger.warn('SubFS expansion failed; site update aborted', { did: request.did, rkey: request.rkey, code })
		throw error
	}
}

function validateExpandedSiteLimits(root: Directory, sizeLimit: number): boolean {
	const fileCount = countFilesInDirectory(root)
	if (fileCount > MAX_FILE_COUNT) {
		logger.error(`Site exceeds file limit: ${fileCount} > ${MAX_FILE_COUNT}`)
		return false
	}
	const totalSize = calculateTotalBlobSize(root)
	if (totalSize > sizeLimit) {
		logger.error(`Site exceeds size limit: ${totalSize} > ${sizeLimit}`)
		return false
	}
	return true
}

/** Validate all data that must succeed before the update marker is published. */
async function validateSiteUpdate(
	request: SiteUpdateRequest,
	resources?: RevalidationResources,
): Promise<ValidatedSiteUpdate | null> {
	assertRevalidationActive(resources)
	const root = request.record.root
	if (!root?.entries) {
		logger.error('Invalid record structure')
		return null
	}
	const pdsEndpoint = await resolveSiteUpdatePdsEndpoint(request, resources)
	if (!pdsEndpoint) return null
	const resolveSourcePdsEndpoint = createPdsEndpointResolver(request.did, pdsEndpoint)
	const expanded = await expandSiteUpdateRoot(request, root, resolveSourcePdsEndpoint, resources)
	const sizeLimit = (await isSupporter(request.did)) ? MAX_SITE_SIZE_SUPPORTER : MAX_SITE_SIZE
	if (!validateExpandedSiteLimits(expanded.expandedRoot, sizeLimit)) return null
	return { request, pdsEndpoint, resolveSourcePdsEndpoint, sizeLimit, resources, ...expanded }
}

function warnOnUnexpectedCachedFileCids(did: string, rkey: string, rawFileCids: unknown, source: string): void {
	if (source !== 'string-invalid' && source !== 'other') return
	logger.warn('Existing file_cids had unexpected shape; treating as empty', {
		did,
		rkey,
		type: Array.isArray(rawFileCids) ? 'array' : typeof rawFileCids,
	})
}

/** Load the previous ledger before the update marker protects any mutations. */
async function loadSiteUpdateLedger(update: ValidatedSiteUpdate): Promise<SiteUpdateLedger> {
	const existing = await getSiteCache(update.request.did, update.request.rkey)
	const rawFileCids = existing?.file_cids as unknown
	const normalized = normalizeFileCids(rawFileCids)
	warnOnUnexpectedCachedFileCids(update.request.did, update.request.rkey, rawFileCids, normalized.source)
	const needsFullColdSync = !!existing && existing.cold_synced !== true
	if (needsFullColdSync) {
		logger.info(`Cold tier not yet synced for ${update.request.did}/${update.request.rkey}; forcing full download`, {
			did: update.request.did,
			rkey: update.request.rkey,
		})
	}
	return { oldFileCids: normalized.value, effectiveForceDownload: update.request.forceDownload || needsFullColdSync }
}

async function markSiteUpdateInProgress(update: ValidatedSiteUpdate): Promise<string | undefined> {
	if (update.request.skipInvalidation) return undefined
	const token = crypto.randomUUID()
	await publishCacheInvalidation(update.request.did, update.request.rkey, 'updating', token)
	return token
}

function appendUniqueDownload(files: FileInfo[], paths: Set<string>, file: FileInfo): void {
	if (paths.has(file.path)) return
	paths.add(file.path)
	files.push(file)
}

export interface FileChangePlan {
	downloadPaths: ReadonlySet<string>
	downloadFileCids: ReadonlyMap<string, string>
	pathsToDelete: string[]
}

/** Pure manifest/ledger diff used by the planning stage before any blob work. */
export function planFileChanges(
	files: ReadonlyArray<Pick<FileInfo, 'path' | 'cid'>>,
	oldFileCids: Record<string, string>,
	effectiveForceDownload: boolean,
	forceRewriteHtml: boolean,
): FileChangePlan {
	const downloadFileCids = new Map<string, string>()
	const currentPaths = new Set<string>()
	for (const file of files) {
		currentPaths.add(file.path)
		const needsDownload =
			effectiveForceDownload || oldFileCids[file.path] !== file.cid || (forceRewriteHtml && isHtmlContent(file.path))
		if (needsDownload && !downloadFileCids.has(file.path)) downloadFileCids.set(file.path, file.cid)
	}
	return {
		downloadPaths: new Set(downloadFileCids.keys()),
		downloadFileCids,
		pathsToDelete: Object.keys(oldFileCids).filter((path) => !currentPaths.has(path)),
	}
}

function selectPlannedFiles(files: FileInfo[], plannedCids: ReadonlyMap<string, string>): FileInfo[] {
	const selected: FileInfo[] = []
	const selectedPaths = new Set<string>()
	for (const file of files) {
		if (plannedCids.get(file.path) === file.cid) appendUniqueDownload(selected, selectedPaths, file)
	}
	return selected
}

/** Build the manifest-derived file plan while the updating marker is active. */
function planSiteFiles(
	update: ValidatedSiteUpdate,
	ledger: SiteUpdateLedger,
	invalidationToken?: string,
): SiteFilePlan {
	const newFileCids: Record<string, string> = {}
	collectFileCidsFromEntries(update.expandedRoot.entries, '', newFileCids)
	const newFiles = collectFileInfo(update.expandedRoot.entries, update.ownerDidByFilePath)
	const changes = planFileChanges(
		newFiles,
		ledger.oldFileCids,
		ledger.effectiveForceDownload,
		update.request.forceRewriteHtml,
	)
	return {
		update,
		invalidationToken,
		newFileCids,
		newFiles,
		filesToDownload: selectPlannedFiles(newFiles, changes.downloadFileCids),
		pathsToDelete: changes.pathsToDelete,
	}
}

interface AccountingProbe {
	file: FileInfo
	storedSize: number | null
	metadataReadFailed: boolean
}

async function probeStoredFileAccounting(did: string, rkey: string, file: FileInfo): Promise<AccountingProbe> {
	try {
		const metadata = await getFileMetadata(`${did}/${rkey}/${file.path}`)
		return { file, storedSize: getStoredUncompressedSize(metadata, file), metadataReadFailed: false }
	} catch {
		return { file, storedSize: null, metadataReadFailed: true }
	}
}

function applyAccountingProbe(
	probe: AccountingProbe,
	uncompressedSizes: Map<string, number>,
	filesToDownload: FileInfo[],
	downloadPaths: Set<string>,
	update: ValidatedSiteUpdate,
): boolean {
	if (probe.storedSize !== null) {
		uncompressedSizes.set(probe.file.path, probe.storedSize)
		return false
	}
	appendUniqueDownload(filesToDownload, downloadPaths, probe.file)
	if (probe.metadataReadFailed) {
		logger.warn('Could not read cached logical size; re-downloading file for safe accounting', {
			did: update.request.did,
			rkey: update.request.rkey,
			path: probe.file.path,
		})
	}
	return true
}

/** Reuse trusted logical sizes and queue stale/legacy objects for safe refresh. */
async function accountSiteFiles(plan: SiteFilePlan): Promise<AccountedSiteFilePlan> {
	const uncompressedSizes = new Map<string, number>()
	const filesToDownload = [...plan.filesToDownload]
	const downloadPaths = new Set(filesToDownload.map((file) => file.path))
	const unchangedFiles = plan.newFiles.filter((file) => !downloadPaths.has(file.path))
	let accountingRefreshes = 0
	for (let index = 0; index < unchangedFiles.length; index += 20) {
		assertRevalidationActive(plan.update.resources)
		const batch = unchangedFiles.slice(index, index + 20)
		const probes = await Promise.all(
			batch.map((file) => probeStoredFileAccounting(plan.update.request.did, plan.update.request.rkey, file)),
		)
		for (const probe of probes)
			accountingRefreshes += Number(
				applyAccountingProbe(probe, uncompressedSizes, filesToDownload, downloadPaths, plan.update),
			)
	}
	logger.info(
		`Files unchanged: ${unchangedFiles.length - accountingRefreshes}, accounting refreshes: ${accountingRefreshes}, to download: ${filesToDownload.length}, to delete: ${plan.pathsToDelete.length}`,
	)
	return {
		...plan,
		filesToDownload,
		uncompressedSizes,
		logicalSizeBudget: new SiteLogicalSizeBudget(plan.update.sizeLimit, uncompressedSizes),
	}
}

function isTerminalIngestError(error: unknown): boolean {
	return (
		error instanceof SiteLogicalQuotaExceededError ||
		error instanceof FileLogicalSizeLimitError ||
		error instanceof DecompressionLimitError
	)
}

async function downloadPlannedFile(plan: AccountedSiteFilePlan, file: FileInfo): Promise<DownloadedBlob> {
	assertRevalidationActive(plan.update.resources)
	const endpoint = await plan.update.resolveSourcePdsEndpoint(file.ownerDid, plan.update.resources)
	return await downloadAndWriteBlob(
		plan.update.request.did,
		plan.update.request.rkey,
		file,
		endpoint,
		plan.logicalSizeBudget,
		plan.update.resources,
	)
}

/** Download serial bounded batches; terminal limit failures stop the entire update. */
async function downloadSiteFiles(
	plan: AccountedSiteFilePlan,
	files: FileInfo[] = plan.filesToDownload,
): Promise<DownloadFailure[]> {
	const failures: DownloadFailure[] = []
	for (let index = 0; index < files.length; index += DOWNLOAD_CONCURRENCY) {
		assertRevalidationActive(plan.update.resources)
		for (const file of files.slice(index, index + DOWNLOAD_CONCURRENCY)) {
			try {
				assertRevalidationActive(plan.update.resources)
				const result = await downloadPlannedFile(plan, file)
				plan.uncompressedSizes.set(file.path, result.uncompressedSize)
			} catch (error) {
				if (isTerminalIngestError(error)) throw error
				failures.push({ path: file.path, error })
			}
		}
	}
	return failures
}

function getDeleteKeys(plan: SiteFilePlan): string[] {
	return plan.pathsToDelete.flatMap((path) => {
		const key = `${plan.update.request.did}/${plan.update.request.rkey}/${path}`
		return isHtmlContent(path)
			? [key, `${plan.update.request.did}/${plan.update.request.rkey}/.rewritten/${path}`]
			: [key]
	})
}

function collectDeleteFailures(keys: string[], results: PromiseSettledResult<void>[]): DeleteFailure[] {
	return results.flatMap((result, index) =>
		result.status === 'rejected' && keys[index] ? [{ key: keys[index], error: result.reason }] : [],
	)
}

/** Delete removed original and rewritten keys after the new writes finish. */
async function deleteSiteFiles(plan: SiteFilePlan): Promise<DeleteFailure[]> {
	return await deleteSiteKeys(getDeleteKeys(plan))
}

interface BlobBackoffSummary {
	until: number | null
	allBackedOff: boolean
}

function summarizeBlobBackoff(failures: DownloadFailure[]): BlobBackoffSummary {
	const until = failures.reduce<number | null>((latest, failure) => {
		const candidate = getBlobBackoffUntil(failure.error)
		return !candidate ? latest : latest ? Math.max(latest, candidate) : candidate
	}, null)
	return {
		until,
		allBackedOff: failures.length > 0 && failures.every((failure) => getBlobBackoffUntil(failure.error) !== null),
	}
}

function throwIfDownloadsBackedOff(
	update: ValidatedSiteUpdate,
	failures: DownloadFailure[],
	deleteFailures: DeleteFailure[],
): void {
	const summary = summarizeBlobBackoff(failures)
	if (!summary.allBackedOff || deleteFailures.length > 0 || !summary.until) return
	logger.warn(`Incremental sync blocked by blob backoff for ${update.request.did}/${update.request.rkey}`, {
		did: update.request.did,
		rkey: update.request.rkey,
		downloadFailures: failures.length,
		backoffUntil: new Date(summary.until).toISOString(),
	})
	throw new SiteBlobBackoffError(update.request.did, update.request.rkey, summary.until, failures.length)
}

async function publishUpdateAfterFailure(plan: SiteFilePlan): Promise<void> {
	if (!plan.update.request.skipInvalidation) {
		await publishCacheInvalidation(
			plan.update.request.did,
			plan.update.request.rkey,
			'update',
			plan.invalidationToken,
		).catch(() => undefined)
	}
}

async function retryDownloadFailures(plan: AccountedSiteFilePlan, failures: DownloadFailure[]): Promise<void> {
	if (failures.length === 0) return
	const failedPaths = new Set(failures.map((failure) => failure.path))
	const retryFailures = await downloadSiteFiles(
		plan,
		plan.filesToDownload.filter((file) => failedPaths.has(file.path)),
	)
	if (retryFailures.length === 0) return
	logger.error(
		`Retry of failed downloads failed for ${plan.update.request.did}/${plan.update.request.rkey}`,
		undefined,
		{
			did: plan.update.request.did,
			rkey: plan.update.request.rkey,
			retryDownloadFailures: retryFailures.length,
			samplePaths: retryFailures.slice(0, 5).map((failure) => failure.path),
		},
	)
	await publishUpdateAfterFailure(plan)
	const summary = summarizeBlobBackoff(retryFailures)
	if (summary.allBackedOff && summary.until) {
		throw new SiteBlobBackoffError(
			plan.update.request.did,
			plan.update.request.rkey,
			summary.until,
			retryFailures.length,
		)
	}
	throw new Error(`Failed to download files for ${plan.update.request.did}/${plan.update.request.rkey}`)
}

async function retryDeleteFailures(plan: SiteFilePlan, failures: DeleteFailure[]): Promise<void> {
	if (failures.length === 0) return
	const retryFailures = await deleteSiteKeys(failures.map((failure) => failure.key))
	if (retryFailures.length === 0) return
	logger.error(`Retry of failed deletes failed for ${plan.update.request.did}/${plan.update.request.rkey}`, undefined, {
		did: plan.update.request.did,
		rkey: plan.update.request.rkey,
		retryDeleteFailures: retryFailures.length,
		sampleKeys: retryFailures.slice(0, 5).map((failure) => failure.key),
	})
	await publishUpdateAfterFailure(plan)
	throw new Error(`Failed to delete files for ${plan.update.request.did}/${plan.update.request.rkey}`)
}

async function deleteSiteKeys(keys: string[]): Promise<DeleteFailure[]> {
	const failures: DeleteFailure[] = []
	for (let index = 0; index < keys.length; index += 50) {
		const batch = keys.slice(index, index + 50)
		failures.push(...collectDeleteFailures(batch, await Promise.allSettled(batch.map((key) => deleteFile(key)))))
	}
	return failures
}

/** Preserve the existing one-retry recovery and blob-backoff behavior. */
async function recoverSiteFileFailures(
	plan: AccountedSiteFilePlan,
	downloadFailures: DownloadFailure[],
	deleteFailures: DeleteFailure[],
): Promise<void> {
	throwIfDownloadsBackedOff(plan.update, downloadFailures, deleteFailures)
	if (downloadFailures.length === 0 && deleteFailures.length === 0) return
	logger.warn(
		`Incremental sync had failures for ${plan.update.request.did}/${plan.update.request.rkey}; retrying failed operations`,
		{
			did: plan.update.request.did,
			rkey: plan.update.request.rkey,
			downloadFailures: downloadFailures.length,
			deleteFailures: deleteFailures.length,
		},
	)
	await retryDownloadFailures(plan, downloadFailures)
	await retryDeleteFailures(plan, deleteFailures)
}

async function validateFinalSiteAccounting(plan: AccountedSiteFilePlan): Promise<void> {
	try {
		assertRevalidationActive(plan.update.resources)
		const total = validateUncompressedSiteSize(plan.newFiles, plan.uncompressedSizes, plan.update.sizeLimit)
		logger.info(`Validated uncompressed site size for ${plan.update.request.did}/${plan.update.request.rkey}`, {
			totalUncompressedSize: total,
			sizeLimit: plan.update.sizeLimit,
		})
	} catch (error) {
		logger.error(
			`Site exceeds or lacks uncompressed size accounting for ${plan.update.request.did}/${plan.update.request.rkey}`,
			undefined,
			{
				did: plan.update.request.did,
				rkey: plan.update.request.rkey,
				sizeLimit: plan.update.sizeLimit,
			},
		)
		await publishUpdateAfterFailure(plan)
		throw error
	}
}

async function commitSiteLedger(plan: AccountedSiteFilePlan): Promise<void> {
	const { did, rkey, recordCid } = plan.update.request
	const resources = plan.update.resources
	// The final ledger/settings writes are the point of no return. Check the
	// active resources before and after each awaited operation so a stop or
	// deadline cannot begin the next mutation after the operation is fenced.
	assertRevalidationActive(resources)
	logger.debug(`About to upsert site cache for ${did}/${rkey}`)
	await upsertSiteCache(did, rkey, recordCid, plan.newFileCids)
	assertRevalidationActive(resources)
	logger.debug(`Updated site cache for ${did}/${rkey} with record CID ${recordCid}`)
	const settingsRecord = await fetchSettingsRecord(did, rkey, plan.update.pdsEndpoint, resources)
	assertRevalidationActive(resources)
	if (settingsRecord)
		// commitSiteLedger already runs under the site lock. Calling the public
		// settings wrapper here would recursively acquire the same advisory lock.
		await handleSettingsUpdateLocked(
			did,
			rkey,
			settingsRecord.record,
			settingsRecord.cid,
			{ skipInvalidation: true, resources },
			defaultSettingsWriteDependencies,
		)
	assertRevalidationActive(resources)
}

/** Commit only after every logical byte has been accounted for. */
async function commitSiteUpdate(plan: AccountedSiteFilePlan): Promise<void> {
	await validateFinalSiteAccounting(plan)
	await commitSiteLedger(plan)
}

async function notifySiteUpdateComplete(plan: SiteFilePlan): Promise<void> {
	if (!plan.update.request.skipInvalidation) {
		await publishCacheInvalidation(plan.update.request.did, plan.update.request.rkey, 'update', plan.invalidationToken)
	}
}

async function downloadSiteFilesOrFailClosed(plan: AccountedSiteFilePlan): Promise<DownloadFailure[]> {
	try {
		return await downloadSiteFiles(plan)
	} catch (error) {
		if (error instanceof SiteLogicalQuotaExceededError) {
			logger.error('Site logical quota reached before storage write; update left pending for repair', undefined, {
				did: plan.update.request.did,
				rkey: plan.update.request.rkey,
				sizeLimit: plan.update.sizeLimit,
				totalBeforeReserve: error.totalBeforeReserve,
			})
		}
		throw error
	}
}

/** Dependencies used by the locked update reconciliation seam and its tests. */
export interface SiteUpdateHandlerDependencies {
	fetchAuthoritativeSiteRecord: typeof fetchAuthoritativeSiteRecord
	/** Optional test seam; production uses the locked materializer below. */
	materializeCurrentRecord?: (
		did: string,
		rkey: string,
		record: WispFsRecord,
		cid: string,
		options?: SiteUpdateOptions,
	) => Promise<void>
	withSiteWriteLock: typeof withSiteWriteLock
}

const defaultSiteUpdateHandlerDependencies: SiteUpdateHandlerDependencies = {
	fetchAuthoritativeSiteRecord,
	materializeCurrentRecord: async (did, rkey, record, cid, options) => {
		// This runs while the update already holds the site's advisory lock. Do not
		// call the public wrapper here or it would try to acquire the same lock.
		await handleSiteCreateOrUpdateLocked(did, rkey, record, cid, options)
	},
	withSiteWriteLock,
}

/**
 * Reconcile a create/update against the authoritative PDS state while the site
 * lock is held. The firehose record is only a hint: a delayed C1 must not be
 * materialized after a newer C2 has already won the lock.
 *
 * A confirmed absence is a no-op. An update event must never turn an ordinary
 * missing record into a destructive delete; the delete event has its own
 * locked reconciliation path. Lookup/validation failures are thrown so the
 * caller can retain/requeue the event instead of acknowledging uncertain state.
 */
export async function reconcileSiteUpdateUnderLock(
	did: string,
	rkey: string,
	_recordHint: WispFsRecord,
	_recordCidHint: string,
	options?: SiteUpdateOptions,
	dependencies: SiteUpdateHandlerDependencies = defaultSiteUpdateHandlerDependencies,
): Promise<void> {
	const currentRecord = await dependencies.fetchAuthoritativeSiteRecord(did, rkey, options?.resources)
	if (!currentRecord) {
		logger.info('[CacheWriter] Site is absent during update reconciliation; leaving existing cache unchanged', {
			did,
			rkey,
		})
		return
	}

	if (dependencies.materializeCurrentRecord) {
		await dependencies.materializeCurrentRecord(did, rkey, currentRecord.record, currentRecord.cid, options)
		return
	}
	await handleSiteCreateOrUpdateLocked(did, rkey, currentRecord.record, currentRecord.cid, options)
}

/**
 * Handle a site create/update event under one site lock and one updating marker.
 * The passed firehose record is retained as a hint for API compatibility, but
 * the authoritative record is fetched only after this function acquires the
 * lock.
 */
export async function handleSiteCreateOrUpdate(
	did: string,
	rkey: string,
	record: WispFsRecord,
	recordCid: string,
	options?: SiteUpdateOptions,
	dependencies: SiteUpdateHandlerDependencies = defaultSiteUpdateHandlerDependencies,
): Promise<void> {
	return dependencies.withSiteWriteLock(
		did,
		rkey,
		() => reconcileSiteUpdateUnderLock(did, rkey, record, recordCid, options, dependencies),
		options?.resources?.signal,
	)
}

async function handleSiteCreateOrUpdateLocked(
	did: string,
	rkey: string,
	record: WispFsRecord,
	recordCid: string,
	options?: SiteUpdateOptions,
): Promise<void> {
	const request = createSiteUpdateRequest(did, rkey, record, recordCid, options)
	logger.info(`Processing site ${did}/${rkey}`, {
		recordCid,
		forceRewriteHtml: request.forceRewriteHtml,
		forceDownload: request.forceDownload,
	})
	const update = await validateSiteUpdate(request, request.resources)
	if (!update) return
	const ledger = await loadSiteUpdateLedger(update)
	const invalidationToken = await markSiteUpdateInProgress(update)
	const plan = planSiteFiles(update, ledger, invalidationToken)
	const accountedPlan = await accountSiteFiles(plan)
	const downloadFailures = await downloadSiteFilesOrFailClosed(accountedPlan)
	const deleteFailures = await deleteSiteFiles(accountedPlan)
	await recoverSiteFileFailures(accountedPlan, downloadFailures, deleteFailures)
	await commitSiteUpdate(accountedPlan)
	await notifySiteUpdateComplete(accountedPlan)
	logger.info(`Successfully cached site ${did}/${rkey}`)
}

export interface SiteDeleteDependencies {
	listFiles: typeof listFiles
	deleteFile: typeof deleteFile
	markSiteCacheDeleted: typeof markSiteCacheDeleted
	publishCacheInvalidation: typeof publishCacheInvalidation
}

/** Dependencies used by the locked delete reconciliation seam and its tests. */
export interface SiteDeleteHandlerDependencies extends SiteDeleteDependencies {
	fetchAuthoritativeSiteRecord: typeof fetchAuthoritativeSiteRecord
	materializeCurrentRecord(
		did: string,
		rkey: string,
		record: WispFsRecord,
		cid: string,
		resources?: RevalidationResources,
	): Promise<void>
	withSiteWriteLock: typeof withSiteWriteLock
}

const defaultSiteDeleteDependencies: SiteDeleteDependencies = {
	listFiles,
	deleteFile,
	markSiteCacheDeleted,
	publishCacheInvalidation,
}

const defaultSiteDeleteHandlerDependencies: SiteDeleteHandlerDependencies = {
	...defaultSiteDeleteDependencies,
	fetchAuthoritativeSiteRecord,
	materializeCurrentRecord: async (did, rkey, record, cid, resources) => {
		// This runs while the delete already holds the site's advisory lock. Do not
		// call the public wrapper here or it would try to acquire the same lock.
		await handleSiteCreateOrUpdateLocked(did, rkey, record, cid, { forceDownload: true, resources })
	},
	withSiteWriteLock,
}

async function publishSiteDeleteInvalidation(
	dependencies: SiteDeleteDependencies,
	did: string,
	rkey: string,
	action: 'updating' | 'delete',
	token: string,
): Promise<void> {
	try {
		await dependencies.publishCacheInvalidation(did, rkey, action, token)
	} catch {
		// Invalidation is best effort. It must not strand a site half-deleted or
		// turn an already-completed delete into a retryable failure.
		logger.warn(`[CacheWriter] Failed to publish ${action} invalidation during site delete`, { did, rkey, action })
	}
}

/**
 * Execute the destructive portion of a site delete while the caller holds the
 * site write lock. Exported to make the invalidation ordering testable without
 * real storage, Redis, or Postgres.
 */
export async function executeSiteDelete(
	did: string,
	rkey: string,
	dependencies: SiteDeleteDependencies = defaultSiteDeleteDependencies,
	resources?: RevalidationResources,
): Promise<void> {
	assertRevalidationActive(resources)
	logger.info(`Deleting site ${did}/${rkey}`)

	// Mark the site unavailable before the first destructive storage operation.
	// The matching terminal token clears this marker only after every file and
	// the DB ledger are gone. If deletion throws, the marker remains until the
	// durable tombstone retry completes (or the hosting-service marker TTL ends).
	const invalidationToken = crypto.randomUUID()
	await publishSiteDeleteInvalidation(dependencies, did, rkey, 'updating', invalidationToken)
	assertRevalidationActive(resources)

	const prefix = `${did}/${rkey}/`
	const keys = await dependencies.listFiles(prefix)
	assertRevalidationActive(resources)
	for (const key of keys) {
		assertRevalidationActive(resources)
		await dependencies.deleteFile(key)
	}

	assertRevalidationActive(resources)
	await dependencies.markSiteCacheDeleted(did, rkey)
	assertRevalidationActive(resources)
	await publishSiteDeleteInvalidation(dependencies, did, rkey, 'delete', invalidationToken)

	logger.info(`Deleted site ${did}/${rkey} (${keys.length} files)`)
}

/** Reconcile a delete against the authoritative PDS state while the site lock is held. */
export async function reconcileSiteDeleteUnderLock(
	did: string,
	rkey: string,
	dependencies: SiteDeleteHandlerDependencies = defaultSiteDeleteHandlerDependencies,
	resources?: RevalidationResources,
): Promise<void> {
	// A late delete event can acquire the lock after a newer leader materialized
	// a recreated record. Only a confirmed PDS absence permits destructive work;
	// unavailable or invalid reads throw and leave the existing cache untouched.
	assertRevalidationActive(resources)
	const currentRecord = await dependencies.fetchAuthoritativeSiteRecord(did, rkey, resources)
	assertRevalidationActive(resources)
	if (currentRecord) {
		logger.info(`[CacheWriter] Site exists during delete reconciliation; materializing current record instead`, {
			did,
			rkey,
		})
		await dependencies.materializeCurrentRecord(did, rkey, currentRecord.record, currentRecord.cid, resources)
		return
	}

	await executeSiteDelete(did, rkey, dependencies, resources)
}

/**
 * Handle a site delete event.
 *
 * Holds the same per-site write lock as create/update. Under that lock it
 * re-reads the authoritative record, so a stale delete reconciles a reappeared
 * site rather than deleting state produced by a newer leader.
 */
export async function handleSiteDelete(
	did: string,
	rkey: string,
	dependencies: SiteDeleteHandlerDependencies = defaultSiteDeleteHandlerDependencies,
	resources?: RevalidationResources,
): Promise<void> {
	return await dependencies.withSiteWriteLock(
		did,
		rkey,
		async () => {
			await reconcileSiteDeleteUnderLock(did, rkey, dependencies, resources)
		},
		resources?.signal,
	)
}

export interface SettingsUpdateOptions {
	skipInvalidation?: boolean
	resources?: RevalidationResources
	/**
	 * Optional authoritative lookup seam. When supplied, it is called only after
	 * the per-site lock has been acquired; event/revalidation callers must never
	 * pass a record fetched before that lock as authoritative state.
	 */
	fetchSettingsRecordOutcome?: typeof fetchSettingsRecordOutcome
}

/** Dependencies shared by standalone settings writes and their test seams. */
export interface SettingsWriteDependencies {
	upsertSiteSettingsCache: typeof upsertSiteSettingsCache
	deleteSiteSettingsCache: typeof deleteSiteSettingsCache
	publishCacheInvalidation: typeof publishCacheInvalidation
	withSiteWriteLock: typeof withSiteWriteLock
	/** Optional test seam; production uses the authoritative PDS lookup below. */
	fetchSettingsRecordOutcome?: typeof fetchSettingsRecordOutcome
}

const defaultSettingsWriteDependencies: SettingsWriteDependencies = {
	upsertSiteSettingsCache,
	deleteSiteSettingsCache,
	publishCacheInvalidation,
	withSiteWriteLock,
	fetchSettingsRecordOutcome,
}

/**
 * Perform the settings write while the caller already holds the site lock.
 * `commitSiteLedger` uses this inner variant to avoid recursively acquiring
 * the same session-scoped advisory lock.
 */
export async function handleSettingsUpdateLocked(
	did: string,
	rkey: string,
	settings: WispSettings,
	recordCid: string,
	options?: SettingsUpdateOptions,
	dependencies: SettingsWriteDependencies = defaultSettingsWriteDependencies,
): Promise<void> {
	const resources = options?.resources
	assertRevalidationActive(resources)
	logger.info(`Updating settings for ${did}/${rkey}`)

	await dependencies.upsertSiteSettingsCache(did, rkey, recordCid, {
		directoryListing: settings.directoryListing,
		spaMode: settings.spaMode,
		custom404: settings.custom404,
		indexFiles: settings.indexFiles,
		cleanUrls: settings.cleanUrls,
		headers: settings.headers,
	})
	assertRevalidationActive(resources)

	// Notify hosting-service to invalidate its local caches (redirect rules depend on settings)
	if (!options?.skipInvalidation) {
		await dependencies.publishCacheInvalidation(did, rkey, 'settings')
		assertRevalidationActive(resources)
	}
}

/**
 * Perform the authoritative settings reconciliation while the caller already
 * holds the site lock. Event payloads are hints only: a delayed update/delete
 * must never mutate state based on a record fetched before the lock.
 *
 * Only a confirmed PDS absence permits deleting the settings cache. A
 * retryable, invalid, or failed lookup throws before either cache primitive is
 * called, so uncertain state remains available for retry.
 */
export async function reconcileSettingsUnderLock(
	did: string,
	rkey: string,
	options?: SettingsUpdateOptions,
	dependencies: SettingsWriteDependencies = defaultSettingsWriteDependencies,
	resources: RevalidationResources | undefined = options?.resources,
): Promise<void> {
	assertRevalidationActive(resources)
	const fetchCurrentSettings =
		options?.fetchSettingsRecordOutcome ?? dependencies.fetchSettingsRecordOutcome ?? fetchSettingsRecordOutcome
	const outcome = await fetchCurrentSettings(did, rkey, undefined, resources)
	if (outcome.kind === 'retryable') {
		logger.warn('[CacheWriter] Settings lookup remains retryable during locked reconciliation', {
			did,
			rkey,
			error: outcome.error,
		})
		throw new AuthoritativeSettingsRecordError(outcome.error)
	}

	// Do not begin a cache mutation after the revalidation budget/deadline has
	// expired while the authoritative lookup was in flight.
	assertRevalidationActive(resources)
	if (outcome.kind === 'present') {
		const materializeOptions = options ?? (resources === undefined ? undefined : { resources })
		await handleSettingsUpdateLocked(did, rkey, outcome.record, outcome.cid, materializeOptions, dependencies)
		return
	}

	// An update can observe a deletion, and a delete can observe a recreation.
	// Route both through the non-recursive primitives while the same lock is held.
	await handleSettingsDeleteLocked(did, rkey, dependencies)
}

/**
 * Handle settings create/update event. Standalone settings writes use the same
 * per-site lock as site writes, and reconcile the current PDS record only after
 * acquiring that lock.
 */
export async function handleSettingsUpdate(
	did: string,
	rkey: string,
	_settings?: WispSettings,
	_recordCid?: string,
	options?: SettingsUpdateOptions,
	dependencies: SettingsWriteDependencies = defaultSettingsWriteDependencies,
): Promise<void> {
	return dependencies.withSiteWriteLock(
		did,
		rkey,
		() => reconcileSettingsUnderLock(did, rkey, options, dependencies),
		options?.resources?.signal,
	)
}

/** Perform a settings delete while the caller already holds the site lock. */
export async function handleSettingsDeleteLocked(
	did: string,
	rkey: string,
	dependencies: SettingsWriteDependencies = defaultSettingsWriteDependencies,
): Promise<void> {
	logger.info(`Deleting settings for ${did}/${rkey}`)
	await dependencies.deleteSiteSettingsCache(did, rkey)

	// Notify hosting-service to invalidate its local caches
	await dependencies.publishCacheInvalidation(did, rkey, 'settings')
}

/**
 * Handle settings delete event under the per-site write lock. The event is a
 * tombstone hint; only an authoritative PDS absence permits destructive work.
 */
export async function handleSettingsDelete(
	did: string,
	rkey: string,
	dependencies: SettingsWriteDependencies = defaultSettingsWriteDependencies,
	resources?: RevalidationResources,
	options?: SettingsUpdateOptions,
): Promise<void> {
	const effectiveResources = resources ?? options?.resources
	const reconciliationOptions = options
		? { ...options, resources: effectiveResources }
		: effectiveResources === undefined
			? undefined
			: { resources: effectiveResources }
	return dependencies.withSiteWriteLock(
		did,
		rkey,
		() => reconcileSettingsUnderLock(did, rkey, reconciliationOptions, dependencies, effectiveResources),
		effectiveResources?.signal,
	)
}
