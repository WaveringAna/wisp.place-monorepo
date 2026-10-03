/**
 * Core file serving logic for the hosting service
 * Handles file retrieval, caching, redirects, and HTML rewriting
 */

import { Readable } from 'node:stream'
import { computeCID } from '@wispplace/atproto-utils'
import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression'
import { MAX_BLOB_SIZE } from '@wispplace/constants'
import { type FileObjects, normalizeFileCids, normalizeFileObjects } from '@wispplace/fs-utils'
import { isHtmlContent, rewriteHtmlPaths } from '@wispplace/fs-utils/html-rewriter'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import { createLogger } from '@wispplace/observability'
import {
	compress as compressGzip,
	DecompressionLimitError,
	decompress as decompressGzip,
	isGzipped,
	measureDecompressedSize as measureGzipDecompressedSize,
	type StorageResult,
	type StreamResult,
} from '@wispplace/tiered-storage'
import { lookup } from 'mime-types'
import { isSiteUpdating } from './cache-invalidation'
import { cache } from './cache-manager'
import { getSiteCache } from './db'
import {
	bufferResponseBody,
	disposeFileStream,
	disposeFileStreamAndWait,
	FileStreamIntegrityError,
	getStreamResponseBody,
	peekFileStream,
	transformFileStream,
	verifyFileStream,
} from './file-streams'
import { triggerSiteHtmlHotCacheWarmup } from './html-prewarm'
import { generate404Page, generateDirectoryListing, siteUpdatingResponse } from './page-generators'
import { loadRedirectRules, matchRedirectRule, parseCookies, parseQueryString } from './redirects'
import { applyCustomHeaders, getIndexFiles } from './request-utils'
import { recordStorageMiss } from './revalidate-metrics'
import { enqueueRevalidate } from './revalidate-queue'
import { resolveStorageKey, type SiteManifest } from './site-storage-keys'
import { addPublicSourceCidIfChecksumMatches, evictPublicCacheKey, isStorageUnavailableError, storage } from './storage'
import { createTrace, logTrace, type RequestTrace, span } from './trace'
import { getCachedSettings } from './utils'

const logger = createLogger('file-serving')
export interface FileServeRequestOptions {
	method?: string
	signal?: AbortSignal
}

const STANDARD_CACHE_CONTROL = 'public, max-age=600'
const DEFAULT_GZIP_PROCESSING_CONCURRENCY = 2
const MAX_GZIP_PROCESSING_CONCURRENCY = 4

function getGzipProcessingConcurrency(): number {
	const configured = process.env.HOSTING_GZIP_PROCESSING_CONCURRENCY
	if (!configured) return DEFAULT_GZIP_PROCESSING_CONCURRENCY

	const value = Number(configured)
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GZIP_PROCESSING_CONCURRENCY) {
		return DEFAULT_GZIP_PROCESSING_CONCURRENCY
	}
	return value
}

const gzipProcessingConcurrency = getGzipProcessingConcurrency()
let activeGzipProcessing = 0
const gzipProcessingWaiters: Array<() => void> = []

/**
 * Bounds CPU and memory-heavy gzip work across all requests in this process.
 * The releaser transfers its reserved slot directly to the next waiter.
 */
async function withGzipProcessingBudget<T>(work: () => Promise<T>): Promise<T> {
	if (activeGzipProcessing >= gzipProcessingConcurrency) {
		await new Promise<void>((resolve) => gzipProcessingWaiters.push(resolve))
	} else {
		activeGzipProcessing++
	}

	try {
		return await work()
	} finally {
		const next = gzipProcessingWaiters.shift()
		if (next) {
			next()
		} else {
			activeGzipProcessing--
		}
	}
}

type FileStorageResult = StorageResult<Uint8Array>
type FileForRequestResult = {
	result: FileStorageResult | (StreamResult & { streamGzipMagic?: boolean })
	filePath: string
	wasRewritten: boolean
}

class SourceCidValidationError extends Error {
	constructor(readonly filePath: string) {
		super('Stored file source CID does not match the manifest')
		this.name = 'SourceCidValidationError'
	}
}

export const SOURCE_CID_MISMATCH_TTL_MS = 10 * 1_000
const SOURCE_CID_MISMATCH_NAMESPACE = 'sourceCidMismatches' as const

type SourceCidMismatchResolution =
	| { kind: 'not-found' }
	| { kind: 'matched'; result: FileStorageResult }
	| { kind: 'mismatched' }
type StreamCidMismatchResolution = { kind: 'matched' } | { kind: 'mismatched' }

interface GzipOperations {
	compress(data: Uint8Array): Promise<Uint8Array>
	decompress(data: Uint8Array, maxOutputBytes: number): Promise<Buffer<ArrayBuffer>>
	measureDecompressedSize(data: Uint8Array, maxOutputBytes: number): Promise<number>
}

const defaultGzipOperations: GzipOperations = {
	compress: compressGzip,
	decompress: decompressGzip,
	measureDecompressedSize: measureGzipDecompressedSize,
}
let gzipOperations: GzipOperations = defaultGzipOperations

/** @internal Test seam for deterministic gzip work and concurrency tests. */
export function setGzipOperationsForTests(overrides?: Partial<GzipOperations>): void {
	if (process.env.NODE_ENV === 'production') {
		throw new Error('Gzip test operations cannot be configured in production')
	}
	gzipOperations = { ...defaultGzipOperations, ...overrides }
}

type FileLookupMode = 'original' | 'prefer-pre-rewritten-html'

interface FileServingStrategy {
	readonly fileLookup: FileLookupMode
	readonly rewriteMissingHtmlOnDemand: boolean
	readonly sharedOrigin: boolean
	readonly adjustSharedPathRedirect: boolean
	readonly basePath?: string
}

const ORIGINAL_FILE_STRATEGY: FileServingStrategy = {
	fileLookup: 'original',
	rewriteMissingHtmlOnDemand: false,
	sharedOrigin: false,
	adjustSharedPathRedirect: false,
}

function createSharedOriginFileStrategy(basePath: string): FileServingStrategy {
	return {
		fileLookup: 'prefer-pre-rewritten-html',
		rewriteMissingHtmlOnDemand: true,
		sharedOrigin: true,
		adjustSharedPathRedirect: true,
		basePath,
	}
}

/**
 * Check if the last segment of a path looks like it has a file extension.
 * e.g. "style.css" → true, "about" → false, "wisp-cli-x86_64-linux" → false,
 *      "dir.name/file" → false, "dir/file.tar.gz" → true
 */
export function hasFileExtension(path: string): boolean {
	const basename = path.split('/').pop() || ''
	return /\.[a-zA-Z0-9]+$/.test(basename)
}

/**
 * Log the tier only after a result has passed any manifest-source validation.
 */
function logStorageResult(did: string, rkey: string, filePath: string, result: FileStorageResult): void {
	const tier = result.source || 'unknown'
	const size = result.data ? (result.data as Uint8Array).length : 0
	logger.debug(`Served ${filePath} from ${tier} tier`, { did, rkey, size, tier })
}

const MAX_PENDING_LEGACY_SOURCE_CID_BACKFILLS = 1_024
const LEGACY_SOURCE_CID_BACKFILL_TTL_MS = 10 * 60 * 1_000
const pendingLegacySourceCidBackfills = new Map<string, number>()

async function repairLegacySourceCid(
	did: string,
	rkey: string,
	key: string,
	expectedChecksum: string,
	sourceCid: string,
): Promise<void> {
	const dedupeKey = key
	const now = Date.now()
	const previous = pendingLegacySourceCidBackfills.get(dedupeKey)
	if (previous !== undefined && now - previous < LEGACY_SOURCE_CID_BACKFILL_TTL_MS) return
	if (pendingLegacySourceCidBackfills.size >= MAX_PENDING_LEGACY_SOURCE_CID_BACKFILLS) {
		const oldest = pendingLegacySourceCidBackfills.keys().next().value
		if (oldest !== undefined) pendingLegacySourceCidBackfills.delete(oldest)
	}
	pendingLegacySourceCidBackfills.set(dedupeKey, now)

	try {
		if (await addPublicSourceCidIfChecksumMatches(key, expectedChecksum, sourceCid)) return
	} catch {
		logger.warn('Conditional legacy source CID metadata repair failed', { did, rkey })
	}
	// A backend without a conditional metadata update cannot safely heal this
	// object. Fall back to the established durable full materialization.
	try {
		await enqueueRevalidate(did, rkey, 'storage-miss:legacy-source-cid-backfill')
	} catch {
		logger.warn('Failed to enqueue legacy source CID repair', { did, rkey })
	}
}

