/**
 * Core file serving logic for the hosting service
 * Handles file retrieval, caching, redirects, and HTML rewriting
 */

import { gunzipSync, gzipSync } from 'node:zlib'
import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression'
import { normalizeFileCids } from '@wispplace/fs-utils'
import { isHtmlContent, rewriteHtmlPaths } from '@wispplace/fs-utils/html-rewriter'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import { createLogger } from '@wispplace/observability'
import type { StorageResult } from '@wispplace/tiered-storage'
import { lookup } from 'mime-types'
import { isSiteUpdating } from './cache-invalidation'
import { cache } from './cache-manager'
import { getSiteCache } from './db'
import { triggerSiteHtmlHotCacheWarmup } from './html-prewarm'
import { fetchAndCacheSite } from './on-demand-cache'
import { generate404Page, generateDirectoryListing, siteUpdatingResponse } from './page-generators'
import { loadRedirectRules, matchRedirectRule, parseCookies, parseQueryString } from './redirects'
import { applyCustomHeaders, getIndexFiles } from './request-utils'
import { recordStorageMiss } from './revalidate-metrics'
import { enqueueRevalidate } from './revalidate-queue'
import { storage } from './storage'
import { createTrace, logTrace, type RequestTrace, span } from './trace'
import { getCachedSettings } from './utils'

const logger = createLogger('file-serving')
const STANDARD_CACHE_CONTROL = 'public, max-age=600'
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const IMMUTABLE_EXTENSIONS = new Set([
	'css',
	'gif',
	'ico',
	'jpeg',
	'jpg',
	'js',
	'json',
	'map',
	'mjs',
	'otf',
	'png',
	'svg',
	'ttf',
	'wasm',
	'webp',
	'woff',
	'woff2',
])

type FileStorageResult = StorageResult<Uint8Array>
type FileForRequestResult = { result: FileStorageResult; filePath: string; wasRewritten: boolean }

/**
 * Check if the last segment of a path looks like it has a file extension.
 * e.g. "style.css" → true, "about" → false, "wisp-cli-x86_64-linux" → false,
 *      "dir.name/file" → false, "dir/file.tar.gz" → true
 */
export function hasFileExtension(path: string): boolean {
	const basename = path.split('/').pop() || ''
	return /\.[a-zA-Z0-9]+$/.test(basename)
}

function getFinalExtension(path: string): string {
	const basename = path.split('/').pop() || ''
	const match = /\.([a-zA-Z0-9]+)$/.exec(basename)
	return match?.[1]?.toLowerCase() ?? ''
}

function stripFinalExtension(path: string): string {
	const basename = (path.split('/').pop() || '').replace(/\.map$/i, '')
	return basename.replace(/\.[a-zA-Z0-9]+$/, '')
}

function hasFingerprintSuffix(path: string): boolean {
	const stem = stripFinalExtension(path)
	return /(?:^|[-.])[a-zA-Z0-9_-]{8,}$/.test(stem)
}

export function getCacheControlForPath(filePath: string): string {
	if (IMMUTABLE_EXTENSIONS.has(getFinalExtension(filePath)) && hasFingerprintSuffix(filePath)) {
		return IMMUTABLE_CACHE_CONTROL
	}

	return STANDARD_CACHE_CONTROL
}

/**
 * Helper to retrieve a file with metadata from tiered storage
 * Logs which tier the file was served from
 */
async function getFileWithMetadata(did: string, rkey: string, filePath: string) {
	const key = `${did}/${rkey}/${filePath}`
	const result = await storage.getWithMetadata(key)

	if (result) {
		const tier = result.source || 'unknown'
		const size = result.data ? (result.data as Uint8Array).length : 0
		logger.debug(`Served ${filePath} from ${tier} tier`, { did, rkey, size, tier })
	}

	return result
}

function buildStorageKey(did: string, rkey: string, filePath: string): string {
	const normalized = filePath.startsWith('/') ? filePath.slice(1) : filePath
	return `${did}/${rkey}/${normalized}`
}

function normalizeFilePath(filePath: string): string {
	return filePath.startsWith('/') ? filePath.slice(1) : filePath
}

function manifestHasPath(fileCids: Record<string, string> | null, filePath: string): boolean {
	return fileCids === null || fileCids[normalizeFilePath(filePath)] !== undefined
}

/**
 * Fetch a per-site fallback file (SPA, custom 404, auto-detected 404 pages),
 * caching null results so repeated 404 responses don't re-hit S3 for files
 * that don't exist on the site.
 */
