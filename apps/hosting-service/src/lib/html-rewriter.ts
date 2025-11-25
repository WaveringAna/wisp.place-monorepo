/**
 * Safely rewrites absolute paths in HTML to be relative to a base path
 * Only processes common HTML attributes and preserves external URLs, data URIs, etc.
 */

const REWRITABLE_ATTRIBUTES = [
	'src',
	'href',
	'action',
	'data',
	'poster',
	'srcset'
] as const

/**
 * Check if a path should be rewritten
 */
function shouldRewritePath(path: string): boolean {
	// Don't rewrite empty paths
	if (!path) return false

	// Don't rewrite external URLs (http://, https://, //)
	if (
		path.startsWith('http://') ||
		path.startsWith('https://') ||
		path.startsWith('//')
	) {
		return false
	}

	// Don't rewrite data URIs or other schemes (except file paths)
	if (
		path.includes(':') &&
		!path.startsWith('./') &&
		!path.startsWith('../')
	) {
		return false
	}

	// Rewrite absolute paths (/) and relative paths (./ or ../ or plain filenames)
	return true
}

/**
 * Normalize a path by resolving . and .. segments
 */
function normalizePath(path: string): string {
	const parts = path.split('/')
	const result: string[] = []

	for (const part of parts) {
		if (part === '.' || part === '') {
			// Skip current directory and empty parts (but keep leading empty for absolute paths)
			if (part === '' && result.length === 0) {
				result.push(part)
			}
			continue
		}
		if (part === '..') {
			// Go up one directory (but not past root)
			if (result.length > 0 && result[result.length - 1] !== '..') {
				result.pop()
			}
			continue
		}
		result.push(part)
	}

	return result.join('/')
}

/**
 * Get the directory path from a file path
 * e.g., "folder1/folder2/file.html" -> "folder1/folder2/"
 */
function getDirectory(filepath: string): string {
	const lastSlash = filepath.lastIndexOf('/')
	if (lastSlash === -1) {
		return ''
	}
	return filepath.substring(0, lastSlash + 1)
}

/**
 * Rewrite a single path
 */
function rewritePath(
	path: string,
	basePath: string,
	documentPath: string
): string {
	if (!shouldRewritePath(path)) {
		return path
	}

	// Handle absolute paths: /file.js -> /base/file.js
	if (path.startsWith('/')) {
		return basePath + path.slice(1)
	}

	// Handle relative paths by resolving against document directory
	const documentDir = getDirectory(documentPath)
	let resolvedPath: string

	if (path.startsWith('./')) {
		// ./file.js relative to current directory
		resolvedPath = documentDir + path.slice(2)
	} else if (path.startsWith('../')) {
		// ../file.js relative to parent directory
		resolvedPath = documentDir + path
	} else {
		// file.js (no prefix) - treat as relative to current directory
		resolvedPath = documentDir + path
	}

	// Normalize the path to resolve .. and .
	resolvedPath = normalizePath(resolvedPath)

	return basePath + resolvedPath
}

/**
 * Rewrite srcset attribute (can contain multiple URLs)
 * Format: "url1 1x, url2 2x" or "url1 100w, url2 200w"
 */
function rewriteSrcset(
	srcset: string,
	basePath: string,
	documentPath: string
): string {
	return srcset
		.split(',')
		.map((part) => {
			const trimmed = part.trim()
			const spaceIndex = trimmed.indexOf(' ')

			if (spaceIndex === -1) {
				// No descriptor, just URL
				return rewritePath(trimmed, basePath, documentPath)
			}

			const url = trimmed.substring(0, spaceIndex)
			const descriptor = trimmed.substring(spaceIndex)
			return rewritePath(url, basePath, documentPath) + descriptor
		})
		.join(', ')
}

/**
 * Rewrite absolute and relative paths in HTML content
 * Uses simple regex matching for safety (no full HTML parsing)
 */
export function rewriteHtmlPaths(
	html: string,
	basePath: string,
	documentPath: string
): string {
	// Ensure base path ends with /
	const normalizedBase = basePath.endsWith('/') ? basePath : basePath + '/'

	let rewritten = html

	// Rewrite each attribute type
	// Use more specific patterns to prevent ReDoS attacks
	for (const attr of REWRITABLE_ATTRIBUTES) {
		if (attr === 'srcset') {
			// Special handling for srcset - use possessive quantifiers via atomic grouping simulation
			// Limit whitespace to reasonable amount (max 5 spaces) to prevent ReDoS
			const srcsetRegex = new RegExp(
				`\\b${attr}[ \\t]{0,5}=[ \\t]{0,5}"([^"]*)"`,
				'gi'
			)
			rewritten = rewritten.replace(srcsetRegex, (match, value) => {
				const rewrittenValue = rewriteSrcset(
					value,
					normalizedBase,
					documentPath
				)
				return `${attr}="${rewrittenValue}"`
			})
		} else {
			// Regular attributes with quoted values
			// Limit whitespace to prevent catastrophic backtracking
			const doubleQuoteRegex = new RegExp(
				`\\b${attr}[ \\t]{0,5}=[ \\t]{0,5}"([^"]*)"`,
				'gi'
			)
			const singleQuoteRegex = new RegExp(
				`\\b${attr}[ \\t]{0,5}=[ \\t]{0,5}'([^']*)'`,
				'gi'
			)

			rewritten = rewritten.replace(doubleQuoteRegex, (match, value) => {
				const rewrittenValue = rewritePath(
					value,
					normalizedBase,
					documentPath
				)
				return `${attr}="${rewrittenValue}"`
			})

			rewritten = rewritten.replace(singleQuoteRegex, (match, value) => {
				const rewrittenValue = rewritePath(
					value,
					normalizedBase,
					documentPath
				)
				return `${attr}='${rewrittenValue}'`
			})
		}
	}

	return rewritten
}

/**
 * Check if content is HTML based on content or filename
 */
export function isHtmlContent(filepath: string, contentType?: string): boolean {
	if (contentType && contentType.includes('text/html')) {
		return true
	}

	const ext = filepath.toLowerCase().split('.').pop()
	return ext === 'html' || ext === 'htm'
}