function hasSourceCidMetadata(metadata: StoredFileCustomMetadata | undefined): boolean {
	return metadata !== undefined && Object.getOwnPropertyDescriptor(metadata, 'sourceCid') !== undefined
}

async function hasExpectedSourceCid(
	result: FileStorageResult,
	expectedSourceCid: string,
	did: string,
	rkey: string,
	key: string,
): Promise<boolean> {
	const metadata = result.metadata?.customMetadata as StoredFileCustomMetadata | undefined
	if (hasSourceCidMetadata(metadata)) return metadata?.sourceCid === expectedSourceCid

	if (result.data.byteLength > MAX_BLOB_SIZE || result.metadata.size > MAX_BLOB_SIZE) return false
	if (computeCID(result.data) !== expectedSourceCid) return false

	// Source CID verification is the serving boundary. Metadata repair may use
	// a cold HEAD/copy round trip, so it must not delay a verified response.
	void repairLegacySourceCid(did, rkey, key, result.metadata.checksum, expectedSourceCid).catch(() => {
		logger.warn('Unexpected legacy source CID repair failure', { did, rkey })
	})
	return true
}

/**
 * Retrieve a file and, when a manifest CID is available, verify that the
 * stored object is from that manifest version before it can be served.
 */
async function getFileWithMetadata(
	did: string,
	rkey: string,
	filePath: string,
	fileObjects: FileObjects | null,
	expectedSourceCid?: string,
): Promise<FileStorageResult | null> {
	const key = resolveStorageKey(did, rkey, filePath, fileObjects)
	if (key === null) return null
	if (expectedSourceCid === undefined) {
		const result = await storage.getWithMetadata(key)
		if (!result) return null

		logStorageResult(did, rkey, filePath, result)
		return result
	}

	const sourceCidMismatchKey = `${did}:${rkey}:${filePath}:${expectedSourceCid}:${key}`
	// Dedupe the initial read, eviction, and one cold retry. Concurrent requests
	// may all arrive while the upper tier still contains the same stale object;
	// getOrFetch ensures that burst performs one complete validation attempt.
	const lookupResult = await cache.getOrFetch<SourceCidMismatchResolution>(
		SOURCE_CID_MISMATCH_NAMESPACE,
		sourceCidMismatchKey,
		async () => {
			const result = await storage.getWithMetadata(key)
			if (!result) return { kind: 'not-found' }

			if (await hasExpectedSourceCid(result, expectedSourceCid, did, rkey, key)) {
				return { kind: 'matched', result }
			}

			logger.warn('Stored file source CID does not match the manifest; retrying cold storage', {
				did,
				rkey,
				filePath,
				tier: result.source,
			})

			try {
				// This only deletes hot/warm copies and is fenced against eager promotion.
				// It deliberately never mutates the cold source of truth.
				await evictPublicCacheKey(key)
			} catch (error) {
				if (isStorageUnavailableError(error)) throw error
				logger.warn('Failed to evict mismatched local file cache entry', { did, rkey, filePath })
				return { kind: 'mismatched' }
			}

			// With upper tiers evicted, this is the one allowed cold-source retry. Do
			// not evict again if it still fails: a briefly stale DB replica must fail
			// closed without destructive cache oscillation.
			let coldResult: FileStorageResult | null
			try {
				coldResult = await storage.getWithMetadata(key)
			} catch (error) {
				// A transient cold-tier outage is not evidence that the manifest is stale.
				// Let the request boundary return 503 without scheduling a repair.
				if (isStorageUnavailableError(error)) throw error
				logger.warn('Failed to retry cold storage after a source CID mismatch', { did, rkey, filePath })
				return { kind: 'mismatched' }
			}
			if (!coldResult || !(await hasExpectedSourceCid(coldResult, expectedSourceCid, did, rkey, key))) {
				logger.warn('Cold file source CID does not match the manifest', { did, rkey, filePath })
				return { kind: 'mismatched' }
			}

			return { kind: 'matched', result: coldResult }
		},
		{
			cacheIf: (value) => value.kind === 'mismatched',
			ttl: SOURCE_CID_MISMATCH_TTL_MS,
		},
	)

	if (lookupResult.kind === 'not-found') return null
	if (lookupResult.kind === 'mismatched') throw new SourceCidValidationError(filePath)

	logStorageResult(did, rkey, filePath, lookupResult.result)
	return lookupResult.result
}

function normalizeFilePath(filePath: string): string {
	return filePath.startsWith('/') ? filePath.slice(1) : filePath
}

const REWRITTEN_PATH_PREFIX = '.rewritten/'

function sourceManifestPath(filePath: string): string {
	const normalizedPath = normalizeFilePath(filePath)
	return normalizedPath.startsWith(REWRITTEN_PATH_PREFIX)
		? normalizedPath.slice(REWRITTEN_PATH_PREFIX.length)
		: normalizedPath
}

function getExpectedSourceCid(fileCids: Record<string, string> | null, filePath: string): string | undefined {
	if (fileCids === null) return undefined
	const sourceCid = fileCids[sourceManifestPath(filePath)]
	return typeof sourceCid === 'string' && sourceCid.length > 0 ? sourceCid : undefined
}

function isAbsoluteHttpUrl(path: string): boolean {
	return path.startsWith('http://') || path.startsWith('https://')
}

function externalRewriteNotAllowedResponse(targetPath: string): Response {
	logger.warn('Blocked absolute URL for status 200 rewrite', { targetPath })
	return new Response('Absolute URL rewrites are not supported', {
		status: 400,
		headers: {
			'Cache-Control': 'no-store',
		},
	})
}

function manifestHasPath(fileCids: Record<string, string> | null, filePath: string): boolean {
	return fileCids === null || fileCids[normalizeFilePath(filePath)] !== undefined
}

/**
 * Fetch a per-site fallback file (SPA, custom 404, auto-detected 404 pages),
 * caching null results so repeated 404 responses don't re-hit S3 for files
 * that don't exist on the site. The expected source CID is part of the cache
 * key, so a DB manifest update never inherits a stale negative result.
 */
async function getFallbackFile(
	did: string,
	rkey: string,
	filePath: string,
	manifest: SiteManifest | null,
	strategy: FileServingStrategy,
	trace?: RequestTrace | null,
	signal?: AbortSignal,
): Promise<FileForRequestResult | null> {
	const fileCids = manifest?.fileCids ?? null
	const expectedSourceCid = getExpectedSourceCid(fileCids, filePath)
	if (fileCids !== null && expectedSourceCid === undefined) return null

	const cacheKey = `${did}:${rkey}:${filePath}:${expectedSourceCid ?? 'no-manifest'}`
	// null in the cache means we've confirmed this file doesn't exist
	const negativeCached = cache.get<null>('siteFiles', cacheKey)
	if (negativeCached === null) return null

	const result = await span(trace, `storage:${filePath}`, () =>
		getFileForRequest(did, rkey, filePath, strategy, manifest, signal),
	)
	if (result === null) {
		cache.set('siteFiles', cacheKey, null)
	}
	return result
}

async function getSiteManifest(did: string, rkey: string, trace?: RequestTrace | null): Promise<SiteManifest | null> {
	const siteCache = await span(trace, 'db:siteCache', () => getSiteCache(did, rkey))
	if (!siteCache) return null
	// The owner's PDS confirmed the record is gone: serve it like a deleted site
	// (an empty manifest, so every path 404s) while the files await the sweeper.
	if (siteCache.absent_since !== null && siteCache.absent_since !== undefined) {
		return { fileCids: {}, fileObjects: null }
	}
	return {
		fileCids: normalizeFileCids(siteCache.file_cids).value,
		// One snapshot with the CIDs: a body is only read from the key its own manifest names.
		fileObjects: normalizeFileObjects(siteCache.file_objects),
	}
}

function shouldServeUpdatingPage(requestHeaders?: Record<string, string>): boolean {
	const accept = (requestHeaders?.accept ?? '').toLowerCase()
	if (accept.includes('text/html') || accept.includes('application/xhtml+xml')) {
		return true
	}

	const fetchDest = (requestHeaders?.['sec-fetch-dest'] ?? '').toLowerCase()
	return fetchDest === 'document' || fetchDest === 'iframe' || fetchDest === 'frame'
}

function buildUnavailableResponse(message: string, requestHeaders?: Record<string, string>): Response {
	if (shouldServeUpdatingPage(requestHeaders)) {
		return siteUpdatingResponse()
	}

	return new Response(message, {
		status: 503,
		headers: {
			'Cache-Control': 'no-store',
			'Retry-After': '5',
		},
	})
}

function buildSiteUpdatingResponse(requestHeaders?: Record<string, string>): Response {
	return buildUnavailableResponse('Site is updating', requestHeaders)
}

function buildStorageMissResponse(requestHeaders?: Record<string, string>): Response {
	return buildUnavailableResponse('Storage temporarily unavailable', requestHeaders)
}