async function getFallbackFile(
	did: string,
	rkey: string,
	filePath: string,
	trace?: RequestTrace | null,
): Promise<FileStorageResult | null> {
	const cacheKey = `${did}:${rkey}:${filePath}`
	// null in the cache means we've confirmed this file doesn't exist
	const negativeCached = cache.get<null>('siteFiles', cacheKey)
	if (negativeCached === null) return null

	const result = await span(trace, `storage:${filePath}`, () => getFileWithMetadata(did, rkey, filePath))
	if (result === null) {
		cache.set('siteFiles', cacheKey, null)
	}
	return result
}

/**
 * Same as getFallbackFile but prefers pre-rewritten HTML (for the WithRewrite path).
 */
async function getFallbackFileForRequest(
	did: string,
	rkey: string,
	filePath: string,
	trace?: RequestTrace | null,
): Promise<FileForRequestResult | null> {
	const cacheKey = `${did}:${rkey}:${filePath}`
	const negativeCached = cache.get<null>('siteFiles', cacheKey)
	if (negativeCached === null) return null

	const result = await span(trace, `storage:${filePath}`, () => getFileForRequest(did, rkey, filePath, true))
	if (result === null) {
		cache.set('siteFiles', cacheKey, null)
	}
	return result
}

async function getExpectedFileCidsForSite(
	did: string,
	rkey: string,
	trace?: RequestTrace | null,
): Promise<Record<string, string> | null> {
	const siteCache = await span(trace, 'db:siteCache', () => getSiteCache(did, rkey))
	if (!siteCache) return null
	return normalizeFileCids(siteCache.file_cids).value
}

function shouldServeUpdatingPage(requestHeaders?: Record<string, string>): boolean {
	const accept = (requestHeaders?.accept ?? '').toLowerCase()
	if (accept.includes('text/html') || accept.includes('application/xhtml+xml')) {
		return true
	}

	const fetchDest = (requestHeaders?.['sec-fetch-dest'] ?? '').toLowerCase()
	return fetchDest === 'document' || fetchDest === 'iframe' || fetchDest === 'frame'
}

function buildStorageMissResponse(requestHeaders?: Record<string, string>): Response {
	if (shouldServeUpdatingPage(requestHeaders)) {
		return siteUpdatingResponse()
	}

	return new Response('Storage temporarily unavailable', {
		status: 503,
		headers: {
			'Cache-Control': 'no-store',
			'Retry-After': '5',
		},
	})
}

async function listDirectoryEntries(
	did: string,
	rkey: string,
	requestPath: string,
	manifestPaths?: string[] | null,
): Promise<Array<{ name: string; isDirectory: boolean }>> {
	const entries = new Map<string, boolean>()

	if (manifestPaths != null) {
		// Use the DB manifest — no disk or S3 I/O
		const prefix = requestPath ? `${requestPath}/` : ''
		for (const filePath of manifestPaths) {
			if (prefix && !filePath.startsWith(prefix)) continue
			const relative = prefix ? filePath.slice(prefix.length) : filePath
			if (!relative) continue
			if (relative.startsWith('.rewritten/')) continue

			const [name, ...rest] = relative.split('/')
			if (!name || name === '.metadata.json' || name.endsWith('.meta')) continue

			const isDirectory = rest.length > 0
			const existing = entries.get(name)
			if (existing === undefined || (isDirectory && !existing)) {
				entries.set(name, isDirectory)
			}
		}
	} else {
		// Fallback: list from storage (only reached when site not yet in DB)
		const prefix = buildStorageKey(did, rkey, requestPath ? `${requestPath}/` : '')
		for await (const key of storage.listKeys(prefix)) {
			const relative = key.slice(prefix.length)
			if (!relative) continue
			if (relative.startsWith('.rewritten/')) continue

			const [name, ...rest] = relative.split('/')
			if (!name || name === '.metadata.json' || name.endsWith('.meta')) continue

			const isDirectory = rest.length > 0
			const existing = entries.get(name)
			if (existing === undefined || (isDirectory && !existing)) {
				entries.set(name, isDirectory)
			}
		}
	}

	return Array.from(entries.entries()).map(([name, isDirectory]) => ({ name, isDirectory }))
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

	const fileCids = await getExpectedFileCidsForSite(did, rkey, trace)
	if (fileCids !== null) {
		return manifestHasPath(fileCids, checkPath)
	}

	const fileInStorage = await span(trace, `storage:${checkPath}`, () => getFileWithMetadata(did, rkey, checkPath))
	return fileInStorage !== null
}

