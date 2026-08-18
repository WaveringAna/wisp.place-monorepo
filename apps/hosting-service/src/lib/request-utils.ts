/**
 * Request utilities for validation and helper functions
 */

import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'

const SHARED_ORIGIN_BLOCKED_HEADERS = new Set(['service-worker-allowed'])

export function decodeRequestPathname(pathname: string): string | null {
	try {
		return decodeURIComponent(pathname)
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

/**
 * Get index files list from settings or use defaults
 */
export function getIndexFiles(settings: WispSettings | null): string[] {
	if (settings?.indexFiles && settings.indexFiles.length > 0) {
		return settings.indexFiles
	}
	return DEFAULT_INDEX_FILES
}

/**
 * Match a file path against a glob pattern
 * Supports * wildcard and basic path matching
 */
export function matchGlob(path: string, pattern: string): boolean {
	// Normalize paths
	const normalizedPath = path.startsWith('/') ? path : `/${path}`
	const normalizedPattern = pattern.startsWith('/') ? pattern : `/${pattern}`

	// Convert glob pattern to regex
	const regexPattern = normalizedPattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')

	const regex = new RegExp(`^${regexPattern}$`)
	return regex.test(normalizedPath)
}

/**
 * Apply custom headers from settings to response headers
 */
export function applyCustomHeaders(
	headers: Record<string, string>,
	filePath: string,
	settings: WispSettings | null,
	options: CustomHeaderOptions = {},
) {
	if (!settings?.headers || settings.headers.length === 0) return

	for (const customHeader of settings.headers) {
		if (options.sharedOrigin && SHARED_ORIGIN_BLOCKED_HEADERS.has(customHeader.name.trim().toLowerCase())) {
			continue
		}

		// If path glob is specified, check if it matches
		if (customHeader.path) {
			if (!matchGlob(filePath, customHeader.path)) {
				continue
			}
		}
		// Apply the header
		headers[customHeader.name] = customHeader.value
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
 * Async file existence check
 */
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
