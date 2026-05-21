/**
 * On-demand site caching for the hosting service
 *
 * When a request hits a site that is completely missing (no DB entry, no files),
 * this module fetches the site record from the PDS, downloads all blobs,
 * writes them to local storage (hot + warm tiers), and updates the DB.
 *
 * This gives immediate serving capability. A revalidate is also enqueued
 * so the firehose-service backfills S3 (cold tier).
 */

import { gunzipSync } from 'node:zlib'
import { extractBlobCid, getPdsForDid } from '@wispplace/atproto-utils'
import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression'
import { MAX_BLOB_SIZE, MAX_FILE_COUNT, MAX_SITE_SIZE, MAX_SITE_SIZE_SUPPORTER } from '@wispplace/constants'
import { collectFileCidsFromEntries, countFilesInDirectory } from '@wispplace/fs-utils'
import type { Directory, Entry, File, Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { createLogger } from '@wispplace/observability'
import { safeFetchBlob, safeFetchJson } from '@wispplace/safe-fetch'
import { isSupporter, releaseLock, tryAcquireLock, upsertSiteCache } from './db'
import { enqueueRevalidate } from './revalidate-queue'
import { storage } from './storage'
import { expandSubfsNodes } from './utils'

const logger = createLogger('on-demand-cache')

// Track in-flight fetches to avoid duplicate work
const inFlightFetches = new Map<string, Promise<boolean>>()

interface FileInfo {
	path: string
	cid: string
	blob: any
	encoding?: 'gzip'
	mimeType?: string
	base64?: boolean
}

function formatUnknownError(err: unknown): Record<string, unknown> {
	if (err instanceof Error) {
		return {
			name: err.name,
			message: err.message,
			stack: err.stack,
		}
	}

	if (typeof err === 'object' && err !== null) {
		const value = err as Record<string, unknown>
		const out: Record<string, unknown> = {}

		for (const key of ['name', 'message', 'code', 'status', 'statusCode']) {
			if (value[key] !== undefined) out[key] = value[key]
		}

		try {
			out.raw = JSON.stringify(err)
		} catch {
			out.raw = String(err)
		}

		return out
	}

	return { message: String(err) }
}

/**
 * Attempt to fetch and cache a completely missing site on-demand.
 * Returns true if the site was successfully cached, false otherwise.
 *
 * Uses a distributed lock (pg advisory lock) to prevent multiple
 * hosting-service instances from fetching the same site simultaneously.
 */
export async function fetchAndCacheSite(did: string, rkey: string): Promise<boolean> {
	const key = `${did}:${rkey}`

	// Check if there's already an in-flight fetch for this site
	const existing = inFlightFetches.get(key)
	if (existing) {
		return existing
	}

	const fetchPromise = doFetchAndCache(did, rkey)
	inFlightFetches.set(key, fetchPromise)

	try {
		return await fetchPromise
	} finally {
		inFlightFetches.delete(key)
	}
}

async function doFetchAndCache(did: string, rkey: string): Promise<boolean> {
	// Unified per-site write-lock key, shared verbatim with the firehose-service
	// (siteWriteLockKey) so on-demand fetches mutually exclude with firehose
	// create/update/delete syncs and the revalidate worker.
	const lockKey = `site-write:${did}:${rkey}`

	// Try to acquire a distributed lock
	const acquired = await tryAcquireLock(lockKey)
	if (!acquired) {
		logger.debug('Lock not acquired, another instance is handling it', { did, rkey })
		return false
	}

	try {
		logger.info('Fetching missing site', { did, rkey })

		// Fetch site record from PDS
		const pdsEndpoint = await getPdsForDid(did)
		if (!pdsEndpoint) {
			logger.error('Could not resolve PDS', undefined, { did })
			return false
		}

		const recordUrl = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.fs&rkey=${encodeURIComponent(rkey)}`

		let data: any
		try {
			data = await safeFetchJson(recordUrl)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			if (msg.includes('HTTP 404') || msg.includes('Not Found')) {
				logger.info('Site record not found on PDS', { did, rkey })
			} else {
				logger.error('Failed to fetch site record', undefined, { did, rkey, error: msg })
			}
			return false
		}

		const record = data.value as WispFsRecord
		const recordCid = data.cid || ''

		if (!record?.root?.entries) {
			logger.error('Invalid record structure', undefined, { did, rkey })
			return false
		}

		// Expand subfs nodes
		const expandedRoot = await expandSubfsNodes(record.root, pdsEndpoint)

		// Validate limits
		const fileCount = countFilesInDirectory(expandedRoot)
		if (fileCount > MAX_FILE_COUNT) {
			logger.error('Site exceeds file limit', undefined, { did, rkey, fileCount, maxFileCount: MAX_FILE_COUNT })
			return false
		}

		const totalSize = calculateTotalBlobSize(expandedRoot)
		const sizeLimit = (await isSupporter(did)) ? MAX_SITE_SIZE_SUPPORTER : MAX_SITE_SIZE
		if (totalSize > sizeLimit) {
			logger.error('Site exceeds size limit', undefined, { did, rkey, totalSize, sizeLimit })
			return false
		}

		// Collect files
		const files = collectFileInfo(expandedRoot.entries)

		// Collect file CIDs for DB
		const fileCids: Record<string, string> = {}
		collectFileCidsFromEntries(expandedRoot.entries, '', fileCids)

		// Download and write all files to local storage (hot + warm tiers)
		const CONCURRENCY = 10
		let downloaded = 0
		let failed = 0

		for (let i = 0; i < files.length; i += CONCURRENCY) {
			const batch = files.slice(i, i + CONCURRENCY)
			const results = await Promise.allSettled(batch.map((file) => downloadAndWriteBlob(did, rkey, file, pdsEndpoint)))

			results.forEach((result, idx) => {
				const file = batch[idx]
				if (result.status === 'fulfilled') {
					downloaded++
				} else {
					failed++
					logger.error('Failed to download blob', undefined, {
						did,
						rkey,
						filePath: file?.path,
						cid: file?.cid,
						error: formatUnknownError(result.reason),
					})
				}
			})
		}

		logger.info('Downloaded files', { did, rkey, downloaded, failed })
		// cold_synced=false: we only populated hot/warm here, never S3. The firehose
		// must treat S3 as not-yet-synced and do a full download (see revalidate below).
		await upsertSiteCache(did, rkey, recordCid, fileCids, false)

		// Enqueue revalidate so firehose-service backfills S3 (cold tier)
		await enqueueRevalidate(did, rkey, `storage-miss:on-demand`)

		logger.info('Successfully cached site', { did, rkey, downloaded })
		return downloaded > 0
	} catch (err) {
		logger.error('Error caching site', err, { did, rkey })
		return false
	} finally {
		await releaseLock(lockKey)
	}
}

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

async function downloadAndWriteBlob(did: string, rkey: string, file: FileInfo, pdsEndpoint: string): Promise<void> {
	const blobUrl = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(file.cid)}`

	let content = await safeFetchBlob(blobUrl, { maxSize: MAX_BLOB_SIZE, timeout: 300000 })
	let encoding = file.encoding

	// Decode base64 if flagged
	if (file.base64) {
		const base64String = new TextDecoder().decode(content)
		content = Buffer.from(base64String, 'base64')
	} else if (isTextLikeMime(file.mimeType, file.path)) {
		// Heuristic fallback: some records omit base64 flag but content is base64 text
		const decoded = tryDecodeBase64(content)
		if (decoded) {
			logger.warn(`Decoded base64 fallback for ${file.path} (base64 flag missing)`, { did, rkey })
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
			logger.warn(`Failed to decompress ${file.path}, storing gzipped`, { did, rkey, error })
		}
	} else if (encoding === 'gzip' && content.length >= 2 && !(content[0] === 0x1f && content[1] === 0x8b)) {
		// If marked gzip but doesn't look gzipped, attempt base64 decode and retry
		const decoded = tryDecodeBase64(content)
		if (decoded && decoded.length >= 2 && decoded[0] === 0x1f && decoded[1] === 0x8b) {
			logger.warn(`Decoded base64+gzip fallback for ${file.path}`, { did, rkey })
			try {
				content = gunzipSync(decoded)
				encoding = undefined
			} catch (error) {
				logger.warn(`Failed to decompress base64+gzip fallback for ${file.path}, storing gzipped`, { did, rkey, error })
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

	// Build storage key and metadata
	const key = `${did}/${rkey}/${file.path}`
	const metadata: Record<string, string> = {}
	if (encoding) metadata.encoding = encoding
	if (file.mimeType) metadata.mimeType = file.mimeType

	// Write to hot + warm tiers only (cold/S3 is read-only in hosting-service,
	// firehose-service will backfill via revalidate)
	await storage.set(key as any, content as any, {
		metadata,
		skipTiers: [],
	})
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
		if (byte === 0x0a || byte === 0x0d || byte === 0x20 || byte === 0x09) {
			continue
		}
		nonWhitespace++
		const isBase64Char =
			(byte >= 0x41 && byte <= 0x5a) || // A-Z
			(byte >= 0x61 && byte <= 0x7a) || // a-z
			(byte >= 0x30 && byte <= 0x39) || // 0-9
			byte === 0x2b || // +
			byte === 0x2f || // /
			byte === 0x3d // =
		if (!isBase64Char) return false
	}
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