type DirectoryEntryMap = Map<string, boolean>

function directoryPrefix(requestPath: string): string {
	return requestPath ? `${requestPath}/` : ''
}

function addDirectoryEntry(entries: DirectoryEntryMap, relativePath: string): void {
	if (!relativePath || relativePath.startsWith('.rewritten/')) return

	const [name, ...rest] = relativePath.split('/')
	if (!name || name === '.metadata.json' || name.endsWith('.meta')) return

	const isDirectory = rest.length > 0
	const existing = entries.get(name)
	if (existing === undefined || (isDirectory && !existing)) {
		entries.set(name, isDirectory)
	}
}

function collectManifestDirectoryEntries(
	entries: DirectoryEntryMap,
	requestPath: string,
	manifestPaths: readonly string[],
): void {
	const prefix = directoryPrefix(requestPath)
	for (const filePath of manifestPaths) {
		if (prefix && !filePath.startsWith(prefix)) continue
		addDirectoryEntry(entries, prefix ? filePath.slice(prefix.length) : filePath)
	}
}

function toDirectoryEntries(entries: DirectoryEntryMap): Array<{ name: string; isDirectory: boolean }> {
	return Array.from(entries.entries()).map(([name, isDirectory]) => ({ name, isDirectory }))
}

/** Directory entries come from the manifest alone: storage keys carry no path structure any more. */
function listDirectoryEntries(
	requestPath: string,
	manifestPaths: readonly string[] | null,
): Array<{ name: string; isDirectory: boolean }> {
	const entries: DirectoryEntryMap = new Map()
	if (manifestPaths !== null) collectManifestDirectoryEntries(entries, requestPath, manifestPaths)
	return toDirectoryEntries(entries)
}

async function hasFileForNonForcedRedirect(
	did: string,
	rkey: string,
	filePath: string,
	indexFiles: string[],
	trace?: RequestTrace | null,
): Promise<boolean> {
	let checkPath: string = filePath || indexFiles[0] || 'index.html'
	if (checkPath.endsWith('/')) {
		checkPath += indexFiles[0] || 'index.html'
	}

	const manifest = await getSiteManifest(did, rkey, trace)
	if (manifest !== null) {
		return manifestHasPath(manifest.fileCids, checkPath)
	}

	const fileInStorage = await span(trace, `storage:${checkPath}`, () => getFileWithMetadata(did, rkey, checkPath, null))
	return fileInStorage !== null
}

async function getVerifiedFileStream(
	did: string,
	rkey: string,
	filePath: string,
	fileObjects: FileObjects | null,
	expectedSourceCid: string | undefined,
	signal?: AbortSignal,
): Promise<StreamResult | null> {
	if (typeof storage.getStream !== 'function') return null
	const key = resolveStorageKey(did, rkey, filePath, fileObjects)
	if (key === null) return null
	const read = () => storage.getStream(key, { signal, borrowChunks: true })
	const mismatchKey = `stream:${did}:${rkey}:${filePath}:${expectedSourceCid}:${key}`
	if (
		expectedSourceCid &&
		cache.get<StreamCidMismatchResolution>(SOURCE_CID_MISMATCH_NAMESPACE, mismatchKey)?.kind === 'mismatched'
	) {
		throw new SourceCidValidationError(filePath)
	}
	const result = await read()
	if (!result) return null

	const verify = async (candidate: StreamResult): Promise<StreamResult> => {
		if (!expectedSourceCid) return candidate
		const metadata = candidate.metadata.customMetadata as StoredFileCustomMetadata | undefined
		if (hasSourceCidMetadata(metadata)) {
			if (metadata?.sourceCid === expectedSourceCid) return candidate
			disposeFileStream(candidate.stream)
			throw new FileStreamIntegrityError()
		}
		const verified = await verifyFileStream(candidate, expectedSourceCid, signal)
		void repairLegacySourceCid(did, rkey, key, candidate.metadata.checksum, expectedSourceCid).catch(() => {
			logger.warn('Unexpected legacy source CID repair failure', { did, rkey })
		})
		return verified
	}

	try {
		return await verify(result)
	} catch (error) {
		if (!(error instanceof FileStreamIntegrityError) || !expectedSourceCid) throw error
		logger.warn('Stored file source CID does not match the manifest; retrying cold storage', {
			did,
			rkey,
			filePath,
			tier: result.source,
		})
		const resolution = await cache.getOrFetch<StreamCidMismatchResolution>(
			SOURCE_CID_MISMATCH_NAMESPACE,
			mismatchKey,
			async () => {
				try {
					await evictPublicCacheKey(key)
				} catch (evictionError) {
					signal?.throwIfAborted()
					if (isStorageUnavailableError(evictionError)) throw evictionError
					logger.warn('Failed to evict mismatched local file cache entry', { did, rkey, filePath })
					return { kind: 'mismatched' }
				}
				let coldResult: StreamResult | null
				try {
					coldResult = await read()
				} catch (readError) {
					signal?.throwIfAborted()
					if (isStorageUnavailableError(readError)) throw readError
					logger.warn('Failed to retry cold storage after a source CID mismatch', { did, rkey, filePath })
					return { kind: 'mismatched' }
				}
				signal?.throwIfAborted()
				if (!coldResult) return { kind: 'mismatched' }
				try {
					const verified = await verify(coldResult)
					disposeFileStream(verified.stream)
					return { kind: 'matched' }
				} catch (coldError) {
					if (!(coldError instanceof FileStreamIntegrityError)) throw coldError
					return { kind: 'mismatched' }
				}
			},
			{
				cacheIf: (value) => value.kind === 'mismatched',
				ttl: SOURCE_CID_MISMATCH_TTL_MS,
			},
		)
		if (resolution.kind === 'mismatched') throw new SourceCidValidationError(filePath)

		const coldResult = await read()
		if (!coldResult) throw new SourceCidValidationError(filePath)
		try {
			return await verify(coldResult)
		} catch (coldError) {
			if (coldError instanceof FileStreamIntegrityError) throw new SourceCidValidationError(filePath)
			throw coldError
		}
	}
}

async function getFileForRequest(
	did: string,
	rkey: string,
	filePath: string,
	strategy: FileServingStrategy,
	manifest: SiteManifest | null,
	signal?: AbortSignal,
): Promise<FileForRequestResult | null> {
	const fileCids = manifest?.fileCids ?? null
	const fileObjects = manifest?.fileObjects ?? null
	const expectedSourceCid = getExpectedSourceCid(fileCids, filePath)
	if (fileCids !== null && expectedSourceCid === undefined) return null

	let sourceCidValidationFailed = false
	const readCandidate = async (candidatePath: string): Promise<FileStorageResult | null> => {
		try {
			return await getFileWithMetadata(did, rkey, candidatePath, fileObjects, expectedSourceCid)
		} catch (error) {
			if (error instanceof SourceCidValidationError) {
				sourceCidValidationFailed = true
				return null
			}
			throw error
		}
	}

	const readStreamCandidate = async (
		candidatePath: string,
		wasRewritten: boolean,
	): Promise<{ kind: 'stream'; file: FileForRequestResult } | { kind: 'fallback' | 'missing' | 'mismatch' }> => {
		if (typeof storage.getStream !== 'function') return { kind: 'fallback' }
		const guessedMimeType = lookup(candidatePath) || 'application/octet-stream'
		if (strategy.rewriteMissingHtmlOnDemand && !wasRewritten && isHtmlContent(candidatePath, guessedMimeType)) {
			return { kind: 'fallback' }
		}
		let streamed: StreamResult | null
		try {
			streamed = await getVerifiedFileStream(
				did,
				rkey,
				candidatePath,
				fileObjects,
				getExpectedSourceCid(fileCids, candidatePath),
				signal,
			)
		} catch (error) {
			if (error instanceof SourceCidValidationError) {
				sourceCidValidationFailed = true
				return { kind: 'mismatch' }
			}
			throw error
		}
		if (!streamed) return { kind: 'missing' }
		const { result, prefix } = await peekFileStream(streamed)
		const metadata = result.metadata.customMetadata as StoredFileCustomMetadata | undefined
		const mimeType = metadata?.mimeType || lookup(candidatePath) || 'application/octet-stream'
		const shouldRewriteOnDemand =
			strategy.rewriteMissingHtmlOnDemand && !wasRewritten && isHtmlContent(candidatePath, mimeType)
		if (shouldRewriteOnDemand) {
			disposeFileStream(result.stream)
			return { kind: 'fallback' }
		}
		return {
			kind: 'stream',
			file: { result: { ...result, streamGzipMagic: isGzipped(prefix) }, filePath, wasRewritten },
		}
	}

	const mimeTypeGuess = lookup(filePath) || 'application/octet-stream'
	if (strategy.fileLookup === 'prefer-pre-rewritten-html' && isHtmlContent(filePath, mimeTypeGuess)) {
		const rewrittenPath = `${REWRITTEN_PATH_PREFIX}${filePath}`
		const rewrittenStream = await readStreamCandidate(rewrittenPath, true)
		if (rewrittenStream.kind === 'stream') return rewrittenStream.file
		if (rewrittenStream.kind === 'fallback') {
			const rewritten = await readCandidate(rewrittenPath)
			if (rewritten) return { result: rewritten, filePath, wasRewritten: true }
		}
	}

	const streamed = await readStreamCandidate(filePath, false)
	if (streamed.kind === 'stream') return streamed.file
	if (streamed.kind === 'missing') {
		if (sourceCidValidationFailed) throw new SourceCidValidationError(filePath)
		return null
	}
	if (streamed.kind === 'mismatch') throw new SourceCidValidationError(filePath)
	const result = await readCandidate(filePath)
	if (result) return { result, filePath, wasRewritten: false }
	if (sourceCidValidationFailed) throw new SourceCidValidationError(filePath)
	return null
}

