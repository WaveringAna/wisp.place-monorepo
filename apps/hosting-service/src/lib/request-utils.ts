/**
 * Request utilities for validation and helper functions
 */

import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'

const MAX_GLOB_PATH_LENGTH = 4_096
const MAX_GLOB_PATTERN_LENGTH = 500
export const MAX_GLOB_MATCH_OPERATIONS = 16_384
const MAX_CUSTOM_HEADERS = 50
const MAX_CUSTOM_HEADER_NAME_LENGTH = 100
const MAX_CUSTOM_HEADER_VALUE_LENGTH = 1_000
const MAX_INDEX_FILES = 10
const MAX_INDEX_FILE_PATH_LENGTH = 255

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const ABSOLUTE_URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/

function hasInvalidControlCharacter(value: string, allowHorizontalTab = false): boolean {
	for (let index = 0; index < value.length; index++) {
		const characterCode = value.charCodeAt(index)
		if (characterCode === 0x7f || (characterCode < 0x20 && (!allowHorizontalTab || characterCode !== 0x09))) {
			return true
		}
	}

	return false
}

function hasInvalidHeaderValueCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const characterCode = value.charCodeAt(index)
		if (characterCode > 0xff || characterCode === 0x7f || (characterCode < 0x20 && characterCode !== 0x09)) {
			return true
		}
	}

	return false
}

// These can corrupt a response body, transfer framing, or representation validator on every origin.
const UNSAFE_RESPONSE_HEADERS = new Set([
	'accept-ranges',
	'connection',
	'content-encoding',
	'content-length',
	'content-range',
	'etag',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
])

// These have host-wide or origin-wide effects and are unsafe on sites.wisp.place.
const SHARED_ORIGIN_BLOCKED_HEADERS = new Set([
	'accept-ch',
	'accept-ch-lifetime',
	'alt-svc',
	'clear-site-data',
	'critical-ch',
	'expect-ct',
	'nel',
	'origin-agent-cluster',
	'public-key-pins',
	'public-key-pins-report-only',
	'report-to',
	'reporting-endpoints',
	'service-worker-allowed',
	'set-cookie',
	'set-cookie2',
	'strict-transport-security',
])

export function decodeRequestPathname(pathname: string): string | null {
	try {
		const decodedPathname = decodeURIComponent(pathname)
		return decodedPathname.includes('\0') ? null : decodedPathname
	} catch {
		return null
	}
}

interface CustomHeaderOptions {
	sharedOrigin?: boolean
}

/**
 * Default index file names to check for directory requests
 * Will be checked in order until one is found
 */
export const DEFAULT_INDEX_FILES = ['index.html', 'index.htm']

function isNormalizedRelativeSitePath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0 || path.length > MAX_INDEX_FILE_PATH_LENGTH) {
		return false
	}

	if (
		path.startsWith('/') ||
		path.includes('\\') ||
		hasInvalidControlCharacter(path) ||
		ABSOLUTE_URL_PATTERN.test(path)
	) {
		return false
	}

	return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/**
 * Get index files list from settings or use defaults.
 * Only relative, normalized site paths are safe to use as storage lookup keys.
 */
export function getIndexFiles(settings: WispSettings | null): string[] {
	const configuredIndexFiles = settings?.indexFiles
	if (!Array.isArray(configuredIndexFiles) || configuredIndexFiles.length === 0) {
		return DEFAULT_INDEX_FILES
	}

	const indexFiles: string[] = []
	const count = Math.min(configuredIndexFiles.length, MAX_INDEX_FILES)
	for (let index = 0; index < count; index++) {
		const indexFile = configuredIndexFiles[index]
		if (isNormalizedRelativeSitePath(indexFile)) {
			indexFiles.push(indexFile)
		}
	}

	return indexFiles.length > 0 ? indexFiles : DEFAULT_INDEX_FILES
}

function normalizeGlobPath(path: string): string {
	return path.startsWith('/') ? path : `/${path}`
}

export interface GlobMatchResult {
	matches: boolean
	operations: number
	budgetExhausted: boolean
}

/**
 * Match a file path against a glob pattern.
 * `*` matches any number of characters and `?` matches exactly one character.
 * All other characters are literals. Length and operation limits keep matching
 * predictably bounded without regex backtracking.
 */
