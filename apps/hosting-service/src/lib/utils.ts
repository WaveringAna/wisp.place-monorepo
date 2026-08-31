import { isIP } from 'node:net'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import { isLocalhostFetchAllowed, type SafeFetchOptions, safeFetchJson } from '@wispplace/safe-fetch'
import { getSiteSettingsCache } from './db'

const DEFAULT_HANDLE_RESOLVER_URL = 'https://slingshot.microcosm.blue/xrpc/com.atproto.identity.resolveHandle'
const DEFAULT_PLC_DIRECTORY_URL = 'https://plc.directory'
// did:plc identifiers are fixed-width lowercase base32 (RFC 4648 without 0/1/8/9).
const PLC_DID_PATTERN = /^did:plc:[a-z2-7]{24}$/

type JsonFetcher = typeof safeFetchJson

interface DidDocument {
	alsoKnownAs?: unknown[]
}

export interface IdentityResolutionOptions {
	/** Test seam. Production requests use SSRF-hardened safeFetchJson. */
	fetchJson?: JsonFetcher
	fetchOptions?: SafeFetchOptions
	handleResolverUrl?: string
	plcDirectoryUrl?: string
}

function environment(name: string): string | undefined {
	return process.env[name] || (typeof Bun !== 'undefined' ? Bun.env[name] : undefined)
}

function normalizeHostname(hostname: string): string {
	return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

function isDnsHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname)
	if (normalized.length === 0 || normalized.length > 253 || isIP(normalized) !== 0) return false
	const withoutTrailingDot = normalized.endsWith('.') ? normalized.slice(0, -1) : normalized
	if (!withoutTrailingDot) return false
	return withoutTrailingDot.split('.').every((label) => {
		return label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
	})
}

function isLoopbackDevelopmentHostname(hostname: string): boolean {
	const normalized = normalizeHostname(hostname)
	return (
		normalized === 'localhost' ||
		normalized.endsWith('.localhost') ||
		normalized === '127.0.0.1' ||
		normalized === '::1'
	)
}

function isValidHandle(handle: string): boolean {
	if (handle.length < 3 || handle.length > 253 || handle !== handle.toLowerCase()) return false
	if (!handle.includes('.') || handle.includes('..') || handle.endsWith('.')) return false
	return isDnsHostname(handle)
}

function parseDidWeb(did: string): { authority: string; pathSegments: string[] } | null {
	if (!did.startsWith('did:web:') || did.length > 2048) return null
	const parts = did.slice('did:web:'.length).split(':')
	const encodedAuthority = parts.shift()
	if (!encodedAuthority || parts.some((part) => part === '.' || part === '..' || !/^[A-Za-z0-9._~-]+$/.test(part))) {
		return null
	}

	// did:web represents an explicit port as %3A. Reject other escapes so a
	// method-specific identifier cannot smuggle a different URL authority.
	if (/%(?!3a)/i.test(encodedAuthority)) return null
	const authority = encodedAuthority.replace(/%3a/gi, ':')

	try {
		const url = new URL(`https://${authority}`)
		if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
		if (!isDnsHostname(url.hostname)) return null
		return { authority: url.host, pathSegments: parts }
	} catch {
		return null
	}
}

/** Strictly accepts the DID methods this hosting service resolves. */
export function isValidDid(did: string): boolean {
	return PLC_DID_PATTERN.test(did) || parseDidWeb(did) !== null
}

/** Strictly accepts a supported DID or canonical AT Protocol handle. */
export function isValidAtprotoIdentifier(identifier: string): boolean {
	return isValidDid(identifier) || isValidHandle(identifier)
}

/** Convert a validated did:web identifier to its HTTPS DID document URL. */
export function didWebToHttps(did: string): string {
	const parsed = parseDidWeb(did)
	if (!parsed) throw new Error('Invalid did:web format')
	const base = `https://${parsed.authority}`
	if (parsed.pathSegments.length === 0) return `${base}/.well-known/did.json`
	return `${base}/${parsed.pathSegments.map((part) => encodeURIComponent(part)).join('/')}/did.json`
}