async function getFileForRequest(
	did: string,
	rkey: string,
	filePath: string,
	preferRewrittenHtml: boolean,
): Promise<FileForRequestResult | null> {
	const mimeTypeGuess = lookup(filePath) || 'application/octet-stream'
	if (preferRewrittenHtml && isHtmlContent(filePath, mimeTypeGuess)) {
		const rewrittenPath = `.rewritten/${filePath}`
		const rewritten = await getFileWithMetadata(did, rkey, rewrittenPath)
		if (rewritten) {
			return { result: rewritten, filePath, wasRewritten: true }
		}
	}

	const result = await getFileWithMetadata(did, rkey, filePath)
	if (!result) return null
	return { result, filePath, wasRewritten: false }
}

function buildResponseFromStorageResult(
	result: FileStorageResult,
	filePath: string,
	settings: WispSettings | null,
	requestHeaders?: Record<string, string>,
): Response {
	const content = Buffer.from(result.data)
	const meta = result.metadata.customMetadata as { encoding?: string; mimeType?: string } | undefined
	const mimeType = meta?.mimeType || lookup(filePath) || 'application/octet-stream'
	const cacheControl = getCacheControlForPath(filePath)
	const etag = result.metadata.checksum ? `"${result.metadata.checksum}"` : undefined

	// Handle conditional requests (If-None-Match → 304 Not Modified)
	if (etag && requestHeaders?.['if-none-match']) {
		const ifNoneMatch = requestHeaders['if-none-match']
		const matches =
			ifNoneMatch === '*' ||
			ifNoneMatch
				.split(',')
				.map((e) => e.trim())
				.includes(etag)
		if (matches) {
			return new Response(null, {
				status: 304,
				headers: { ETag: etag, 'Cache-Control': cacheControl },
			})
		}
	}

	const headers: Record<string, string> = {
		'Content-Type': mimeType,
		'Cache-Control': cacheControl,
		'X-Cache-Tier': result.source,
	}

	if (etag) {
		headers.ETag = etag
	}

	if (meta?.encoding === 'gzip') {
		const shouldServeCompressed = shouldCompressMimeType(mimeType)
		const acceptEncoding = requestHeaders?.['accept-encoding'] ?? ''
		const clientAcceptsGzip = acceptEncoding.includes('gzip')
		const hasGzipMagic = content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b

		if (!clientAcceptsGzip || !shouldServeCompressed) {
			if (hasGzipMagic) {
				const decompressed = gunzipSync(content)
				applyCustomHeaders(headers, filePath, settings)
				return new Response(decompressed, { headers })
			}
			logger.warn(`File marked as gzipped but lacks magic bytes, serving as-is`, { filePath })
			applyCustomHeaders(headers, filePath, settings)
			return new Response(content, { headers })
		}

		headers['Content-Encoding'] = 'gzip'
	}

	applyCustomHeaders(headers, filePath, settings)
	return new Response(content, { headers })
}

async function buildRewrittenHtmlResponse(
	result: FileStorageResult,
	filePath: string,
	basePath: string,
	settings: WispSettings | null,
	requestHeaders?: Record<string, string>,
): Promise<Response> {
	try {
		const content = Buffer.from(result.data)
		const meta = result.metadata.customMetadata as { encoding?: string; mimeType?: string } | undefined
		const mimeType = meta?.mimeType || lookup(filePath) || 'application/octet-stream'
		const cacheControl = getCacheControlForPath(filePath)

		const headers: Record<string, string> = {
			'Content-Type': mimeType,
			'Cache-Control': cacheControl,
			'X-Cache-Tier': result.source,
		}

		const hasGzipMagic = content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b
		let decoded = content
		if (meta?.encoding === 'gzip') {
			if (hasGzipMagic) {
				decoded = gunzipSync(content)
			} else {
				logger.warn(`File marked as gzipped but lacks magic bytes, serving original`, { filePath })
				applyCustomHeaders(headers, filePath, settings)
				return new Response(content, { headers })
			}
		} else if (hasGzipMagic && shouldCompressMimeType(mimeType)) {
			// Heuristic: treat as gzipped text content even if encoding metadata is missing
			decoded = gunzipSync(content)
		}

		const htmlString = new TextDecoder().decode(decoded)
		const rewritten = await rewriteHtmlPaths(htmlString, basePath)
		let output = new TextEncoder().encode(rewritten)

		const shouldServeCompressed = shouldCompressMimeType(mimeType)
		const acceptEncoding = requestHeaders?.['accept-encoding'] ?? ''
		const clientAcceptsGzip = acceptEncoding.includes('gzip')
		if (clientAcceptsGzip && shouldServeCompressed) {
			output = gzipSync(output)
			headers['Content-Encoding'] = 'gzip'
		}

		applyCustomHeaders(headers, filePath, settings)
		return new Response(output, { headers })
	} catch (err) {
		logger.warn('Failed to rewrite HTML on demand, serving original', { filePath, error: err })
		return buildResponseFromStorageResult(result, filePath, settings, requestHeaders)
	}
}