function gzipQuality(parameters: string[]): number {
	const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith('q='))
	if (!qualityParameter) return 1

	const quality = Number(qualityParameter.trim().slice(2))
	return Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0
}

function clientAcceptsGzip(requestHeaders?: Record<string, string>): boolean {
	const acceptEncoding = requestHeaders?.['accept-encoding']
	if (!acceptEncoding) return false

	let acceptsGzip = false
	for (const encoding of acceptEncoding.split(',')) {
		const [rawName = '', ...parameters] = encoding.trim().toLowerCase().split(';')
		if (rawName.trim() !== 'gzip') continue
		acceptsGzip ||= gzipQuality(parameters) > 0
	}

	return acceptsGzip
}

function addVaryHeader(headers: Record<string, string>, field: string): void {
	const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'vary')
	const headerKey = existingKey ?? 'Vary'
	const existing = headers[headerKey]
	if (!existing || existing === '*') {
		headers[headerKey] = existing || field
		return
	}

	const fields = existing.split(',').map((value) => value.trim().toLowerCase())
	if (!fields.includes(field.toLowerCase())) {
		headers[headerKey] = `${existing}, ${field}`
	}
}

function applyFileResponseHeaders(
	headers: Record<string, string>,
	filePath: string,
	settings: WispSettings | null,
	sharedOrigin: boolean,
	varyByAcceptEncoding: boolean,
): void {
	applyCustomHeaders(headers, filePath, settings, { sharedOrigin })
	if (varyByAcceptEncoding) addVaryHeader(headers, 'Accept-Encoding')
}

type StoredFileCustomMetadata = {
	encoding?: string
	mimeType?: string
	sourceCid?: string
	uncompressedSize?: string
}

type GzipFailureKind = 'decode-failed' | 'invalid-gzip' | 'output-limit'
type StoredGzipSizeStatus = 'needs-measurement' | 'over-limit' | 'trusted'

function getStoredGzipSizeStatus(metadata: StoredFileCustomMetadata | undefined): StoredGzipSizeStatus {
	const rawSize = metadata?.uncompressedSize
	if (typeof rawSize !== 'string' || !/^\d+$/.test(rawSize)) return 'needs-measurement'

	const size = Number(rawSize)
	// Check the hard cap before safe-integer validation so even a huge decimal
	// metadata value cannot evade immediate rejection by overflowing Number.
	if (size > MAX_BLOB_SIZE) return 'over-limit'
	if (!Number.isSafeInteger(size) || size < 0) return 'needs-measurement'
	return 'trusted'
}

function getGzipFailureKind(error: unknown): GzipFailureKind {
	if (
		error instanceof DecompressionLimitError ||
		(error instanceof Error && error.name === 'DecompressionLimitError')
	) {
		return 'output-limit'
	}
	if (error instanceof Error && error.message.includes('missing magic bytes')) return 'invalid-gzip'
	return 'decode-failed'
}

function buildGzipDecodeFailureResponse(
	filePath: string,
	failureKind: GzipFailureKind,
	varyByAcceptEncoding: boolean,
): Response {
	// Do not log zlib errors: they can include untrusted compressed-object details.
	logger.warn('Refusing to serve a stored gzip file that could not be decoded safely', { filePath, failureKind })

	const headers: Record<string, string> = {
		'Content-Type': 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store',
	}
	if (varyByAcceptEncoding) addVaryHeader(headers, 'Accept-Encoding')
	return new Response('Stored file could not be decompressed safely', { status: 422, headers })
}

type StoredFileRepresentation = {
	result: FileStorageResult | StreamResult
	content: Buffer | undefined
	metadata: StoredFileCustomMetadata | undefined
	mimeType: string
	explicitlyGzipped: boolean
	hasGzipMagic: boolean
	isGzipContent: boolean
	shouldCompress: boolean
	shouldServeCompressed: boolean
	varyByAcceptEncoding: boolean
}

type GzipFailure = { kind: 'failure'; response: Response }
type GzipPreparation = { kind: 'ready'; decodedIdentity?: Buffer<ArrayBuffer> } | GzipFailure
type DecodedGzipIdentity = { kind: 'decoded'; content: Buffer<ArrayBuffer> } | GzipFailure
type IdentityResponseContent = { kind: 'content'; content: Buffer<ArrayBuffer> } | GzipFailure
type HtmlRewriteSource = { kind: 'content'; content: Buffer } | GzipFailure
type RewrittenHtmlAttempt = { kind: 'rewritten'; output: Buffer } | { kind: 'serve-original' }
type RewrittenHtmlCompression = { output: Buffer; contentEncoding?: 'gzip' }

function createStoredFileRepresentation(
	result: FileStorageResult | StreamResult,
	filePath: string,
	requestHeaders: Record<string, string> | undefined,
	varyForDynamicRewrite = false,
	streamGzipMagic?: boolean,
): StoredFileRepresentation {
	const content =
		'data' in result ? Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength) : undefined
	const metadata = result.metadata?.customMetadata as StoredFileCustomMetadata | undefined
	const mimeType = metadata?.mimeType || lookup(filePath) || 'application/octet-stream'
	const shouldCompress = shouldCompressMimeType(mimeType)
	const hasGzipMagic = streamGzipMagic ?? (content ? isGzipped(content) : false)
	const explicitlyGzipped = metadata?.encoding === 'gzip'
	// Older cache objects can lack encoding metadata. For text assets, gzip magic
	// is sufficient to safely negotiate the actual stored representation.
	const inferredGzip = !explicitlyGzipped && hasGzipMagic && shouldCompress
	const isGzipContent = explicitlyGzipped || inferredGzip
	const shouldServeCompressed = isGzipContent && shouldCompress && clientAcceptsGzip(requestHeaders)
	const varyByAcceptEncoding = varyForDynamicRewrite ? shouldCompress : isGzipContent && shouldCompress

	return {
		result,
		content,
		metadata,
		mimeType,
		explicitlyGzipped,
		hasGzipMagic,
		isGzipContent,
		shouldCompress,
		shouldServeCompressed,
		varyByAcceptEncoding,
	}
}

function getStoredFileContent(representation: StoredFileRepresentation): Buffer {
	if (!representation.content) throw new Error('Stored representation has no buffered content')
	return representation.content
}

function gzipFailure(filePath: string, failureKind: GzipFailureKind, varyByAcceptEncoding: boolean): GzipFailure {
	return { kind: 'failure', response: buildGzipDecodeFailureResponse(filePath, failureKind, varyByAcceptEncoding) }
}

async function measureLegacyGzipPassthrough(
	content: Uint8Array,
	filePath: string,
	varyByAcceptEncoding: boolean,
): Promise<GzipPreparation> {
	try {
		await withGzipProcessingBudget(async () => {
			await gzipOperations.measureDecompressedSize(content, MAX_BLOB_SIZE)
		})
		return { kind: 'ready' }
	} catch (error) {
		return gzipFailure(filePath, getGzipFailureKind(error), varyByAcceptEncoding)
	}
}

async function decodeStoredGzipIdentity(
	content: Uint8Array,
	filePath: string,
	varyByAcceptEncoding: boolean,
): Promise<DecodedGzipIdentity> {
	try {
		const decoded = await withGzipProcessingBudget(() => gzipOperations.decompress(content, MAX_BLOB_SIZE))
		return { kind: 'decoded', content: decoded }
	} catch (error) {
		return gzipFailure(filePath, getGzipFailureKind(error), varyByAcceptEncoding)
	}
}

