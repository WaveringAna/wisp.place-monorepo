import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { IdResolver } from '@atproto/identity'
import { Firehose } from '@atproto/sync'
import { serve as honoNodeServe } from '@hono/node-server'
import { getPdsForDid, resolveDid, unsafeRawIdentityGet } from '@wispplace/atproto-utils'
import { BunFirehose, type BunFirehoseOptions, isBun } from '@wispplace/bun-firehose'
import {
	matchRedirectRule,
	normalizeSitePath,
	parseQueryString,
	parseRedirectsFile,
	type RedirectRule,
} from '@wispplace/fs-utils'
import type { Record as SettingsRecord } from '@wispplace/lexicons/types/place/wisp/settings'
import { generate404Page, generateDirectoryListing } from '@wispplace/page-generators'
import { Hono } from 'hono'
import { lookup } from 'mime-types'
import { createSpinner, pc } from '../lib/progress.ts'
import { pull } from './pull.ts'

export interface ServeOptions {
	site: string
	path: string
	port: number
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

async function fetchSettings(pdsEndpoint: string, did: string, rkey: string): Promise<SettingsRecord | null> {
	try {
		const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.settings&rkey=${encodeURIComponent(rkey)}`
		const res = await fetch(url)
		if (!res.ok) return null
		const data = (await res.json()) as { value: SettingsRecord }
		return data.value
	} catch {
		return null
	}
}

function loadRedirectRules(siteDir: string): RedirectRule[] {
	const redirectsPath = join(siteDir, '_redirects')
	if (!existsSync(redirectsPath)) {
		return []
	}
	try {
		const content = readFileSync(redirectsPath, 'utf-8')
		return parseRedirectsFile(content)
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

function serveFile(filePath: string): Response {
	const content = readFileSync(filePath)
	const mimeType = lookup(filePath) || 'application/octet-stream'

	return new Response(content, {
		headers: {
			'Content-Type': mimeType,
			'Cache-Control': 'no-cache',
		},
	})
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

function handleRequest(req: Request, state: SiteState): Response {
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
				if (existsSync(custom404Path)) {
					const content = readFileSync(custom404Path)
					return new Response(content, {
						status: 404,
						headers: { 'Content-Type': 'text/html' },
					})
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
	if (existsSync(filePath) && statSync(filePath).isDirectory()) {
		// Try index files
		const indexFiles = getIndexFiles(state.settings)
		for (const indexFile of indexFiles) {
			const normalizedIndexFile = normalizeConfiguredSitePath(indexFile)
			if (!normalizedIndexFile) continue
			const indexPath = join(filePath, normalizedIndexFile)
			if (existsSync(indexPath)) {
				return serveFile(indexPath)
			}
		}

		// Directory listing if enabled
		if (directoryListingEnabled) {
			const html = buildDirectoryListing(filePath, urlPath)
			return new Response(html, {
				headers: { 'Content-Type': 'text/html' },
			})
		}
	}

	// Try exact file
	if (existsSync(filePath) && statSync(filePath).isFile()) {
		return serveFile(filePath)
	}

	// Clean URLs - try adding .html
	if (state.settings?.cleanUrls !== false) {
		const htmlPath = `${filePath}.html`
		if (existsSync(htmlPath) && statSync(htmlPath).isFile()) {
			return serveFile(htmlPath)
		}

		// Try /path/index.html
		const indexPath = join(filePath, 'index.html')
		if (existsSync(indexPath) && statSync(indexPath).isFile()) {
			return serveFile(indexPath)
		}
	}

	// SPA mode - serve the SPA file for all unmatched routes
	if (spaFile) {
		const normalizedSpaFile = normalizeConfiguredSitePath(spaFile)
		if (normalizedSpaFile) {
			const spaPath = join(state.siteDir, normalizedSpaFile)
			if (existsSync(spaPath)) {
				return serveFile(spaPath)
			}
		}
	}

	// Custom 404
	if (state.settings?.custom404) {
		const custom404File = normalizeConfiguredSitePath(state.settings.custom404)
		if (custom404File) {
			const custom404Path = join(state.siteDir, custom404File)
			if (existsSync(custom404Path)) {
				const content = readFileSync(custom404Path)
				return new Response(content, {
					status: 404,
					headers: { 'Content-Type': 'text/html' },
				})
			}
		}
	}

	// Auto-detect 404.html
	const auto404Paths = ['404.html', 'not_found.html']
	for (const notFoundFile of auto404Paths) {
		const notFoundPath = join(state.siteDir, notFoundFile)
		if (existsSync(notFoundPath)) {
			const content = readFileSync(notFoundPath)
			return new Response(content, {
				status: 404,
				headers: { 'Content-Type': 'text/html' },
			})
		}
	}

	// Default 404
	return new Response(generate404Page(), {
		status: 404,
		headers: { 'Content-Type': 'text/html' },
	})
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
			fetch: app.fetch,
		})
		serverHandle = { close: () => bunServer.stop() }
	} else {
		const nodeServer = honoNodeServe({
			fetch: app.fetch,
			port,
		})
		serverHandle = { close: () => nodeServer.close() }
	}

	console.log(pc.green(`\n✓ Server running at http://localhost:${port}\n`))
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