/**
 * Helper to serve files from cache (for custom domains and subdomains)
 */
export async function serveFromCache(
	did: string,
	rkey: string,
	filePath: string,
	fullUrl?: string,
	headers?: Record<string, string>,
): Promise<Response> {
	if (isSiteUpdating(did, rkey)) {
		return shouldServeUpdatingPage(headers)
			? siteUpdatingResponse()
			: new Response('Site is updating', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } })
	}

	const trace = createTrace()

	// Only prewarm sites that are known to exist. Public routes can otherwise
	// choose arbitrary site keys and force expensive storage-wide list operations.
	const siteFileCids = await getExpectedFileCidsForSite(did, rkey, trace)
	if (siteFileCids !== null) {
		triggerSiteHtmlHotCacheWarmup(did, rkey)
	}

	// Load settings for this site
	const settings = await span(trace, 'db:settings', () => getCachedSettings(did, rkey))
	const indexFiles = getIndexFiles(settings)

	// Check for redirect rules first (_redirects wins over settings)
	const redirectRules = await cache.getOrFetch('redirectRules', `${did}:${rkey}`, () =>
		span(trace, 'storage:redirectRules', () => loadRedirectRules(did, rkey)),
	)

	// Apply redirect rules if any exist
	if (redirectRules.length > 0) {
		const requestPath = `/${filePath || ''}`
		const queryParams = fullUrl ? parseQueryString(fullUrl) : {}
		const cookies = parseCookies(headers?.cookie)

		const redirectMatch = matchRedirectRule(requestPath, redirectRules, {
			queryParams,
			headers,
			cookies,
		})

		if (redirectMatch) {
			const { rule, targetPath, status } = redirectMatch

			// If not forced, check if the requested file exists before redirecting
			if (!rule.force) {
				// If file exists and redirect is not forced, serve the file normally
				if (await hasFileForNonForcedRedirect(did, rkey, filePath, indexFiles, trace)) {
					const response = await serveFileInternal(did, rkey, filePath, settings, headers, trace)
					logTrace(trace, filePath || '/', logger)
					return response
				}
			}

			// Handle different status codes
			if (status === 200) {
				// Rewrite: serve different content but keep URL the same
				// Remove leading slash for internal path resolution
				const rewritePath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath
				const response = await serveFileInternal(did, rkey, rewritePath, settings, headers, trace)
				logTrace(trace, filePath || '/', logger)
				return response
			} else if (status === 301 || status === 302) {
				// External redirect: change the URL
				logTrace(trace, filePath || '/', logger)
				return new Response(null, {
					status,
					headers: {
						Location: targetPath,
						'Cache-Control': STANDARD_CACHE_CONTROL,
					},
				})
			} else if (status === 404) {
				// Custom 404 page from _redirects (wins over settings.custom404)
				const custom404Path = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath
				const response = await serveFileInternal(did, rkey, custom404Path, settings, headers, trace)
				logTrace(trace, filePath || '/', logger)
				// Override status to 404
				return new Response(response.body, {
					status: 404,
					headers: response.headers,
				})
			}
		}
	}

	// No redirect matched, serve normally with settings
	const response = await serveFileInternal(did, rkey, filePath, settings, headers, trace)
	logTrace(trace, filePath || '/', logger)
	return response
}

/**
 * Internal function to serve a file (used by both normal serving and rewrites)
 */