/**
 * Validate gzip state before a conditional response can be emitted. This makes
 * legacy gzip bytes safe for both negotiated passthrough and identity reads.
 */
async function prepareStoredGzipResponse(
	representation: StoredFileRepresentation,
	filePath: string,
): Promise<GzipPreparation> {
	if (!representation.isGzipContent) return { kind: 'ready' }
	if (representation.explicitlyGzipped && !representation.hasGzipMagic) {
		return gzipFailure(filePath, 'invalid-gzip', representation.varyByAcceptEncoding)
	}

	const sizeStatus = getStoredGzipSizeStatus(representation.metadata)
	if (sizeStatus === 'over-limit') {
		return gzipFailure(filePath, 'output-limit', representation.varyByAcceptEncoding)
	}
	if (sizeStatus === 'trusted') return { kind: 'ready' }
	if (representation.shouldServeCompressed) {
		// A legacy object has no trusted firehose accounting metadata. Verify its
		// logical size before returning compressed bytes to a gzip client.
		return await measureLegacyGzipPassthrough(
			getStoredFileContent(representation),
			filePath,
			representation.varyByAcceptEncoding,
		)
	}

	// This branch must materialize identity bytes anyway. Decode once before
	// conditionals so a malformed legacy object cannot receive a 304.
	const decoded = await decodeStoredGzipIdentity(
		getStoredFileContent(representation),
		filePath,
		representation.varyByAcceptEncoding,
	)
	if (decoded.kind === 'failure') return decoded
	return { kind: 'ready', decodedIdentity: decoded.content }
}

function getRepresentationEtag(representation: StoredFileRepresentation): string | undefined {
	const checksum = representation.result.metadata?.checksum
	if (!checksum) return undefined

	// A checksum of stored gzip bytes cannot be a strong validator for the
	// decompressed identity representation. Give each negotiated representation
	// a distinct opaque tag, while retaining the stored checksum as its source.
	const suffix = representation.isGzipContent ? (representation.shouldServeCompressed ? '-gzip' : '-identity') : ''
	return `"${checksum}${suffix}"`
}

function ifNoneMatchMatches(etag: string, ifNoneMatch: string): boolean {
	if (ifNoneMatch === '*') return true
	return ifNoneMatch
		.split(',')
		.map((entry) => entry.trim())
		.includes(etag)
}

function buildNotModifiedResponse(
	etag: string | undefined,
	requestHeaders: Record<string, string> | undefined,
	varyByAcceptEncoding: boolean,
): Response | null {
	const ifNoneMatch = requestHeaders?.['if-none-match']
	if (!etag || !ifNoneMatch || !ifNoneMatchMatches(etag, ifNoneMatch)) return null

	const headers: Record<string, string> = { ETag: etag, 'Cache-Control': STANDARD_CACHE_CONTROL }
	if (varyByAcceptEncoding) addVaryHeader(headers, 'Accept-Encoding')
	return new Response(null, { status: 304, headers })
}

function buildStoredResponseHeaders(
	representation: StoredFileRepresentation,
	etag: string | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': representation.mimeType,
		'Cache-Control': STANDARD_CACHE_CONTROL,
		'X-Cache-Tier': representation.result.source,
	}
	if (etag) headers.ETag = etag
	return headers
}

export type ByteRange = { start: number; end: number }
export type ByteRangeParseResult = ByteRange | 'unsatisfiable' | null

/** Parse one RFC 9110 byte range. Unsupported syntax is ignored; a valid range outside the entity is unsatisfiable. */
export function parseSingleByteRange(value: string | undefined, size: number): ByteRangeParseResult {
	if (!value || !Number.isSafeInteger(size) || size < 0 || value.includes(',')) return null
	const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
	if (!match) return null
	const [, rawStart = '', rawEnd = ''] = match
	if (!rawStart && !rawEnd) return null
	if (size === 0) return 'unsatisfiable'

	if (!rawStart) {
		const suffixLength = Number(rawEnd)
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable'
		return { start: Math.max(0, size - suffixLength), end: size - 1 }
	}

	const start = Number(rawStart)
	if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable'
	if (!rawEnd) return { start, end: size - 1 }
	const requestedEnd = Number(rawEnd)
	if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return 'unsatisfiable'
	return { start, end: Math.min(requestedEnd, size - 1) }
}

function requestedByteRange(
	requestHeaders: Record<string, string> | undefined,
	headers: Record<string, string>,
	size: number,
): ByteRangeParseResult {
	const ifRange = requestHeaders?.['if-range']
	if (ifRange && ifRange !== headers.ETag) return null
	return parseSingleByteRange(requestHeaders?.range, size)
}

function buildStorageBodyResponse(
	content: Buffer,
	headers: Record<string, string>,
	filePath: string,
	settings: WispSettings | null,
	sharedOrigin: boolean,
	varyByAcceptEncoding: boolean,
	requestHeaders?: Record<string, string>,
): Response {
	applyFileResponseHeaders(headers, filePath, settings, sharedOrigin, varyByAcceptEncoding)
	headers['Accept-Ranges'] = 'bytes'
	const range = requestedByteRange(requestHeaders, headers, content.byteLength)
	if (range === 'unsatisfiable') {
		headers['Content-Range'] = `bytes */${content.byteLength}`
		headers['Content-Length'] = '0'
		return new Response(null, { status: 416, headers })
	}

	let body = content
	let status = 200
	if (range) {
		body = content.subarray(range.start, range.end + 1)
		status = 206
		headers['Content-Range'] = `bytes ${range.start}-${range.end}/${content.byteLength}`
	}
	// Set this explicitly so Hono's automatic HEAD response retains GET parity.
	headers['Content-Length'] = `${body.byteLength}`
	return new Response(bufferResponseBody(body), { status, headers })
}

async function getIdentityResponseContent(
	representation: StoredFileRepresentation,
	preparation: GzipPreparation,
	filePath: string,
): Promise<IdentityResponseContent> {
	if (preparation.kind === 'ready' && preparation.decodedIdentity) {
		return { kind: 'content', content: preparation.decodedIdentity }
	}

	const decoded = await decodeStoredGzipIdentity(
		getStoredFileContent(representation),
		filePath,
		representation.varyByAcceptEncoding,
	)
	if (decoded.kind === 'failure') return decoded
	return { kind: 'content', content: decoded.content }
}

async function buildStoredFileBodyResponse(
	representation: StoredFileRepresentation,
	preparation: GzipPreparation,
	filePath: string,
	settings: WispSettings | null,
	sharedOrigin: boolean,
	etag: string | undefined,
	requestHeaders?: Record<string, string>,
): Promise<Response> {
	const headers = buildStoredResponseHeaders(representation, etag)
	if (representation.isGzipContent && !representation.shouldServeCompressed) {
		const identity = await getIdentityResponseContent(representation, preparation, filePath)
		if (identity.kind === 'failure') return identity.response
		return buildStorageBodyResponse(
			identity.content,
			headers,
			filePath,
			settings,
			sharedOrigin,
			representation.varyByAcceptEncoding,
			requestHeaders,
		)
	}

	if (representation.isGzipContent) headers['Content-Encoding'] = 'gzip'
	return buildStorageBodyResponse(
		getStoredFileContent(representation),
		headers,
		filePath,
		settings,
		sharedOrigin,
		representation.varyByAcceptEncoding,
		requestHeaders,
	)
}

async function buildResponseFromStorageResult(
	result: FileStorageResult,
	filePath: string,
	settings: WispSettings | null,
	requestHeaders?: Record<string, string>,
	sharedOrigin = false,
): Promise<Response> {
	const representation = createStoredFileRepresentation(result, filePath, requestHeaders)
	const preparation = await prepareStoredGzipResponse(representation, filePath)
	if (preparation.kind === 'failure') return preparation.response

	const etag = getRepresentationEtag(representation)
	const notModified = buildNotModifiedResponse(etag, requestHeaders, representation.varyByAcceptEncoding)
	if (notModified) return notModified
	return await buildStoredFileBodyResponse(
		representation,
		preparation,
		filePath,
		settings,
		sharedOrigin,
		etag,
		requestHeaders,
	)
}

async function prepareHtmlRewriteSource(
	representation: StoredFileRepresentation,
	filePath: string,
): Promise<HtmlRewriteSource> {
	if (representation.explicitlyGzipped && !representation.hasGzipMagic) {
		return gzipFailure(filePath, 'invalid-gzip', representation.varyByAcceptEncoding)
	}
	if (!representation.isGzipContent) return { kind: 'content', content: getStoredFileContent(representation) }
	if (getStoredGzipSizeStatus(representation.metadata) === 'over-limit') {
		return gzipFailure(filePath, 'output-limit', representation.varyByAcceptEncoding)
	}

	const decoded = await decodeStoredGzipIdentity(
		getStoredFileContent(representation),
		filePath,
		representation.varyByAcceptEncoding,
	)
	if (decoded.kind === 'failure') return decoded
	return { kind: 'content', content: decoded.content }
}

