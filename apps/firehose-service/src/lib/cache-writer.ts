/**
 * Cache writer - downloads blobs from PDS and writes to S3
 * Handles incremental updates by comparing CIDs
 */

import { gunzipSync } from 'node:zlib'
import { extractBlobCid, getPdsForDid } from '@wispplace/atproto-utils'
import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression'
import { MAX_BLOB_SIZE, MAX_FILE_COUNT, MAX_SITE_SIZE, MAX_SITE_SIZE_SUPPORTER } from '@wispplace/constants'
import { collectFileCidsFromEntries, countFilesInDirectory, normalizeFileCids } from '@wispplace/fs-utils'
import { isHtmlContent, rewriteHtmlPaths } from '@wispplace/fs-utils/html-rewriter'
import type { Directory, Entry, File, Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import type { Record as SubfsRecord } from '@wispplace/lexicons/types/place/wisp/subfs'
import { createLogger } from '@wispplace/observability'
import { safeFetchBlob, safeFetchJson } from '@wispplace/safe-fetch'
import { publishCacheInvalidation } from './cache-invalidation'
import {
	deleteSite,
	deleteSiteCache,
	deleteSiteSettingsCache,
	getSiteCache,
	isSupporter,
	upsertSite,
	upsertSiteCache,
	upsertSiteSettingsCache,
} from './db'
import { deleteFile, listFiles, writeFile } from './storage'

const logger = createLogger('firehose-service')
const BLOB_500_BACKOFF_MS = Number.parseInt(process.env.BLOB_500_BACKOFF_MS || `${10 * 60 * 1000}`, 10)
const blob500BackoffUntil = new Map<string, number>()

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

/**
 * Fetch a site record from the PDS
 */
export async function fetchSiteRecord(
	did: string,
	rkey: string,
): Promise<{ record: WispFsRecord; cid: string } | null> {
	try {
		const pdsEndpoint = await getPdsForDid(did)
		if (!pdsEndpoint) {
			logger.error('Failed to get PDS endpoint for DID', undefined, { did, rkey })
			return null
		}

		const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.fs&rkey=${encodeURIComponent(rkey)}`
		const data = await safeFetchJson(url)

		return {
			record: data.value as WispFsRecord,
			cid: data.cid || '',
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		if (errorMsg.includes('HTTP 404') || errorMsg.includes('Not Found')) {
			logger.info('Site record not found', { did, rkey })
		} else {
			logger.error('Failed to fetch site record', err, { did, rkey })
		}
		return null
	}
}

/**
 * List all place.wisp.fs records for a DID.
 */
export async function listSiteRecordsForDid(
	did: string,
): Promise<Array<{ rkey: string; record: WispFsRecord; cid: string }>> {
	const pdsEndpoint = await getPdsForDid(did)
	if (!pdsEndpoint) {
		logger.error('Failed to get PDS endpoint for DID (listRecords)', undefined, { did })
		return []
	}

	const records: Array<{ rkey: string; record: WispFsRecord; cid: string }> = []
	let cursor: string | undefined

	while (true) {
		const params = new URLSearchParams({
			repo: did,
			collection: 'place.wisp.fs',
			limit: '100',
		})
		if (cursor) params.set('cursor', cursor)

		const url = `${pdsEndpoint}/xrpc/com.atproto.repo.listRecords?${params.toString()}`
		const data = (await safeFetchJson(url)) as {
			records?: Array<{ uri?: string; value?: unknown; cid?: string }>
			cursor?: string
		}

		const pageRecords = Array.isArray(data.records) ? data.records : []
		for (const row of pageRecords) {
			const uri = row.uri
			const record = row.value as WispFsRecord | undefined
			if (!uri || !record || record.$type !== 'place.wisp.fs') continue

			const uriParts = uri.split('/')
			const rkey = uriParts[uriParts.length - 1]
			if (!rkey) continue

			records.push({
				rkey,
				record,
				cid: row.cid || '',
			})
		}

		const nextCursor = typeof data.cursor === 'string' && data.cursor.length > 0 ? data.cursor : undefined
		if (!nextCursor) break
		cursor = nextCursor
	}

	return records
}

/**
 * Fetch a settings record from the PDS
 */
export async function fetchSettingsRecord(
	did: string,
	rkey: string,
	pdsEndpoint?: string,
): Promise<{ record: WispSettings; cid: string } | null> {
	try {
		const endpoint = pdsEndpoint ?? (await getPdsForDid(did))
		if (!endpoint) {
			logger.error('Failed to get PDS endpoint for DID (settings)', undefined, { did, rkey })
			return null
		}

		const url = `${endpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.settings&rkey=${encodeURIComponent(rkey)}`
		const data = await safeFetchJson(url)

		return {
			record: data.value as WispSettings,
			cid: data.cid || '',
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		if (errorMsg.includes('HTTP 404') || errorMsg.includes('Not Found')) {
			logger.info('Settings record not found', { did, rkey })
		} else {
			logger.error('Failed to fetch settings record', err, { did, rkey })
		}
		return null
	}
}

/**
 * Fetch a subfs record from the PDS
 */
async function fetchSubfsRecord(uri: string, pdsEndpoint: string): Promise<SubfsRecord | null> {
	try {
		const parts = uri.replace('at://', '').split('/')
		if (parts.length < 3) return null

		const did = parts[0] || ''
		const collection = parts[1] || ''
		const rkey = parts[2] || ''

		const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`
		const response = await safeFetchJson(url)

		return (response?.value as SubfsRecord) || null
	} catch {
		return null
	}
}

/**
 * Extract all subfs URIs from a directory tree
 */
function extractSubfsUris(directory: Directory, currentPath: string = ''): Array<{ uri: string; path: string }> {
	const uris: Array<{ uri: string; path: string }> = []

	for (const entry of directory.entries) {
		const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name

		if ('type' in entry.node) {
			if (entry.node.type === 'subfs') {
				const subfsNode = entry.node as any
				if (subfsNode.subject) {
					uris.push({ uri: subfsNode.subject, path: fullPath })
				}
			} else if (entry.node.type === 'directory') {
				const subUris = extractSubfsUris(entry.node as Directory, fullPath)
				uris.push(...subUris)
			}
		}
	}

	return uris
}

/**
 * Expand subfs nodes in a directory tree
 */
export async function expandSubfsNodes(
	directory: Directory,
	pdsEndpoint: string,
	depth: number = 0,
	subfsCache: Map<string, SubfsRecord | null> = new Map(),
): Promise<Directory> {
	const MAX_DEPTH = 10

	if (depth >= MAX_DEPTH) {
		logger.error('Max subfs expansion depth reached')
		return directory
	}

	const subfsUris = extractSubfsUris(directory)
	if (subfsUris.length === 0) return directory

	// Fetch uncached subfs records
	const uncachedUris = subfsUris.filter(({ uri }) => !subfsCache.has(uri))
	if (uncachedUris.length > 0) {
		logger.info(`Fetching ${uncachedUris.length} subfs records`, { depth })
		const fetchedRecords = await Promise.all(
			uncachedUris.map(async ({ uri }) => {
				const record = await fetchSubfsRecord(uri, pdsEndpoint)
				return { uri, record }
			}),
		)
		for (const { uri, record } of fetchedRecords) {
			subfsCache.set(uri, record)
		}
	}

	// Build map of path -> entries
	const subfsMap = new Map<string, Entry[]>()
	for (const { uri, path } of subfsUris) {
		const record = subfsCache.get(uri)
		if (record?.root?.entries) {
			subfsMap.set(path, record.root.entries as unknown as Entry[])
		}
	}

	// Replace subfs nodes
	function replaceSubfsInEntries(entries: Entry[], currentPath: string = ''): Entry[] {
		const result: Entry[] = []

		for (const entry of entries) {
			const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
			const node = entry.node

			if ('type' in node && node.type === 'subfs') {
				const subfsNode = node as any
				const isFlat = subfsNode.flat !== false
				const subfsEntries = subfsMap.get(fullPath)

				if (subfsEntries) {
					if (isFlat) {
						const processedEntries = replaceSubfsInEntries(subfsEntries, currentPath)
						result.push(...processedEntries)
					} else {
						const processedEntries = replaceSubfsInEntries(subfsEntries, fullPath)
						const directoryNode: Directory = { type: 'directory', entries: processedEntries }
						result.push({ name: entry.name, node: directoryNode as any })
					}
				} else {
					result.push(entry)
				}
			} else if ('type' in node && node.type === 'directory' && 'entries' in node) {
				result.push({
					...entry,
					node: { ...node, entries: replaceSubfsInEntries(node.entries, fullPath) },
				})
			} else {
				result.push(entry)
			}
		}

		return result
	}

	const partiallyExpanded = {
		...directory,
		entries: replaceSubfsInEntries(directory.entries),
	}

	return expandSubfsNodes(partiallyExpanded, pdsEndpoint, depth + 1, subfsCache)
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
				const fileNode = node as File
				totalSize += (fileNode.blob as any)?.size || 0
			}
		}
	}

	sumBlobSizes(directory.entries)
	return totalSize
}