export async function serveFileInternal(
	did: string,
	rkey: string,
	filePath: string,
	settings: WispSettings | null = null,
	requestHeaders?: Record<string, string>,
	trace?: RequestTrace | null,
): Promise<Response> {
	let expectedFileCids: Record<string, string> | null | undefined
	let expectedMissPath: string | null = null

	const getExpectedFileCids = async (): Promise<Record<string, string> | null> => {
		if (expectedFileCids !== undefined) return expectedFileCids
		expectedFileCids = await getExpectedFileCidsForSite(did, rkey, trace)
		return expectedFileCids
	}

	const getExpectedFileWithMetadata = async (path: string): Promise<FileStorageResult | null> => {
		const fileCids = await getExpectedFileCids()
		if (!manifestHasPath(fileCids, path)) return null
		return await span(trace, `storage:${path}`, () => getFileWithMetadata(did, rkey, path))
	}

	const markExpectedMiss = async (path: string) => {
		if (expectedMissPath) return
		const fileCids = await getExpectedFileCids()
		if (!fileCids) return
		const normalized = path.startsWith('/') ? path.slice(1) : path
		if (fileCids[normalized]) {
			expectedMissPath = normalized
		}
	}

	const maybeReturnStorageMiss = async (): Promise<Response | null> => {
		if (!expectedMissPath) return null
		recordStorageMiss(expectedMissPath)
		await enqueueRevalidate(did, rkey, `storage-miss:${expectedMissPath}`)
		return buildStorageMissResponse(requestHeaders)
	}

	const indexFiles = getIndexFiles(settings)
	const isDirectoryPathRequest = filePath.endsWith('/') && filePath.length > 0

	// Normalize the request path (keep empty for root, remove trailing slash for others)
	let requestPath = filePath || ''
	if (requestPath.endsWith('/') && requestPath.length > 1) {
		requestPath = requestPath.slice(0, -1)
	}

	// For directory-like paths (empty or no file extension in basename), try index files
	if (!requestPath || !hasFileExtension(requestPath)) {
		// For non-empty extensionless paths, try as a direct file first (e.g. binary downloads)
		if (requestPath && !isDirectoryPathRequest) {
			const directResult = await getExpectedFileWithMetadata(requestPath)
			if (directResult) {
				return buildResponseFromStorageResult(directResult, requestPath, settings, requestHeaders)
			}
			await markExpectedMiss(requestPath)
		}

		for (const indexFile of indexFiles) {
			const indexPath = requestPath ? `${requestPath}/${indexFile}` : indexFile
			const result = await getExpectedFileWithMetadata(indexPath)
			if (result) {
				return buildResponseFromStorageResult(result, indexPath, settings, requestHeaders)
			}
			await markExpectedMiss(indexPath)
		}

		// Index not found - check if we need directory listing
		if (settings?.directoryListing) {
			const fileCids = await getExpectedFileCids()
			const directoryEntries = await listDirectoryEntries(
				did,
				rkey,
				requestPath,
				fileCids ? Object.keys(fileCids) : null,
			)
			if (directoryEntries.length > 0) {
				const missResponse = await maybeReturnStorageMiss()
				if (missResponse) return missResponse
				const html = generateDirectoryListing(requestPath, directoryEntries)
				return new Response(html, {
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': STANDARD_CACHE_CONTROL,
					},
				})
			}
		}
		// Fall through to normal file serving / 404 handling
	}

	// Try to serve as a file
	const fileRequestPath: string = requestPath || indexFiles[0] || 'index.html'

	// Retrieve from tiered storage
	const result = await getExpectedFileWithMetadata(fileRequestPath)

	if (result) {
		return buildResponseFromStorageResult(result, fileRequestPath, settings, requestHeaders)
	}
	await markExpectedMiss(fileRequestPath)

	// Try index files for directory-like paths (even with extensions,
	// e.g. Astro emits `relay.md/index.html` for .md routes)
	for (const indexFileName of indexFiles) {
		const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName
		const indexResult = await getExpectedFileWithMetadata(indexPath)
		if (indexResult) {
			return buildResponseFromStorageResult(indexResult, indexPath, settings, requestHeaders)
		}
		await markExpectedMiss(indexPath)
	}

	// Try clean URLs: /about -> /about.html
	if (settings?.cleanUrls && !hasFileExtension(fileRequestPath)) {
		const htmlPath = `${fileRequestPath}.html`
		const htmlResult = await getExpectedFileWithMetadata(htmlPath)
		if (htmlResult) {
			return buildResponseFromStorageResult(htmlResult, htmlPath, settings, requestHeaders)
		}
		await markExpectedMiss(htmlPath)

		// Also try /about/index.html
		for (const indexFileName of indexFiles) {
			const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName
			const indexResult = await getExpectedFileWithMetadata(indexPath)
			if (indexResult) {
				return buildResponseFromStorageResult(indexResult, indexPath, settings, requestHeaders)
			}
			await markExpectedMiss(indexPath)
		}
	}

	// SPA mode: serve SPA file for all non-existing routes (wins over custom404 but loses to _redirects)
	if (settings?.spaMode) {
		const spaFile = settings.spaMode
		const spaResult = await getFallbackFile(did, rkey, spaFile, trace)
		if (spaResult) {
			return buildResponseFromStorageResult(spaResult, spaFile, settings, requestHeaders)
		}
		await markExpectedMiss(spaFile)
	}

	// Custom 404: serve custom 404 file if configured (wins conflict battle)
	if (settings?.custom404) {
		const custom404File = settings.custom404
		const custom404Result = await getFallbackFile(did, rkey, custom404File, trace)
		if (custom404Result) {
			const response = buildResponseFromStorageResult(custom404Result, custom404File, settings, requestHeaders)
			return new Response(response.body, { status: 404, headers: response.headers })
		}
		await markExpectedMiss(custom404File)
	}

	// Autodetect 404 pages (GitHub Pages: 404.html, Neocities/Nekoweb: not_found.html)
	for (const auto404Page of ['404.html', 'not_found.html']) {
		const auto404Result = await getFallbackFile(did, rkey, auto404Page, trace)
		if (auto404Result) {
			const response = buildResponseFromStorageResult(auto404Result, auto404Page, settings, requestHeaders)
			return new Response(response.body, { status: 404, headers: response.headers })
		}
		await markExpectedMiss(auto404Page)
	}

	// Directory listing fallback: if enabled, show root directory listing on 404
	if (settings?.directoryListing) {
		const fileCids = await getExpectedFileCids()
		const rootEntries = await listDirectoryEntries(did, rkey, '', fileCids ? Object.keys(fileCids) : null)
		if (rootEntries.length > 0) {
			const missResponse = await maybeReturnStorageMiss()
			if (missResponse) return missResponse
			const html = generateDirectoryListing('', rootEntries)
			return new Response(html, {
				status: 404,
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': STANDARD_CACHE_CONTROL,
				},
			})
		}
	}

	const missResponse = await maybeReturnStorageMiss()
	if (missResponse) return missResponse

	// Last resort: if site not in DB at all, try on-demand fetch
	const fileCids = await getExpectedFileCids()
	if (fileCids === null) {
		logger.info(`Site not found in DB, attempting on-demand fetch before 404`, { did, rkey })
		const success = await fetchAndCacheSite(did, rkey)
		if (success) {
			// Retry serving the originally requested file
			const retryPath = filePath || indexFiles[0] || 'index.html'
			const retryResult = await span(trace, `storage:${retryPath}`, () => getFileWithMetadata(did, rkey, retryPath))
			if (retryResult) {
				return buildResponseFromStorageResult(retryResult, retryPath, settings, requestHeaders)
			}
		}
	}

	// Default styled 404 page
	const html = generate404Page()
	return new Response(html, {
		status: 404,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': STANDARD_CACHE_CONTROL,
		},
	})
}

