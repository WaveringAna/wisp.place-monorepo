export interface NormalizeSitePathOptions {
	/** Allow one trailing slash and return the canonical path without it. */
	allowTrailingSlash?: boolean
}

const MAX_SITE_PATH_LENGTH = 4096
const MAX_SITE_PATH_SEGMENTS = 128
const MAX_SITE_PATH_SEGMENT_LENGTH = 255
const CONTROL_CHARACTER = /[\p{Cc}]/u
const ENCODED_CONTROL_CHARACTER = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i
const ENCODED_PATH_STRUCTURE = /%(?:2e|2f|5c)/i
const WINDOWS_DRIVE_SEGMENT = /(?:^|\/)[a-zA-Z]:/

/**
 * Validate an untrusted site-relative path without silently changing it.
 * The empty string is the canonical site root. Routing may opt in to one
 * trailing slash; storage and filesystem callers must use canonical paths.
 */
export function normalizeSitePath(path: string, options: NormalizeSitePathOptions = {}): string | null {
	if (typeof path !== 'string') return null

	if (
		path.length > MAX_SITE_PATH_LENGTH ||
		path.startsWith('/') ||
		path.includes('\\') ||
		CONTROL_CHARACTER.test(path) ||
		ENCODED_CONTROL_CHARACTER.test(path) ||
		ENCODED_PATH_STRUCTURE.test(path) ||
		WINDOWS_DRIVE_SEGMENT.test(path)
	) {
		return null
	}

	if (!path) return ''

	if (path.endsWith('/')) {
		if (!options.allowTrailingSlash) return null
		path = path.slice(0, -1)
		if (!path || path.endsWith('/')) return null
	}

	const segments = path.split('/')
	if (segments.length > MAX_SITE_PATH_SEGMENTS) return null
	if (
		segments.some(
			(segment) => !segment || segment === '.' || segment === '..' || segment.length > MAX_SITE_PATH_SEGMENT_LENGTH,
		)
	) {
		return null
	}

	return path
}

/**
 * Legacy lossy sanitizer. New request, upload, and filesystem boundaries must
 * use normalizeSitePath so invalid paths are rejected rather than retargeted.
 */
export function sanitizePath(filePath: string): string {
	const cleaned = filePath
		.replace(/\\/g, '/')
		.replace(/(^|\/)[a-zA-Z]:/g, '$1')
		.replace(/^\/+/, '')

	return cleaned
		.split('/')
		.filter((segment) => segment && segment !== '.' && segment !== '..' && !CONTROL_CHARACTER.test(segment))
		.join('/')
}

/** Normalize a path by removing the first base folder name. */
export function normalizePath(path: string): string {
	return path.replace(/^[^/]*\//, '')
}