async function rewriteHtmlContent(content: Buffer, basePath: string, filePath: string): Promise<RewrittenHtmlAttempt> {
	try {
		const htmlString = new TextDecoder().decode(content)
		const rewritten = await rewriteHtmlPaths(htmlString, basePath)
		const output = Buffer.from(new TextEncoder().encode(rewritten))
		if (output.byteLength <= MAX_BLOB_SIZE) return { kind: 'rewritten', output }

		logger.warn('Rewritten HTML exceeds the file limit, serving original', {
			filePath,
			failureKind: 'rewritten-output-limit',
		})
		return { kind: 'serve-original' }
	} catch {
		// The gzip input has already been successfully bounded-decoded, so an
		// ordinary rewriter failure can safely preserve the established fallback.
		logger.warn('Failed to rewrite HTML on demand, serving original', { filePath, failureKind: 'html-rewrite-failed' })
		return { kind: 'serve-original' }
	}
}

async function compressRewrittenHtml(
	output: Buffer,
	filePath: string,
	shouldCompress: boolean,
	requestHeaders: Record<string, string> | undefined,
): Promise<RewrittenHtmlCompression> {
	if (!shouldCompress || !clientAcceptsGzip(requestHeaders)) return { output }

	try {
		const compressed = await withGzipProcessingBudget(() => gzipOperations.compress(output))
		return { output: Buffer.from(compressed), contentEncoding: 'gzip' }
	} catch {
		// The rewritten identity body is already safe. Do not fall back to the
		// original representation merely because recompression failed.
		logger.warn('Failed to recompress rewritten HTML, serving identity', {
			filePath,
			failureKind: 'gzip-compress-failed',
		})
		return { output }
	}
}

async function buildRewrittenHtmlResponse(
	result: FileStorageResult,
	filePath: string,
	basePath: string,
	settings: WispSettings | null,
	requestHeaders?: Record<string, string>,
	sharedOrigin = false,
): Promise<Response> {
	const representation = createStoredFileRepresentation(result, filePath, requestHeaders, true)
	const source = await prepareHtmlRewriteSource(representation, filePath)
	if (source.kind === 'failure') return source.response

	const rewritten = await rewriteHtmlContent(source.content, basePath, filePath)
	if (rewritten.kind === 'serve-original') {
		return await buildResponseFromStorageResult(result, filePath, settings, requestHeaders, sharedOrigin)
	}

	const compressed = await compressRewrittenHtml(
		rewritten.output,
		filePath,
		representation.shouldCompress,
		requestHeaders,
	)
	const headers = buildStoredResponseHeaders(representation, undefined)
	if (compressed.contentEncoding) headers['Content-Encoding'] = compressed.contentEncoding
	return buildStorageBodyResponse(
		compressed.output,
		headers,
		filePath,
		settings,
		sharedOrigin,
		representation.varyByAcceptEncoding,
		requestHeaders,
	)
}

interface FileResolverOptions {
	did: string
	rkey: string
	settings: WispSettings | null
	requestHeaders?: Record<string, string>
	requestMethod?: string
	signal?: AbortSignal
	trace?: RequestTrace | null
	strategy: FileServingStrategy
	/** Preloaded manifest for top-level requests; avoids a second database read. */
	manifest?: SiteManifest | null
}

interface FileResolver {
	getManifest(): Promise<SiteManifest | null>
	findFirstExpectedFile(paths: Iterable<string>): Promise<FileForRequestResult | null>
	findFallbackFile(filePath: string): Promise<FileForRequestResult | null>
	markExpectedMiss(filePath: string): Promise<void>
	expectedMissResponse(): Promise<Response | null>
}

interface RequestPathInfo {
	requestPath: string
	isDirectoryPathRequest: boolean
}

interface CachedRequestOptions {
	did: string
	rkey: string
	filePath: string
	fullUrl?: string
	requestHeaders?: Record<string, string>
	requestMethod?: string
	signal?: AbortSignal
	strategy: FileServingStrategy
}

interface FileRequestOptions extends FileResolverOptions {
	filePath: string
}

interface RedirectRequestOptions extends CachedRequestOptions {
	indexFiles: string[]
	redirectsPresent: boolean
	fileObjects: FileObjects | null
	trace: RequestTrace | null
	resolveFile(filePath: string): Promise<Response>
}

/**
 * Deduplicate lookup candidates without changing their priority.
 */
function orderedUniquePaths(paths: Iterable<string>): string[] {
	const seen = new Set<string>()
	const uniquePaths: string[] = []

	for (const path of paths) {
		if (seen.has(path)) continue
		seen.add(path)
		uniquePaths.push(path)
	}

	return uniquePaths
}

function indexPathCandidates(requestPath: string, indexFiles: string[]): string[] {
	return orderedUniquePaths(indexFiles.map((indexFile) => (requestPath ? `${requestPath}/${indexFile}` : indexFile)))
}

function directoryRequestCandidates(
	requestPath: string,
	isDirectoryPathRequest: boolean,
	indexFiles: string[],
): string[] {
	const indexPaths = indexPathCandidates(requestPath, indexFiles)
	if (!requestPath || isDirectoryPathRequest) return indexPaths
	return orderedUniquePaths([requestPath, ...indexPaths])
}

function fileAndIndexCandidates(filePath: string, indexFiles: string[]): string[] {
	return orderedUniquePaths([filePath, ...indexPathCandidates(filePath, indexFiles)])
}

function cleanUrlCandidates(filePath: string, indexFiles: string[]): string[] {
	return orderedUniquePaths([`${filePath}.html`, ...indexPathCandidates(filePath, indexFiles)])
}

function normalizeRequestPath(filePath: string): RequestPathInfo {
	const isDirectoryPathRequest = filePath.endsWith('/') && filePath.length > 0
	let requestPath = filePath || ''
	if (requestPath.endsWith('/') && requestPath.length > 1) {
		requestPath = requestPath.slice(0, -1)
	}
	return { requestPath, isDirectoryPathRequest }
}

function wrapResponseStatus(response: Response, status: number): Response {
	return new Response(response.body, { status, headers: response.headers })
}

function buildDirectoryListingResponse(
	requestPath: string,
	entries: Array<{ name: string; isDirectory: boolean }>,
	status = 200,
): Response {
	return new Response(generateDirectoryListing(requestPath, entries), {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': STANDARD_CACHE_CONTROL,
		},
	})
}

function buildStyled404Response(): Response {
	return new Response(generate404Page(), {
		status: 404,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': STANDARD_CACHE_CONTROL,
		},
	})
}

function createExpectedManifestMissTracker(
	did: string,
	rkey: string,
	requestHeaders: Record<string, string> | undefined,
	getManifest: () => Promise<SiteManifest | null>,
	strategy: FileServingStrategy,
) {
	let expectedMissPath: string | null = null

	return {
		async mark(filePath: string): Promise<void> {
			if (expectedMissPath) return
			const manifest = await getManifest()
			if (!manifest) return

			// A pre-rewritten cache entry is still derived from its original
			// manifest path. If that original CID is absent, fail closed and
			// request repair rather than falling through to a styled 404.
			if (manifestLookupPaths(filePath, strategy).some((path) => manifestHasPath(manifest.fileCids, path))) {
				expectedMissPath = sourceManifestPath(filePath)
			}
		},
		async response(): Promise<Response | null> {
			if (!expectedMissPath) return null
			recordStorageMiss(expectedMissPath)
			await enqueueRevalidate(did, rkey, `storage-miss:${expectedMissPath}`)
			return buildStorageMissResponse(requestHeaders)
		},
	}
}

function manifestLookupPaths(filePath: string, strategy: FileServingStrategy): string[] {
	const originalPath = normalizeFilePath(filePath)
	if (strategy.fileLookup === 'original') return [originalPath]
	return orderedUniquePaths([originalPath, `.rewritten/${originalPath}`])
}

function manifestMayContainFile(
	manifest: SiteManifest | null,
	filePath: string,
	strategy: FileServingStrategy,
): boolean {
	return manifestLookupPaths(filePath, strategy).some((path) => manifestHasPath(manifest?.fileCids ?? null, path))
}

