import { closeSync, createReadStream, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { IdResolver } from '@atproto/identity'
import { Firehose } from '@atproto/sync'
import { serve as honoNodeServe } from '@hono/node-server'
import { getPdsForDid, readBoundedIdentityJson, resolveDid, unsafeRawIdentityGet } from '@wispplace/atproto-utils'
import { BunFirehose, type BunFirehoseOptions, isBun } from '@wispplace/bun-firehose'
import {
	MAX_REDIRECT_FILE_BYTES,
	matchRedirectRule,
	normalizeSitePath,
	parseQueryString,
	parseRedirectsFileBytes,
	type RedirectRule,
} from '@wispplace/fs-utils'
import type { Record as SettingsRecord } from '@wispplace/lexicons/types/place/wisp/settings'
import { validateRecord as validateSettingsRecord } from '@wispplace/lexicons/types/place/wisp/settings'
import { generate404Page, generateDirectoryListing } from '@wispplace/page-generators'
import { Hono } from 'hono'
import { lookup } from 'mime-types'
import { createSpinner, pc } from '../lib/progress.ts'
import { pull } from './pull.ts'

export interface ServeOptions {
	site: string
	path: string
	port: number
	host?: string
	spa?: string | boolean
	directoryListing?: boolean
}

interface SiteState {
	did: string
	rkey: string
	pdsEndpoint: string
	siteDir: string
	settings: SettingsRecord | null
	redirectRules: RedirectRule[]
	// CLI flag overrides (take precedence over settings record)
	spaOverride?: string | boolean
	directoryListingOverride?: boolean
}

export const MAX_ACTIVE_FILE_STREAMS = 64
let activeFileStreams = 0

async function fetchSettings(pdsEndpoint: string, did: string, rkey: string): Promise<SettingsRecord | null> {
	const controller = new AbortController()
	const deadline = setTimeout(() => controller.abort(), 10_000)
	try {
		const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.settings&rkey=${encodeURIComponent(rkey)}`
		const res = await fetch(url, { signal: controller.signal })
		if (!res.ok) {
			await res.body?.cancel()
			return null
		}
		const data = await readBoundedIdentityJson<{ value?: unknown }>(res, 1_000_000, controller.signal)
		const value = validateSettingsRecord(data.value)
		return value.success ? value.value : null
	} catch {
		return null
	} finally {
		clearTimeout(deadline)
	}
}

export function loadRedirectRules(siteDir: string): RedirectRule[] {
	const redirectsPath = join(siteDir, '_redirects')
	if (!existsSync(redirectsPath)) {
		return []
	}
	try {
		if (statSync(redirectsPath).size > MAX_REDIRECT_FILE_BYTES) return []
		const fd = openSync(redirectsPath, 'r')
		try {
			const data = Buffer.allocUnsafe(MAX_REDIRECT_FILE_BYTES + 1)
			const size = readSync(fd, data, 0, data.byteLength, 0)
			return parseRedirectsFileBytes(data.subarray(0, size)) ?? []
		} finally {
			closeSync(fd)
		}
	} catch {
		return []
	}
}

function getIndexFiles(settings: SettingsRecord | null): string[] {
	return settings?.indexFiles || ['index.html', 'index.htm']
}

function buildDirectoryListing(dirPath: string, urlPath: string): string {
	const entries = readdirSync(dirPath, { withFileTypes: true })
	const normalized = urlPath.replace(/^\//, '').replace(/\/$/, '')
	return generateDirectoryListing(
		normalized,
		entries.filter((e) => !e.name.startsWith('.')).map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
	)
}

function serveFile(filePath: string, status = 200, head = false): Response {
	let fd: number | undefined
	let released = false
	let admitted = false
	const release = () => {
		if (released) return
		released = true
		if (fd !== undefined) {
			try {
				closeSync(fd)
			} catch {}
		}
		if (admitted) activeFileStreams--
	}
	try {
		fd = openSync(filePath, 'r')
		const info = fstatSync(fd)
		if (!info.isFile()) {
			closeSync(fd)
			fd = undefined
			return new Response('Not Found', { status: 404 })
		}
		const size = info.size
		const mimeType = lookup(filePath) || 'application/octet-stream'

		if (head) {
			release()
			return new Response(null, {
				status,
				headers: { 'Content-Type': mimeType, 'Content-Length': String(size), 'Cache-Control': 'no-cache' },
			})
		}
		if (activeFileStreams >= MAX_ACTIVE_FILE_STREAMS) {
			release()
			return new Response('Too many active file streams', { status: 503, headers: { 'Retry-After': '1' } })
		}
		activeFileStreams++
		admitted = true
		const stream = createReadStream(filePath, { fd, autoClose: false })
		stream.once('close', release)
		stream.once('end', release)
		stream.once('error', release)
		const body = Readable.toWeb(stream)
		return new Response(body as unknown as ReadableStream<Uint8Array>, {
			status,
			headers: { 'Content-Type': mimeType, 'Content-Length': String(size), 'Cache-Control': 'no-cache' },
		})
	} catch (error) {
		if (admitted) release()
		else if (fd !== undefined) {
			try {
				closeSync(fd)
			} catch {}
		}
		throw error
	}
}

function serveText(body: string, status: number, mimeType: string, head: boolean): Response {
	const bytes = new TextEncoder().encode(body)
	return new Response(head ? null : bytes, {
		status,
		headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.byteLength) },
	})
}

function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

function isSafeLocalFilePath(path: string): boolean {
	return !path.split('/').some((segment) => segment.includes(':') || /[. ]$/.test(segment))
}

export function normalizeServeRequestPath(pathname: string): string | null {
	if (!pathname.startsWith('/')) return null

	const rawPath = pathname.slice(1)
	const normalized = normalizeSitePath(rawPath, { allowTrailingSlash: true })
	if (normalized === null || !isSafeLocalFilePath(normalized)) return null
	return normalized ? `/${normalized}${rawPath.endsWith('/') ? '/' : ''}` : '/'
}

function normalizeConfiguredSitePath(path: string): string | null {
	const candidate = path.startsWith('/') ? path.slice(1) : path
	const normalized = normalizeSitePath(candidate)
	return normalized && normalized === candidate && isSafeLocalFilePath(normalized) ? normalized : null
}

function normalizeRewritePath(path: string): string | null {
	const requestPath = normalizeServeRequestPath(path)
	if (requestPath) return requestPath

	const relativePath = normalizeConfiguredSitePath(path)
	return relativePath ? `/${relativePath}` : null
}

export function handleRequest(req: Request, state: SiteState): Response {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
	}
	const head = req.method === 'HEAD'
	const url = new URL(req.url)
	let decodedPathname: string
	try {
		decodedPathname = decodeURIComponent(url.pathname)
	} catch {
		return new Response('Invalid path', { status: 400 })
	}

	let urlPath = normalizeServeRequestPath(decodedPathname)
	if (urlPath === null) return new Response('Invalid path', { status: 400 })

	// Check redirect rules first
	const queryParams = parseQueryString(url.search)
	const redirectMatch = matchRedirectRule(urlPath, state.redirectRules, { queryParams })

	if (redirectMatch) {
		if (redirectMatch.status === 200) {
			// Rewrites are local filesystem reads, so validate them just like the request.
			const rewrittenPath = normalizeRewritePath(redirectMatch.targetPath)
			if (rewrittenPath === null) return new Response('Invalid rewrite path', { status: 400 })
			urlPath = rewrittenPath
		} else if ([301, 302, 307, 308].includes(redirectMatch.status)) {
			// Redirect
			return new Response(null, {
				status: redirectMatch.status,
				headers: { Location: redirectMatch.targetPath },
			})
		} else if (redirectMatch.status === 404) {
			const custom404File = normalizeConfiguredSitePath(redirectMatch.targetPath)
			if (custom404File) {
				const custom404Path = join(state.siteDir, custom404File)
				if (isRegularFile(custom404Path)) {
					return serveFile(custom404Path, 404, head)
				}
			}
		}
	}

	// Resolve file path
	const filePath = join(state.siteDir, urlPath)

	// Resolve effective settings (CLI flags take precedence over settings record)
	const directoryListingEnabled = state.directoryListingOverride ?? state.settings?.directoryListing ?? false
	const spaFile =
		state.spaOverride !== undefined
			? state.spaOverride === true
				? 'index.html'
				: state.spaOverride || undefined
			: state.settings?.spaMode

	// Check if it's a directory
	if (isDirectory(filePath)) {
		// Try index files
		const indexFiles = getIndexFiles(state.settings)
		for (const indexFile of indexFiles) {
			const normalizedIndexFile = normalizeConfiguredSitePath(indexFile)
			if (!normalizedIndexFile) continue
			const indexPath = join(filePath, normalizedIndexFile)
			if (isRegularFile(indexPath)) {
				return serveFile(indexPath, 200, head)
			}
		}

		// Directory listing if enabled
		if (directoryListingEnabled) {
			const html = buildDirectoryListing(filePath, urlPath)
			return serveText(html, 200, 'text/html', head)
		}
	}

	// Try exact file
	if (isRegularFile(filePath)) {
		return serveFile(filePath, 200, head)
	}

	// Clean URLs - try adding .html
	if (state.settings?.cleanUrls !== false) {
		const htmlPath = `${filePath}.html`
		if (isRegularFile(htmlPath)) {
			return serveFile(htmlPath, 200, head)
		}

		// Try /path/index.html
		const indexPath = join(filePath, 'index.html')
		if (isRegularFile(indexPath)) {
			return serveFile(indexPath, 200, head)
		}
	}

	// SPA mode - serve the SPA file for all unmatched routes
	if (spaFile) {
		const normalizedSpaFile = normalizeConfiguredSitePath(spaFile)
		if (normalizedSpaFile) {
			const spaPath = join(state.siteDir, normalizedSpaFile)
			if (isRegularFile(spaPath)) {
				return serveFile(spaPath, 200, head)
			}
		}
	}

	// Custom 404
	if (state.settings?.custom404) {
		const custom404File = normalizeConfiguredSitePath(state.settings.custom404)
		if (custom404File) {
			const custom404Path = join(state.siteDir, custom404File)
			if (isRegularFile(custom404Path)) {
				return serveFile(custom404Path, 404, head)
			}
		}
	}

	// Auto-detect 404.html
	const auto404Paths = ['404.html', 'not_found.html']
	for (const notFoundFile of auto404Paths) {
		const notFoundPath = join(state.siteDir, notFoundFile)
		if (isRegularFile(notFoundPath)) {
			return serveFile(notFoundPath, 404, head)
		}
	}

	// Default 404
	return serveText(generate404Page(), 404, 'text/html', head)
}

export async function serve(identifier: string, options: ServeOptions): Promise<void> {
	const { site, path: outputPath, port } = options

	console.log(pc.cyan(`\nServing ${pc.bold(site)} from ${identifier}\n`))

	// 1. Resolve DID
	const spinner = createSpinner('Resolving identity...').start()
	const did = await resolveDid(identifier, unsafeRawIdentityGet)

	if (!did) {
		spinner.fail('Failed to resolve identity')
		throw new Error(`Could not resolve: ${identifier}`)
	}

	spinner.succeed(`Resolved to ${did}`)

	// 2. Get PDS endpoint
	const pdsSpinner = createSpinner('Getting PDS endpoint...').start()
	const pdsEndpoint = await getPdsForDid(did, unsafeRawIdentityGet, { allowLoopback: true })

	if (!pdsEndpoint) {
		pdsSpinner.fail('Failed to get PDS endpoint')
		throw new Error(`Could not get PDS for: ${did}`)
	}

	pdsSpinner.succeed(`PDS: ${pdsEndpoint}`)

	// 3. Initial pull
	await pull(identifier, { site, path: outputPath })

	// 4. Load settings and redirects
	const settings = await fetchSettings(pdsEndpoint, did, site)
	const redirectRules = loadRedirectRules(outputPath)

	const state: SiteState = {
		did,
		rkey: site,
		pdsEndpoint,
		siteDir: outputPath,
		settings,
		redirectRules,
		spaOverride: options.spa,
		directoryListingOverride: options.directoryListing,
	}

	// 5. Start HTTP server with Hono (works on both Bun and Node)
	const app = new Hono()

	app.all('*', (c) => {
		const req = c.req.raw
		return handleRequest(req, state)
	})

	let serverHandle: { close: () => void }

	if (isBun) {
		const bunServer = Bun.serve({
			port,
			hostname: options.host ?? '127.0.0.1',
			idleTimeout: 30,
			maxRequestBodySize: 1_048_576,
			fetch: app.fetch,
		})
		serverHandle = { close: () => bunServer.stop() }
	} else {
		const nodeServer = honoNodeServe({
			fetch: app.fetch,
			port,
			hostname: options.host ?? '127.0.0.1',
		})
		const protectedServer = nodeServer as typeof nodeServer & {
			headersTimeout?: number
			requestTimeout?: number
			timeout?: number
			keepAliveTimeout?: number
			maxRequestsPerSocket?: number
		}
		protectedServer.headersTimeout = 10_000
		protectedServer.requestTimeout = 30_000
		protectedServer.timeout = 30_000
		protectedServer.keepAliveTimeout = 5_000
		protectedServer.maxRequestsPerSocket = 100
		serverHandle = { close: () => nodeServer.close() }
	}

	console.log(pc.green(`\n✓ Server running at http://${options.host ?? '127.0.0.1'}:${port}\n`))
	console.log(pc.dim('Watching for updates via firehose...\n'))

	// 6. Connect to firehose for live updates (runtime-aware)
	const idResolver = new IdResolver()

	const firehoseHandleEvent = async (evt: any) => {
		// Only handle commit events for this DID
		if (evt.event !== 'create' && evt.event !== 'update' && evt.event !== 'delete') return
		if (evt.did !== did) return
		if (evt.rkey !== site) return

		if (evt.collection === 'place.wisp.fs') {
			console.log(pc.yellow('\nSite updated, re-pulling...\n'))
			await pull(identifier, { site, path: outputPath })

			// Reload redirects
			state.redirectRules = loadRedirectRules(outputPath)
			console.log(pc.green('✓ Site reloaded\n'))
		} else if (evt.collection === 'place.wisp.settings') {
			console.log(pc.yellow('\nSettings updated...\n'))
			state.settings = await fetchSettings(pdsEndpoint, did, site)
			console.log(pc.green('✓ Settings reloaded\n'))
		}
	}

	const firehoseOnError = (err: Error) => {
		console.error(pc.red('Firehose error:'), err.message)
		if (err.cause) {
			console.error(pc.red('  Cause:'), err.cause)
		}
	}

	let firehoseHandle: { destroy: () => void }

	if (isBun) {
		// Use BunFirehose for Bun
		const bunIdResolver = idResolver as unknown as BunFirehoseOptions['idResolver']
		const bunFirehose = new BunFirehose({
			idResolver: bunIdResolver,
			service: pdsEndpoint,
			filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
			handleEvent: firehoseHandleEvent,
			onError: firehoseOnError,
		})
		bunFirehose.start()
		firehoseHandle = { destroy: () => bunFirehose.destroy() }
	} else {
		// Use @atproto/sync Firehose for Node.js
		const nodeFirehose = new Firehose({
			idResolver,
			service: pdsEndpoint,
			filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
			handleEvent: firehoseHandleEvent,
			onError: firehoseOnError,
		})
		nodeFirehose.start()
		firehoseHandle = { destroy: () => nodeFirehose.destroy() }
	}

	// Handle shutdown
	process.on('SIGINT', () => {
		console.log(pc.dim('\nShutting down...'))
		firehoseHandle.destroy()
		serverHandle.close()
		process.exit(0)
	})

	// Keep process alive
	await new Promise(() => {})
}