/**
 * Helper to serve files from cache with HTML path rewriting for sites.wisp.place routes
 */
export async function serveFromCacheWithRewrite(
	did: string,
	rkey: string,
	filePath: string,
	basePath: string,
	fullUrl?: string,
	headers?: Record<string, string>,
): Promise<Response> {
	if (isSiteUpdating(did, rkey)) {
		return shouldServeUpdatingPage(headers)
			? siteUpdatingResponse()
			: new Response('Site is updating', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } })
	}

	const trace = createTrace()

	// Only prewarm sites that are known to exist. Public routes can otherwise
	// choose arbitrary site keys and force expensive storage-wide list operations.
	const siteFileCids = await getExpectedFileCidsForSite(did, rkey, trace)
	if (siteFileCids !== null) {
		triggerSiteHtmlHotCacheWarmup(did, rkey)
	}

	// Load settings for this site
	const settings = await span(trace, 'db:settings', () => getCachedSettings(did, rkey))
	const indexFiles = getIndexFiles(settings)

	// Check for redirect rules first (_redirects wins over settings)
	const redirectRules = await cache.getOrFetch('redirectRules', `${did}:${rkey}`, () =>
		span(trace, 'storage:redirectRules', () => loadRedirectRules(did, rkey)),
	)

	// Apply redirect rules if any exist
	if (redirectRules.length > 0) {
		const requestPath = `/${filePath || ''}`
		const queryParams = fullUrl ? parseQueryString(fullUrl) : {}
		const cookies = parseCookies(headers?.cookie)

		const redirectMatch = matchRedirectRule(requestPath, redirectRules, {
			queryParams,
			headers,
			cookies,
		})

		if (redirectMatch) {
			const { rule, targetPath, status } = redirectMatch

			// If not forced, check if the requested file exists before redirecting
			if (!rule.force) {
				// If file exists and redirect is not forced, serve the file normally
				if (await hasFileForNonForcedRedirect(did, rkey, filePath, indexFiles, trace)) {
					const response = await serveFileInternalWithRewrite(did, rkey, filePath, basePath, settings, headers, trace)
					logTrace(trace, filePath || '/', logger)
					return response
				}
			}

			// Handle different status codes
			if (status === 200) {
				// Rewrite: serve different content but keep URL the same
				const rewritePath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath
				const response = await serveFileInternalWithRewrite(did, rkey, rewritePath, basePath, settings, headers, trace)
				logTrace(trace, filePath || '/', logger)
				return response
			} else if (status === 301 || status === 302) {
				// External redirect: change the URL
				// For sites.wisp.place, we need to adjust the target path to include the base path
				// unless it's an absolute URL
				let redirectTarget = targetPath
				if (!targetPath.startsWith('http://') && !targetPath.startsWith('https://')) {
					redirectTarget = basePath + (targetPath.startsWith('/') ? targetPath.slice(1) : targetPath)
				}
				logTrace(trace, filePath || '/', logger)
				return new Response(null, {
					status,
					headers: {
						Location: redirectTarget,
						'Cache-Control': STANDARD_CACHE_CONTROL,
					},
				})
			} else if (status === 404) {
				// Custom 404 page from _redirects (wins over settings.custom404)
				const custom404Path = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath
				const response = await serveFileInternalWithRewrite(
					did,
					rkey,
					custom404Path,
					basePath,
					settings,
					headers,
					trace,
				)
				logTrace(trace, filePath || '/', logger)
				// Override status to 404
				return new Response(response.body, {
					status: 404,
					headers: response.headers,
				})
			}
		}
	}

	// No redirect matched, serve normally with settings
	const response = await serveFileInternalWithRewrite(did, rkey, filePath, basePath, settings, headers, trace)
	logTrace(trace, filePath || '/', logger)
	return response
}