interface FileInfo {
	path: string
	cid: string
	blob: any
	encoding?: 'gzip'
	mimeType?: string
	base64?: boolean
}

function isTextLikeMime(mimeType?: string, path?: string): boolean {
	if (mimeType) {
		if (mimeType === 'text/html') return true
		if (mimeType === 'text/css') return true
		if (mimeType === 'text/javascript') return true
		if (mimeType === 'application/javascript') return true
		if (mimeType === 'application/json') return true
		if (mimeType === 'application/xml') return true
		if (mimeType === 'image/svg+xml') return true
	}

	if (!path) return false
	const lower = path.toLowerCase()
	return (
		lower.endsWith('.html') ||
		lower.endsWith('.htm') ||
		lower.endsWith('.css') ||
		lower.endsWith('.js') ||
		lower.endsWith('.json') ||
		lower.endsWith('.xml') ||
		lower.endsWith('.svg')
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

/**
 * Collect file info from directory entries
 */
function collectFileInfo(entries: Entry[], pathPrefix: string = ''): FileInfo[] {
	const files: FileInfo[] = []

	for (const entry of entries) {
		const currentPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name
		const node = entry.node

		if ('type' in node && node.type === 'directory' && 'entries' in node) {
			files.push(...collectFileInfo(node.entries, currentPath))
		} else if ('type' in node && node.type === 'file' && 'blob' in node) {
			const fileNode = node as File
			const cid = extractBlobCid(fileNode.blob)
			if (cid) {
				files.push({
					path: currentPath,
					cid,
					blob: fileNode.blob,
					encoding: fileNode.encoding,
					mimeType: fileNode.mimeType,
					base64: fileNode.base64,
				})
			}
		}
	}

	return files
}

/**
 * Download a blob and write to S3
 */
async function downloadAndWriteBlob(did: string, rkey: string, file: FileInfo, pdsEndpoint: string): Promise<void> {
	const blobUrl = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(file.cid)}`
	const blobKey = `${did}:${file.cid}`

	const backoffUntil = getBackoffUntil(blobKey)
	if (backoffUntil) {
		throw new Blob500BackoffError(blobKey, backoffUntil)
	}

	logger.debug(`Downloading ${file.path}`)

	let content: Uint8Array
	try {
		content = await safeFetchBlob(blobUrl, { maxSize: MAX_BLOB_SIZE, timeout: 300000 })
	} catch (err) {
		if (isHttp500Error(err)) {
			const until = set500Backoff(blobKey)
			logger.warn(`Caching blob HTTP 500 for ${BLOB_500_BACKOFF_MS}ms`, {
				did,
				rkey,
				path: file.path,
				cid: file.cid,
				backoffUntil: new Date(until).toISOString(),
			})
			throw new Blob500BackoffError(blobKey, until, err)
		}
		throw err
	}
	blob500BackoffUntil.delete(blobKey)
	let encoding = file.encoding

	// Decode base64 if needed
	if (file.base64) {
		const textDecoder = new TextDecoder()
		const base64String = textDecoder.decode(content)
		content = Buffer.from(base64String, 'base64')
	} else if (isTextLikeMime(file.mimeType, file.path)) {
		// Heuristic fallback: some records omit base64 flag but content is base64 text
		const decoded = tryDecodeBase64(content)
		if (decoded) {
			logger.warn(`Decoded base64 fallback for ${file.path} (base64 flag missing)`)
			content = decoded
		}
	}

	// Decompress if needed and shouldn't stay compressed
	const shouldStayCompressed = shouldCompressMimeType(file.mimeType)

	if (
		encoding === 'gzip' &&
		!shouldStayCompressed &&
		content.length >= 2 &&
		content[0] === 0x1f &&
		content[1] === 0x8b
	) {
		try {
			content = gunzipSync(content)
			encoding = undefined
		} catch (error) {
			logger.error(`Failed to decompress ${file.path}, storing gzipped`, error)
		}
	} else if (encoding === 'gzip' && content.length >= 2 && !(content[0] === 0x1f && content[1] === 0x8b)) {
		// If marked gzip but doesn't look gzipped, attempt base64 decode and retry
		const decoded = tryDecodeBase64(content)
		if (decoded && decoded.length >= 2 && decoded[0] === 0x1f && decoded[1] === 0x8b) {
			logger.warn(`Decoded base64+gzip fallback for ${file.path}`)
			try {
				content = gunzipSync(decoded)
				encoding = undefined
			} catch (error) {
				logger.error(`Failed to decompress base64+gzip fallback for ${file.path}, storing gzipped`, error)
				content = decoded
			}
		}
	}

	// If encoding is missing but data looks gzipped for a text-like file, mark it
	if (
		!encoding &&
		isTextLikeMime(file.mimeType, file.path) &&
		content.length >= 2 &&
		content[0] === 0x1f &&
		content[1] === 0x8b
	) {
		encoding = 'gzip'
	}

	// Build storage key
	const key = `${did}/${rkey}/${file.path}`

	// Build metadata
	const metadata: Record<string, string> = {}
	if (encoding) metadata.encoding = encoding
	if (file.mimeType) metadata.mimeType = file.mimeType

	// Write original file to S3
	await writeFile(key, content, metadata)

	// If HTML, also write rewritten version
	if (isHtmlContent(file.path)) {
		try {
			const basePath = `/${did}/${rkey}/`
			let rewriteSource = content
			if (encoding === 'gzip' && content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b) {
				try {
					rewriteSource = gunzipSync(content)
				} catch (error) {
					logger.error(`Failed to decompress ${file.path} for rewrite, using raw content`, error)
				}
			}

			const htmlString = new TextDecoder().decode(rewriteSource)
			const rewritten = await rewriteHtmlPaths(htmlString, basePath)
			const rewrittenContent = new TextEncoder().encode(rewritten)

			const rewrittenKey = `${did}/${rkey}/.rewritten/${file.path}`
			await writeFile(rewrittenKey, rewrittenContent, { mimeType: 'text/html' })
			logger.debug(`Wrote rewritten HTML: ${rewrittenKey}`)
		} catch (error) {
			logger.error(`Failed to cache rewritten HTML for ${file.path}; continuing with original`, error, {
				did,
				rkey,
				path: file.path,
			})
		}
	}

	logger.debug(`Stored ${file.path} (${content.length} bytes)`)
}

/**
 * Handle a site create/update event
 */
export async function handleSiteCreateOrUpdate(
	did: string,
	rkey: string,
	record: WispFsRecord,
	recordCid: string,
	options?: {
		forceRewriteHtml?: boolean
		skipInvalidation?: boolean
		forceDownload?: boolean
	},
): Promise<void> {
	const forceRewriteHtml = options?.forceRewriteHtml === true
	const forceDownload = options?.forceDownload === true
	logger.info(`Processing site ${did}/${rkey}`, {
		recordCid,
		forceRewriteHtml,
		forceDownload,
	})

	if (!record.root?.entries) {
		logger.error('Invalid record structure')
		return
	}

	// Get PDS endpoint
	const pdsEndpoint = await getPdsForDid(did)
	if (!pdsEndpoint) {
		logger.error('Could not resolve PDS', undefined, { did })
		return
	}

	// Expand subfs nodes
	const expandedRoot = await expandSubfsNodes(record.root, pdsEndpoint)

	// Validate limits
	const fileCount = countFilesInDirectory(expandedRoot)
	if (fileCount > MAX_FILE_COUNT) {
		logger.error(`Site exceeds file limit: ${fileCount} > ${MAX_FILE_COUNT}`)
		return
	}

	const totalSize = calculateTotalBlobSize(expandedRoot)
	const sizeLimit = (await isSupporter(did)) ? MAX_SITE_SIZE_SUPPORTER : MAX_SITE_SIZE
	if (totalSize > sizeLimit) {
		logger.error(`Site exceeds size limit: ${totalSize} > ${sizeLimit}`)
		return
	}

	// Collect new file CIDs
	const newFileCids: Record<string, string> = {}
	collectFileCidsFromEntries(expandedRoot.entries, '', newFileCids)

	// Get existing cache from DB
	const existing = await getSiteCache(did, rkey)
	const rawFileCids = existing?.file_cids as unknown
	const normalizedFileCids = normalizeFileCids(rawFileCids)
	const oldFileCids = normalizedFileCids.value
	if (normalizedFileCids.source === 'string-invalid' || normalizedFileCids.source === 'other') {
		logger.warn('Existing file_cids had unexpected shape; treating as empty', {
			did,
			rkey,
			type: Array.isArray(rawFileCids) ? 'array' : typeof rawFileCids,
		})
	}

	// Notify hosting-service that this site is about to be updated so it can
	// show the "updating" page instead of serving stale or partially-updated files.
	const invalidationToken = !options?.skipInvalidation ? crypto.randomUUID() : undefined
	if (!options?.skipInvalidation) {
		await publishCacheInvalidation(did, rkey, 'updating', invalidationToken)
	}

	// Compare CIDs to determine what to download/delete
	const newFiles = collectFileInfo(expandedRoot.entries)
	const filesToDownload: FileInfo[] = []
	const pathsToDelete: string[] = []

	// Find new or changed files
	for (const file of newFiles) {
		const shouldForceRewrite = forceRewriteHtml && isHtmlContent(file.path)
		if (forceDownload || oldFileCids[file.path] !== file.cid || shouldForceRewrite) {
			filesToDownload.push(file)
		}
	}

	// Find deleted files
	for (const oldPath of Object.keys(oldFileCids)) {
		if (!(oldPath in newFileCids)) {
			pathsToDelete.push(oldPath)
		}
	}

	logger.info(
		`Files unchanged: ${newFiles.length - filesToDownload.length}, to download: ${filesToDownload.length}, to delete: ${pathsToDelete.length}`,
	)

	const DOWNLOAD_CONCURRENCY = 20
	const DELETE_CONCURRENCY = 50

	const downloadFiles = async (files: FileInfo[]) => {
		const failures: Array<{ path: string; error: unknown }> = []
		for (let i = 0; i < files.length; i += DOWNLOAD_CONCURRENCY) {
			const batch = files.slice(i, i + DOWNLOAD_CONCURRENCY)
			const results = await Promise.allSettled(batch.map((file) => downloadAndWriteBlob(did, rkey, file, pdsEndpoint)))
			for (let j = 0; j < results.length; j++) {
				const result = results[j]
				if (result?.status === 'rejected') {
					const file = batch[j]
					if (file) failures.push({ path: file.path, error: result.reason })
				}
			}
		}
		return failures
	}

	const deleteKeys = async (keys: string[]) => {
		const failures: Array<{ key: string; error: unknown }> = []
		for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
			const batch = keys.slice(i, i + DELETE_CONCURRENCY)
			const results = await Promise.allSettled(batch.map((key) => deleteFile(key)))
			for (let j = 0; j < results.length; j++) {
				const result = results[j]
				if (result?.status === 'rejected') {
					const key = batch[j]
					if (key) failures.push({ key, error: result.reason })
				}
			}
		}
		return failures
	}

	const keysToDelete: string[] = []
	for (const path of pathsToDelete) {
		keysToDelete.push(`${did}/${rkey}/${path}`)
		if (isHtmlContent(path)) {
			keysToDelete.push(`${did}/${rkey}/.rewritten/${path}`)
		}
	}

	// Incremental sync first
	const downloadFailures = await downloadFiles(filesToDownload)
	const deleteFailures = await deleteKeys(keysToDelete)

	const incrementalBackoffUntil = downloadFailures.reduce<number | null>((maxUntil, failure) => {
		const until = getBlobBackoffUntil(failure.error)
		if (!until) return maxUntil
		if (!maxUntil) return until
		return Math.max(maxUntil, until)
	}, null)
	const allIncrementalDownloadsBackoffed =
		downloadFailures.length > 0 && downloadFailures.every((failure) => getBlobBackoffUntil(failure.error) !== null)

	if (allIncrementalDownloadsBackoffed && deleteFailures.length === 0 && incrementalBackoffUntil) {
		logger.warn(`Incremental sync blocked by blob backoff for ${did}/${rkey}`, {
			did,
			rkey,
			downloadFailures: downloadFailures.length,
			backoffUntil: new Date(incrementalBackoffUntil).toISOString(),
		})
		throw new SiteBlobBackoffError(did, rkey, incrementalBackoffUntil, downloadFailures.length)
	}

	// Recovery path: retry only the files/keys that failed, keeping successful downloads intact
	if (downloadFailures.length > 0 || deleteFailures.length > 0) {
		logger.warn(`Incremental sync had failures for ${did}/${rkey}; retrying failed operations`, {
			did,
			rkey,
			downloadFailures: downloadFailures.length,
			deleteFailures: deleteFailures.length,
		})

		if (downloadFailures.length > 0) {
			const failedPaths = new Set(downloadFailures.map((f) => f.path))
			const failedFiles = filesToDownload.filter((f) => failedPaths.has(f.path))
			const retryDownloadFailures = await downloadFiles(failedFiles)

			if (retryDownloadFailures.length > 0) {
				const retryBackoffUntil = retryDownloadFailures.reduce<number | null>((maxUntil, failure) => {
					const until = getBlobBackoffUntil(failure.error)
					if (!until) return maxUntil
					if (!maxUntil) return until
					return Math.max(maxUntil, until)
				}, null)
				const allRetryBackoffed = retryDownloadFailures.every((failure) => getBlobBackoffUntil(failure.error) !== null)

				logger.error(`Retry of failed downloads failed for ${did}/${rkey}`, undefined, {
					did,
					rkey,
					retryDownloadFailures: retryDownloadFailures.length,
					sampleFailures: retryDownloadFailures.slice(0, 5).map((f) => ({
						path: f.path,
						error: f.error instanceof Error ? f.error.message : String(f.error),
					})),
				})

				if (!options?.skipInvalidation) {
					await publishCacheInvalidation(did, rkey, 'update', invalidationToken).catch(() => undefined)
				}

				if (allRetryBackoffed && retryBackoffUntil) {
					throw new SiteBlobBackoffError(did, rkey, retryBackoffUntil, retryDownloadFailures.length)
				}

				throw new Error(`Failed to download files for ${did}/${rkey}`)
			}
		}

		if (deleteFailures.length > 0) {
			const retryDeleteFailures = await deleteKeys(deleteFailures.map((f) => f.key))
			if (retryDeleteFailures.length > 0) {
				logger.error(`Retry of failed deletes failed for ${did}/${rkey}`, undefined, {
					did,
					rkey,
					retryDeleteFailures: retryDeleteFailures.length,
					sampleFailures: retryDeleteFailures.slice(0, 5).map((f) => ({
						key: f.key,
						error: f.error instanceof Error ? f.error.message : String(f.error),
					})),
				})
				if (!options?.skipInvalidation) {
					await publishCacheInvalidation(did, rkey, 'update', invalidationToken).catch(() => undefined)
				}
				throw new Error(`Failed to delete files for ${did}/${rkey}`)
			}
		}
	}

	// Update DB with new CIDs
	logger.debug(`About to upsert site cache for ${did}/${rkey}`)
	await upsertSiteCache(did, rkey, recordCid, newFileCids)
	await upsertSite(did, rkey, record.site)
	logger.debug(`Updated site cache for ${did}/${rkey} with record CID ${recordCid}`)

	// Backfill settings if a record exists for this rkey
	// Always skip settings invalidation here - the 'update' invalidation below
	// already clears everything including the settings cache on the hosting service
	const settingsRecord = await fetchSettingsRecord(did, rkey, pdsEndpoint)
	if (settingsRecord) {
		await handleSettingsUpdate(did, rkey, settingsRecord.record, settingsRecord.cid, {
			skipInvalidation: true,
		})
	}

	// Notify hosting-service to invalidate its local caches (including negative 404 cache)
	// (skip for backfill since it runs before the hosting-service serves traffic)
	if (!options?.skipInvalidation) {
		await publishCacheInvalidation(did, rkey, 'update', invalidationToken)
	}

	logger.info(`Successfully cached site ${did}/${rkey}`)
}

/**
 * Handle a site delete event
 */
export async function handleSiteDelete(did: string, rkey: string): Promise<void> {
	logger.info(`Deleting site ${did}/${rkey}`)

	// List all files for this site and delete them
	const prefix = `${did}/${rkey}/`
	const keys = await listFiles(prefix)

	for (const key of keys) {
		await deleteFile(key)
	}

	// Delete from DB
	await deleteSiteCache(did, rkey)
	await deleteSite(did, rkey)

	// Notify hosting-service to invalidate its local caches
	await publishCacheInvalidation(did, rkey, 'delete')

	logger.info(`Deleted site ${did}/${rkey} (${keys.length} files)`)
}

/**
 * Handle settings create/update event
 */
export async function handleSettingsUpdate(
	did: string,
	rkey: string,
	settings: WispSettings,
	recordCid: string,
	options?: { skipInvalidation?: boolean },
): Promise<void> {
	logger.info(`Updating settings for ${did}/${rkey}`)

	await upsertSiteSettingsCache(did, rkey, recordCid, {
		directoryListing: settings.directoryListing,
		spaMode: settings.spaMode,
		custom404: settings.custom404,
		indexFiles: settings.indexFiles,
		cleanUrls: settings.cleanUrls,
		headers: settings.headers,
	})

	// Notify hosting-service to invalidate its local caches (redirect rules depend on settings)
	if (!options?.skipInvalidation) {
		await publishCacheInvalidation(did, rkey, 'settings')
	}
}

/**
 * Handle settings delete event
 */
export async function handleSettingsDelete(did: string, rkey: string): Promise<void> {
	logger.info(`Deleting settings for ${did}/${rkey}`)
	await deleteSiteSettingsCache(did, rkey)

	// Notify hosting-service to invalidate its local caches
	await publishCacheInvalidation(did, rkey, 'settings')
}