export function matchGlobWithStats(path: string, pattern: string): GlobMatchResult {
	if (
		typeof path !== 'string' ||
		typeof pattern !== 'string' ||
		path.length > MAX_GLOB_PATH_LENGTH ||
		pattern.length > MAX_GLOB_PATTERN_LENGTH
	) {
		return { matches: false, operations: 0, budgetExhausted: false }
	}

	const normalizedPath = normalizeGlobPath(path)
	const normalizedPattern = normalizeGlobPath(pattern)
	let pathIndex = 0
	let patternIndex = 0
	let starIndex = -1
	let pathIndexAfterStar = 0
	let operations = 0

	// A remembered `*` can retry a suffix, so bound every retry explicitly.
	while (pathIndex < normalizedPath.length) {
		if (operations >= MAX_GLOB_MATCH_OPERATIONS) {
			return { matches: false, operations, budgetExhausted: true }
		}
		operations++

		const patternCharacter = normalizedPattern[patternIndex]
		if (patternCharacter === '*') {
			starIndex = patternIndex
			patternIndex++
			pathIndexAfterStar = pathIndex
			continue
		}

		if (patternCharacter === '?' || patternCharacter === normalizedPath[pathIndex]) {
			pathIndex++
			patternIndex++
			continue
		}

		if (starIndex === -1) {
			return { matches: false, operations, budgetExhausted: false }
		}

		patternIndex = starIndex + 1
		pathIndex = ++pathIndexAfterStar
	}

	while (normalizedPattern[patternIndex] === '*') {
		if (operations >= MAX_GLOB_MATCH_OPERATIONS) {
			return { matches: false, operations, budgetExhausted: true }
		}
		operations++
		patternIndex++
	}

	return { matches: patternIndex === normalizedPattern.length, operations, budgetExhausted: false }
}

export function matchGlob(path: string, pattern: string): boolean {
	return matchGlobWithStats(path, pattern).matches
}

function isValidCustomHeaderName(name: unknown): name is string {
	return (
		typeof name === 'string' &&
		name.length > 0 &&
		name.length <= MAX_CUSTOM_HEADER_NAME_LENGTH &&
		HEADER_NAME_PATTERN.test(name)
	)
}

function isValidCustomHeaderValue(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= MAX_CUSTOM_HEADER_VALUE_LENGTH &&
		!hasInvalidHeaderValueCharacter(value)
	)
}

function isBlockedCustomResponseHeader(name: string, sharedOrigin: boolean): boolean {
	if (UNSAFE_RESPONSE_HEADERS.has(name)) {
		return true
	}

	return sharedOrigin && (SHARED_ORIGIN_BLOCKED_HEADERS.has(name) || name.startsWith('access-control-'))
}

interface ValidatedCustomHeader {
	name: string
	normalizedName: string
	path: unknown
	value: string
}

function validateCustomHeader(customHeader: unknown): ValidatedCustomHeader | null {
	if (!customHeader || typeof customHeader !== 'object') return null

	const { name, path, value } = customHeader as { name?: unknown; path?: unknown; value?: unknown }
	if (!isValidCustomHeaderName(name) || !isValidCustomHeaderValue(value)) return null

	return { name, normalizedName: name.toLowerCase(), path, value }
}

function matchesCustomHeaderPath(path: unknown, filePath: string): boolean {
	if (path === undefined || path === '') return true
	return typeof path === 'string' && matchGlob(filePath, path)
}

function canApplyCustomHeader(header: ValidatedCustomHeader, filePath: string, sharedOrigin: boolean): boolean {
	return (
		!isBlockedCustomResponseHeader(header.normalizedName, sharedOrigin) &&
		matchesCustomHeaderPath(header.path, filePath)
	)
}

function replaceResponseHeader(
	headers: Record<string, string>,
	name: string,
	normalizedName: string,
	value: string,
): void {
	let headerName = name
	let foundExistingHeader = false
	for (const existingHeaderName of Object.keys(headers)) {
		if (existingHeaderName.toLowerCase() !== normalizedName) continue

		if (!foundExistingHeader) {
			headerName = existingHeaderName
			foundExistingHeader = true
		} else {
			delete headers[existingHeaderName]
		}
	}

	headers[headerName] = value
}

function applyValidatedCustomHeader(headers: Record<string, string>, header: ValidatedCustomHeader): void {
	replaceResponseHeader(headers, header.name, header.normalizedName, header.value)
}

/**
 * Apply custom headers from settings to response headers.
 */
export function applyCustomHeaders(
	headers: Record<string, string>,
	filePath: string,
	settings: WispSettings | null,
	options: CustomHeaderOptions = {},
) {
	const customHeaders = settings?.headers
	if (!Array.isArray(customHeaders) || customHeaders.length === 0) return

	for (const customHeader of customHeaders.slice(0, MAX_CUSTOM_HEADERS)) {
		const header = validateCustomHeader(customHeader)
		if (!header || !canApplyCustomHeader(header, filePath, options.sharedOrigin === true)) continue
		applyValidatedCustomHeader(headers, header)
	}
}

/**
 * Validate site name (rkey) to prevent injection attacks
 * Must match AT Protocol rkey format
 */
export function isValidRkey(rkey: string): boolean {
	if (!rkey || typeof rkey !== 'string') return false
	if (rkey.length < 1 || rkey.length > 512) return false
	if (rkey === '.' || rkey === '..') return false
	if (rkey.includes('/') || rkey.includes('\\') || rkey.includes('\0')) return false
	const validRkeyPattern = /^[a-zA-Z0-9._~:-]+$/
	return validRkeyPattern.test(rkey)
}

/**
 * Extract and normalize headers from request
 */
export function extractHeaders(rawHeaders: Headers): Record<string, string> {
	const headers: Record<string, string> = {}
	rawHeaders.forEach((value, key) => {
		headers[key.toLowerCase()] = value
	})
	return headers
}