/**
 * Internal function to serve a file with rewriting
 */
export async function serveFileInternalWithRewrite(
	did: string,
	rkey: string,
	filePath: string,
	basePath: string,
	settings: WispSettings | null = null,
	requestHeaders?: Record<string, string>,
	trace?: RequestTrace | null,
): Promise<Response> {
	let expectedFileCids: Record<string, string> | null | undefined
	let expectedMissPath: string | null = null

	const getExpectedFileCids = async (): Promise<Record<string, string> | null> => {
		if (expectedFileCids !== undefined) return expectedFileCids
		expectedFileCids = await getExpectedFileCidsForSite(did, rkey, trace)
		return expectedFileCids
	}

	const getExpectedFileForRequest = async (path: string): Promise<FileForRequestResult | null> => {
		const fileCids = await getExpectedFileCids()
		const rewrittenPath = `.rewritten/${normalizeFilePath(path)}`
		if (!manifestHasPath(fileCids, path) && !manifestHasPath(fileCids, rewrittenPath)) return null
		return await span(trace, `storage:${path}`, () => getFileForRequest(did, rkey, path, true))
	}

	const markExpectedMiss = async (path: string) => {
		if (expectedMissPath) return
		const fileCids = await getExpectedFileCids()
		if (!fileCids) return
		const normalized = path.startsWith('/') ? path.slice(1) : path
		if (fileCids[normalized]) {
			expectedMissPath = normalized
		}
	}

	const maybeReturnStorageMiss = async (): Promise<Response | null> => {
		if (!expectedMissPath) return null
		recordStorageMiss(expectedMissPath)
		await enqueueRevalidate(did, rkey, `storage-miss:${expectedMissPath}`)
		return buildStorageMissResponse()
	}

	const indexFiles = getIndexFiles(settings)
	const isDirectoryPathRequest = filePath.endsWith('/') && filePath.length > 0
	const buildResponse = async (fileResult: FileForRequestResult): Promise<Response> => {
		const meta = fileResult.result.metadata.customMetadata as { encoding?: string; mimeType?: string } | undefined
		const mimeType = meta?.mimeType || lookup(fileResult.filePath) || 'application/octet-stream'
		const needsRewrite = !fileResult.wasRewritten && isHtmlContent(fileResult.filePath, mimeType)

		if (needsRewrite) {
			void enqueueRevalidate(did, rkey, `rewrite-miss:${fileResult.filePath}`)
			return await buildRewrittenHtmlResponse(
				fileResult.result,
				fileResult.filePath,
				basePath,
				settings,
				requestHeaders,
			)
		}

		return buildResponseFromStorageResult(fileResult.result, fileResult.filePath, settings, requestHeaders)
	}

	// Normalize the request path (keep empty for root, remove trailing slash for others)
	let requestPath = filePath || ''
	if (requestPath.endsWith('/') && requestPath.length > 1) {
		requestPath = requestPath.slice(0, -1)
	}

	// For directory-like paths (empty or no file extension in basename), try index files
	if (!requestPath || !hasFileExtension(requestPath)) {
		// For non-empty extensionless paths, try as a direct file first (e.g. binary downloads)
		if (requestPath && !isDirectoryPathRequest) {
			const directResult = await getExpectedFileForRequest(requestPath)
			if (directResult) {
				return await buildResponse(directResult)
			}
			await markExpectedMiss(requestPath)
		}

		for (const indexFile of indexFiles) {
			const indexPath = requestPath ? `${requestPath}/${indexFile}` : indexFile
			const fileResult = await getExpectedFileForRequest(indexPath)
			if (fileResult) {
				return await buildResponse(fileResult)
			}
			await markExpectedMiss(indexPath)
		}

		// Index not found - check if we need directory listing
		if (settings?.directoryListing) {
			const fileCids = await getExpectedFileCids()
			const directoryEntries = await listDirectoryEntries(
				did,
				rkey,
				requestPath,
				fileCids ? Object.keys(fileCids) : null,
			)
			if (directoryEntries.length > 0) {
				const missResponse = await maybeReturnStorageMiss()
				if (missResponse) return missResponse
				const html = generateDirectoryListing(requestPath, directoryEntries)
				return new Response(html, {
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Cache-Control': STANDARD_CACHE_CONTROL,
					},
				})
			}
		}
		// Fall through to normal file serving / 404 handling
	}

	// Try to serve as a file
	const fileRequestPath: string = requestPath || indexFiles[0] || 'index.html'

	const fileResult = await getExpectedFileForRequest(fileRequestPath)
	if (fileResult) {
		return await buildResponse(fileResult)
	}
	await markExpectedMiss(fileRequestPath)

	// Try index files for directory-like paths (even with extensions,
	// e.g. Astro emits `relay.md/index.html` for .md routes)
	for (const indexFileName of indexFiles) {
		const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName
		const indexResult = await getExpectedFileForRequest(indexPath)
		if (indexResult) {
			return await buildResponse(indexResult)
		}
		await markExpectedMiss(indexPath)
	}

	// Try clean URLs: /about -> /about.html
	if (settings?.cleanUrls && !hasFileExtension(fileRequestPath)) {
		const htmlPath = `${fileRequestPath}.html`
		const htmlResult = await getExpectedFileForRequest(htmlPath)
		if (htmlResult) {
			return await buildResponse(htmlResult)
		}
		await markExpectedMiss(htmlPath)

		// Also try /about/index.html
		for (const indexFileName of indexFiles) {
			const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName
			const indexResult = await getExpectedFileForRequest(indexPath)
			if (indexResult) {
				return await buildResponse(indexResult)
			}
			await markExpectedMiss(indexPath)
		}
	}

	// SPA mode: serve SPA file for all non-existing routes
	if (settings?.spaMode) {
		const spaFile = settings.spaMode
		const spaResult = await getFallbackFileForRequest(did, rkey, spaFile, trace)
		if (spaResult) {
			return await buildResponse(spaResult)
		}
		await markExpectedMiss(spaFile)
	}

	// Custom 404: serve custom 404 file if configured (wins conflict battle)
	if (settings?.custom404) {
		const custom404File = settings.custom404
		const custom404Result = await getFallbackFileForRequest(did, rkey, custom404File, trace)
		if (custom404Result) {
			const response = await buildResponse(custom404Result)
			return new Response(response.body, { status: 404, headers: response.headers })
		}
		await markExpectedMiss(custom404File)
	}

	// Autodetect 404 pages (GitHub Pages: 404.html, Neocities/Nekoweb: not_found.html)
	for (const auto404Page of ['404.html', 'not_found.html']) {
		const auto404Result = await getFallbackFileForRequest(did, rkey, auto404Page, trace)
		if (auto404Result) {
			const response = await buildResponse(auto404Result)
			return new Response(response.body, { status: 404, headers: response.headers })
		}
		await markExpectedMiss(auto404Page)
	}

	// Directory listing fallback: if enabled, show root directory listing on 404
	if (settings?.directoryListing) {
		const fileCids = await getExpectedFileCids()
		const rootEntries = await listDirectoryEntries(did, rkey, '', fileCids ? Object.keys(fileCids) : null)
		if (rootEntries.length > 0) {
			const missResponse = await maybeReturnStorageMiss()
			if (missResponse) return missResponse
			const html = generateDirectoryListing('', rootEntries)
			return new Response(html, {
				status: 404,
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': STANDARD_CACHE_CONTROL,
				},
			})
		}
	}

	const missResponse = await maybeReturnStorageMiss()
	if (missResponse) return missResponse

	// Last resort: if site not in DB at all, try on-demand fetch
	const fileCids = await getExpectedFileCids()
	if (fileCids === null) {
		logger.info(`Site not found in DB, attempting on-demand fetch before 404`, { did, rkey })
		const success = await fetchAndCacheSite(did, rkey)
		if (success) {
			// Retry serving the originally requested file
			const retryPath = filePath || indexFiles[0] || 'index.html'
			const retryResult = await span(trace, `storage:${retryPath}`, () => getFileForRequest(did, rkey, retryPath, true))
			if (retryResult) {
				return await buildResponse(retryResult)
			}
		}
	}

	// Default styled 404 page
	const html = generate404Page()
	return new Response(html, {
		status: 404,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': STANDARD_CACHE_CONTROL,
		},
	})
}