function createFileResolver(options: FileResolverOptions): FileResolver {
	const { did, rkey, requestHeaders, strategy, trace } = options
	let loadedManifest = options.manifest
	let manifestLoaded = options.manifest !== undefined
	const attemptedPaths = new Set<string>()

	const getManifest = async (): Promise<SiteManifest | null> => {
		if (!manifestLoaded) {
			loadedManifest = await getSiteManifest(did, rkey, trace)
			manifestLoaded = true
		}
		return loadedManifest ?? null
	}

	const missTracker = createExpectedManifestMissTracker(did, rkey, requestHeaders, getManifest, strategy)

	const getExpectedFile = async (filePath: string): Promise<FileForRequestResult | null> => {
		const manifest = await getManifest()
		if (!manifestMayContainFile(manifest, filePath, strategy)) return null
		return await span(trace, `storage:${filePath}`, () =>
			getFileForRequest(did, rkey, filePath, strategy, manifest, options.signal),
		)
	}

	return {
		getManifest,
		async findFirstExpectedFile(paths: Iterable<string>): Promise<FileForRequestResult | null> {
			for (const filePath of orderedUniquePaths(paths)) {
				if (attemptedPaths.has(filePath)) continue
				attemptedPaths.add(filePath)

				const result = await getExpectedFile(filePath)
				if (result) return result
				await missTracker.mark(filePath)
			}
			return null
		},
		findFallbackFile: async (filePath) =>
			getFallbackFile(did, rkey, filePath, await getManifest(), strategy, trace, options.signal),
		markExpectedMiss: (filePath) => missTracker.mark(filePath),
		expectedMissResponse: () => missTracker.response(),
	}
}

async function buildStreamFileResponse(
	options: FileResolverOptions,
	filePath: string,
	result: StreamResult & { streamGzipMagic?: boolean },
): Promise<Response> {
	const { requestHeaders, settings, strategy, signal, requestMethod } = options
	const initialRepresentation = createStoredFileRepresentation(
		result,
		filePath,
		requestHeaders,
		false,
		result.streamGzipMagic,
	)
	const { metadata, hasGzipMagic, explicitlyGzipped, isGzipContent, shouldServeCompressed, varyByAcceptEncoding } =
		initialRepresentation
	if (explicitlyGzipped && !hasGzipMagic) {
		disposeFileStream(result.stream)
		return gzipFailure(filePath, 'invalid-gzip', varyByAcceptEncoding).response
	}

	let prepared = result
	if (isGzipContent) {
		const sizeStatus = getStoredGzipSizeStatus(metadata)
		if (sizeStatus === 'over-limit') {
			disposeFileStream(prepared.stream)
			return gzipFailure(filePath, 'output-limit', varyByAcceptEncoding).response
		}
		if (!(sizeStatus === 'trusted' && shouldServeCompressed)) {
			try {
				prepared = await withGzipProcessingBudget(() =>
					transformFileStream(result, shouldServeCompressed ? 'measure-gzip' : 'identity', signal),
				)
			} catch (error) {
				return gzipFailure(filePath, getGzipFailureKind(error), varyByAcceptEncoding).response
			}
		}
	}

	const representation = createStoredFileRepresentation(prepared, filePath, requestHeaders, false, hasGzipMagic)
	const etag = getRepresentationEtag(representation)
	const notModified = buildNotModifiedResponse(etag, requestHeaders, varyByAcceptEncoding)
	if (notModified) {
		await disposeFileStreamAndWait(prepared.stream)
		return notModified
	}

	const headers = buildStoredResponseHeaders(representation, etag)
	if (shouldServeCompressed) headers['Content-Encoding'] = 'gzip'
	applyFileResponseHeaders(headers, filePath, settings, strategy.sharedOrigin, varyByAcceptEncoding)
	headers['Accept-Ranges'] = 'bytes'
	const size = prepared.metadata.size
	const range = requestedByteRange(requestHeaders, headers, size)
	if (range === 'unsatisfiable') {
		await disposeFileStreamAndWait(prepared.stream)
		headers['Content-Range'] = `bytes */${size}`
		headers['Content-Length'] = '0'
		return new Response(null, { status: 416, headers })
	}

	let bodyStream: NodeJS.ReadableStream = prepared.stream
	let status = 200
	let bodySize = size
	if (range) {
		bodyStream = sliceReadableStream(prepared.stream as Readable, range)
		bodySize = range.end - range.start + 1
		status = 206
		headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
	}
	headers['Content-Length'] = `${bodySize}`
	if (requestMethod?.toUpperCase() === 'HEAD') {
		if (range) await disposeFileStreamAndWait(prepared.stream)
		await disposeFileStreamAndWait(bodyStream)
		return new Response(null, { status, headers })
	}
	return new Response(getStreamResponseBody(bodyStream, signal), { status, headers })
}

function sliceReadableStream(source: Readable, range: ByteRange): Readable {
	async function* chunks() {
		let offset = 0
		for await (const chunk of source) {
			const bytes = chunk as Uint8Array
			const chunkStart = offset
			const chunkEnd = offset + bytes.byteLength - 1
			offset += bytes.byteLength
			if (chunkEnd < range.start) continue
			if (chunkStart > range.end) break
			const start = Math.max(0, range.start - chunkStart)
			const end = Math.min(bytes.byteLength, range.end - chunkStart + 1)
			yield bytes.subarray(start, end)
			if (chunkEnd >= range.end) break
		}
	}
	const sliced = Readable.from(chunks(), { objectMode: false })
	sliced.once('close', () => source.destroy())
	return sliced
}

async function buildFileResponse(options: FileResolverOptions, fileResult: FileForRequestResult): Promise<Response> {
	const { did, rkey, requestHeaders, settings, strategy } = options
	const { filePath, result, wasRewritten } = fileResult
	if ('stream' in result) return await buildStreamFileResponse(options, filePath, result)
	const meta = result.metadata.customMetadata as { encoding?: string; mimeType?: string } | undefined
	const mimeType = meta?.mimeType || lookup(filePath) || 'application/octet-stream'
	const shouldRewriteOnDemand =
		strategy.rewriteMissingHtmlOnDemand && !wasRewritten && isHtmlContent(filePath, mimeType)

	if (shouldRewriteOnDemand) {
		void enqueueRevalidate(did, rkey, `rewrite-miss:${filePath}`)
		return await buildRewrittenHtmlResponse(
			result,
			filePath,
			strategy.basePath ?? '',
			settings,
			requestHeaders,
			strategy.sharedOrigin,
		)
	}

	return buildResponseFromStorageResult(result, filePath, settings, requestHeaders, strategy.sharedOrigin)
}

async function serveExpectedCandidates(
	options: FileResolverOptions,
	resolver: FileResolver,
	candidates: Iterable<string>,
): Promise<Response | null> {
	const result = await resolver.findFirstExpectedFile(candidates)
	return result ? await buildFileResponse(options, result) : null
}

async function serveDirectoryListing(
	options: FileResolverOptions,
	resolver: FileResolver,
	requestPath: string,
	status = 200,
): Promise<Response | null> {
	if (!options.settings?.directoryListing) return null

	const manifest = await resolver.getManifest()
	const entries = listDirectoryEntries(requestPath, manifest ? Object.keys(manifest.fileCids) : null)
	if (entries.length === 0) return null

	const storageMissResponse = await resolver.expectedMissResponse()
	return storageMissResponse ?? buildDirectoryListingResponse(requestPath, entries, status)
}

async function serveFallbackFile(
	options: FileResolverOptions,
	resolver: FileResolver,
	filePath: string,
	status?: number,
): Promise<Response | null> {
	const result = await resolver.findFallbackFile(filePath)
	if (!result) {
		await resolver.markExpectedMiss(filePath)
		return null
	}

	const response = await buildFileResponse(options, result)
	return status === undefined ? response : wrapResponseStatus(response, status)
}

async function serveFirstFallbackFile(
	options: FileResolverOptions,
	resolver: FileResolver,
	filePaths: Iterable<string>,
	status?: number,
): Promise<Response | null> {
	for (const filePath of orderedUniquePaths(filePaths)) {
		const response = await serveFallbackFile(options, resolver, filePath, status)
		if (response) return response
	}
	return null
}

async function serveConfiguredFallbacks(
	options: FileResolverOptions,
	resolver: FileResolver,
): Promise<Response | null> {
	const { custom404, spaMode } = options.settings ?? {}

	if (spaMode) {
		const spaResponse = await serveFallbackFile(options, resolver, spaMode)
		if (spaResponse) return spaResponse
	}

	if (custom404) {
		return await serveFallbackFile(options, resolver, custom404, 404)
	}

	return null
}

function adjustRedirectTarget(targetPath: string, strategy: FileServingStrategy): string {
	if (!strategy.adjustSharedPathRedirect || !strategy.basePath || isAbsoluteHttpUrl(targetPath)) {
		return targetPath
	}
	return `${strategy.basePath}${targetPath.startsWith('/') ? targetPath.slice(1) : targetPath}`
}