function parseIdentityEndpoint(value: string, name: string): URL {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error(`Invalid ${name} URL`)
	}

	if (url.username || url.password || url.search || url.hash || !url.hostname) {
		throw new Error(`Invalid ${name} URL`)
	}
	if (/%(?:2f|5c|00)/i.test(url.pathname)) throw new Error(`Invalid ${name} URL path`)
	const hostname = normalizeHostname(url.hostname)
	if (!isDnsHostname(hostname) && isIP(hostname) === 0) throw new Error(`Invalid ${name} hostname`)

	const localHttp = isLocalhostFetchAllowed() && isLoopbackDevelopmentHostname(hostname)
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHttp)) {
		throw new Error(`${name} must use HTTPS`)
	}
	return url
}

function configuredIdentityEndpoint(configured: string | undefined, fallback: string, name: string): string {
	const url = parseIdentityEndpoint(configured || fallback, name)
	url.pathname = url.pathname.replace(/\/+$/, '') || '/'
	return url.toString()
}

function identityFetchOptions(options: IdentityResolutionOptions): SafeFetchOptions {
	const fetchOptions = { ...(options.fetchOptions || {}) }
	if (isLocalhostFetchAllowed()) fetchOptions.allowLocalhost = true
	return fetchOptions
}

async function fetchJson<T>(url: string, options: IdentityResolutionOptions): Promise<T> {
	const fetcher = options.fetchJson || safeFetchJson
	return fetcher<T>(url, identityFetchOptions(options))
}

function parseDidDocument(value: unknown): DidDocument | null {
	if (typeof value !== 'object' || value === null) return null
	const document = value as DidDocument
	if (document.alsoKnownAs !== undefined && !Array.isArray(document.alsoKnownAs)) return null
	return document
}

function plcDocumentUrl(directory: string, did: string): string {
	const url = new URL(directory)
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(did)}`
	return url.toString()
}

/** Fetch a validated DID document with the pinned safe-fetch transport. */
export async function getDidDocument(
	did: string,
	options: IdentityResolutionOptions = {},
): Promise<DidDocument | null> {
	if (!isValidDid(did)) return null

	try {
		const url = did.startsWith('did:plc:')
			? plcDocumentUrl(
					configuredIdentityEndpoint(
						options.plcDirectoryUrl || environment('WISP_PLC_DIRECTORY_URL'),
						DEFAULT_PLC_DIRECTORY_URL,
						'PLC directory',
					),
					did,
				)
			: didWebToHttps(did)
		return parseDidDocument(await fetchJson<unknown>(url, options))
	} catch {
		return null
	}
}

function didDocumentIncludesHandle(document: DidDocument, handle: string): boolean {
	const expected = `at://${handle}`
	return (document.alsoKnownAs || []).some((value) => typeof value === 'string' && value.toLowerCase() === expected)
}

/**
 * Resolve a handle only after strict handle validation, then bind the result to
 * the handle declared in the fetched DID document.
 */
export async function resolveDid(identifier: string, options: IdentityResolutionOptions = {}): Promise<string | null> {
	if (isValidDid(identifier)) return identifier
	if (!isValidHandle(identifier)) return null

	try {
		const resolverUrl = new URL(
			configuredIdentityEndpoint(
				options.handleResolverUrl || environment('WISP_HANDLE_RESOLVER_URL'),
				DEFAULT_HANDLE_RESOLVER_URL,
				'handle resolver',
			),
		)
		resolverUrl.searchParams.set('handle', identifier)
		const result = await fetchJson<{ did?: unknown }>(resolverUrl.toString(), options)
		if (!result || typeof result.did !== 'string' || !isValidDid(result.did)) return null

		const document = await getDidDocument(result.did, options)
		return document && didDocumentIncludesHandle(document, identifier) ? result.did : null
	} catch {
		return null
	}
}

export async function getCachedSettings(did: string, rkey: string): Promise<WispSettings | null> {
	const cached = await getSiteSettingsCache(did, rkey)
	if (!cached) return null

	return {
		$type: 'place.wisp.settings',
		directoryListing: cached.directory_listing,
		spaMode: cached.spa_mode ?? undefined,
		custom404: cached.custom_404 ?? undefined,
		indexFiles: cached.index_files ?? undefined,
		cleanUrls: cached.clean_urls,
		headers: cached.headers ?? undefined,
	}
}