function buildRedirectResponse(status: number, targetPath: string, strategy: FileServingStrategy): Response {
	return new Response(null, {
		status,
		headers: {
			Location: adjustRedirectTarget(targetPath, strategy),
			'Cache-Control': STANDARD_CACHE_CONTROL,
		},
	})
}

function internalRedirectPath(targetPath: string): string {
	return targetPath.startsWith('/') ? targetPath.slice(1) : targetPath
}

async function serveRedirectTarget(
	status: number,
	targetPath: string,
	strategy: FileServingStrategy,
	resolveFile: (filePath: string) => Promise<Response>,
): Promise<Response | null> {
	switch (status) {
		case 200:
			if (isAbsoluteHttpUrl(targetPath)) return externalRewriteNotAllowedResponse(targetPath)
			return await resolveFile(internalRedirectPath(targetPath))
		case 301:
		case 302:
			return buildRedirectResponse(status, targetPath, strategy)
		case 404: {
			const response = await resolveFile(internalRedirectPath(targetPath))
			// A redirect-defined 404 must not disguise an unavailable or stale
			// manifest object as a cacheable not-found response.
			return response.status === 503 ? response : wrapResponseStatus(response, 404)
		}
		default:
			return null
	}
}

async function serveRedirectResponse(options: RedirectRequestOptions): Promise<Response | null> {
	const { did, rkey, filePath, fullUrl, indexFiles, requestHeaders, resolveFile, strategy, trace } = options
	if (!options.redirectsPresent) return null
	const redirectRules = await cache.getOrFetch('redirectRules', `${did}:${rkey}`, () =>
		span(trace, 'storage:redirectRules', () => loadRedirectRules(did, rkey, options.fileObjects)),
	)
	if (redirectRules.length === 0) return null

	const requestPath = `/${filePath || ''}`
	const redirectMatch = matchRedirectRule(requestPath, redirectRules, {
		queryParams: fullUrl ? parseQueryString(fullUrl) : {},
		headers: requestHeaders,
		cookies: parseCookies(requestHeaders?.cookie),
	})
	if (!redirectMatch) return null

	const { rule, status, targetPath } = redirectMatch
	if (!rule.force && (await hasFileForNonForcedRedirect(did, rkey, filePath, indexFiles, trace))) {
		return await resolveFile(filePath)
	}

	return await serveRedirectTarget(status, targetPath, strategy, resolveFile)
}

async function buildSourceCidStorageMissResponse(options: FileRequestOptions, filePath: string): Promise<Response> {
	const sourcePath = sourceManifestPath(filePath)
	recordStorageMiss(sourcePath)
	await enqueueRevalidate(options.did, options.rkey, `storage-miss:${sourcePath}`)
	return buildStorageMissResponse(options.requestHeaders)
}

async function serveFileRequest(options: FileRequestOptions): Promise<Response> {
	try {
		return await resolveFileRequest(options)
	} catch (error) {
		if (isStorageUnavailableError(error)) {
			return buildStorageMissResponse(options.requestHeaders)
		}
		if (error instanceof SourceCidValidationError) {
			return await buildSourceCidStorageMissResponse(options, error.filePath)
		}
		throw error
	}
}

async function resolveFileRequest(options: FileRequestOptions): Promise<Response> {
	const resolver = createFileResolver(options)
	const indexFiles = getIndexFiles(options.settings)
	const { isDirectoryPathRequest, requestPath } = normalizeRequestPath(options.filePath)
	const fileRequestPath = requestPath || indexFiles[0] || 'index.html'
	let response: Response | null = null

	if (!requestPath || !hasFileExtension(requestPath)) {
		response =
			(await serveExpectedCandidates(
				options,
				resolver,
				directoryRequestCandidates(requestPath, isDirectoryPathRequest, indexFiles),
			)) ?? (await serveDirectoryListing(options, resolver, requestPath))
	}

	response ??= await serveExpectedCandidates(options, resolver, fileAndIndexCandidates(fileRequestPath, indexFiles))
	if (options.settings?.cleanUrls && !hasFileExtension(fileRequestPath)) {
		response ??= await serveExpectedCandidates(options, resolver, cleanUrlCandidates(fileRequestPath, indexFiles))
	}

	if (!response) {
		response =
			(await serveConfiguredFallbacks(options, resolver)) ??
			(await serveFirstFallbackFile(options, resolver, ['404.html', 'not_found.html'], 404)) ??
			(await serveDirectoryListing(options, resolver, '', 404))
	}

	return response ?? (await resolver.expectedMissResponse()) ?? buildStyled404Response()
}

async function resolveCachedRequest(options: CachedRequestOptions, trace: RequestTrace | null): Promise<Response> {
	const { did, filePath, requestHeaders, rkey, strategy } = options
	const manifest = await getSiteManifest(did, rkey, trace)
	if (manifest === null) {
		recordStorageMiss('manifest')
		await enqueueRevalidate(did, rkey, 'storage-miss:manifest')
		return buildStorageMissResponse(requestHeaders)
	}
	const settings = await span(trace, 'db:settings', () => getCachedSettings(did, rkey))
	const indexFiles = getIndexFiles(settings)
	const resolveFile = (path: string) =>
		serveFileRequest({
			did,
			rkey,
			filePath: path,
			settings,
			requestHeaders,
			requestMethod: options.requestMethod,
			signal: options.signal,
			trace,
			strategy,
			manifest,
		})

	const redirectResponse = await serveRedirectResponse({
		...options,
		indexFiles,
		redirectsPresent: manifest.fileCids._redirects !== undefined,
		fileObjects: manifest.fileObjects,
		resolveFile,
		trace,
	})
	const response = redirectResponse ?? (await resolveFile(filePath))
	// Start the manifest-backed warmup only after the requested response has
	// resolved, so unrelated HTML reads cannot delay this request.
	triggerSiteHtmlHotCacheWarmup(did, rkey, Object.keys(manifest.fileCids), manifest.fileObjects)
	return response
}

async function serveCachedRequest(options: CachedRequestOptions): Promise<Response> {
	const { did, filePath, requestHeaders, rkey } = options
	if (isSiteUpdating(did, rkey)) {
		return buildSiteUpdatingResponse(requestHeaders)
	}

	const trace = createTrace()
	try {
		return await resolveCachedRequest(options, trace)
	} catch (error) {
		if (!isStorageUnavailableError(error)) throw error
		return buildStorageMissResponse(requestHeaders)
	} finally {
		logTrace(trace, filePath || '/', logger)
	}
}

/**
 * Serve files for custom domains and subdomains.
 */
export async function serveFromCache(
	did: string,
	rkey: string,
	filePath: string,
	fullUrl?: string,
	headers?: Record<string, string>,
	options?: FileServeRequestOptions,
): Promise<Response> {
	return await serveCachedRequest({
		did,
		rkey,
		filePath,
		fullUrl,
		requestHeaders: headers,
		requestMethod: options?.method,
		signal: options?.signal,
		strategy: ORIGINAL_FILE_STRATEGY,
	})
}

/**
 * Resolve a file for custom domains and subdomains.
 */
export async function serveFileInternal(
	did: string,
	rkey: string,
	filePath: string,
	settings: WispSettings | null = null,
	requestHeaders?: Record<string, string>,
	trace?: RequestTrace | null,
	options?: FileServeRequestOptions,
): Promise<Response> {
	return await serveFileRequest({
		did,
		rkey,
		filePath,
		settings,
		requestHeaders,
		requestMethod: options?.method,
		signal: options?.signal,
		trace,
		strategy: ORIGINAL_FILE_STRATEGY,
	})
}

/**
 * Serve files for sites.wisp.place paths, including HTML path rewriting.
 */
export async function serveFromCacheWithRewrite(
	did: string,
	rkey: string,
	filePath: string,
	basePath: string,
	fullUrl?: string,
	headers?: Record<string, string>,
	options?: FileServeRequestOptions,
): Promise<Response> {
	return await serveCachedRequest({
		did,
		rkey,
		filePath,
		fullUrl,
		requestHeaders: headers,
		requestMethod: options?.method,
		signal: options?.signal,
		strategy: createSharedOriginFileStrategy(basePath),
	})
}

/**
 * Resolve a file for sites.wisp.place paths, including HTML path rewriting.
 */
export async function serveFileInternalWithRewrite(
	did: string,
	rkey: string,
	filePath: string,
	basePath: string,
	settings: WispSettings | null = null,
	requestHeaders?: Record<string, string>,
	trace?: RequestTrace | null,
	options?: FileServeRequestOptions,
): Promise<Response> {
	return await serveFileRequest({
		did,
		rkey,
		filePath,
		settings,
		requestHeaders,
		requestMethod: options?.method,
		signal: options?.signal,
		trace,
		strategy: createSharedOriginFileStrategy(basePath),
	})
}
