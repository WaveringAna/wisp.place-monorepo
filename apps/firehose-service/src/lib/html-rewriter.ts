/**
 * HTML path rewriting for firehose-service
 * Rewrites absolute/relative paths in HTML to be served from a base path
 */

const REWRITABLE_ATTRIBUTES = ['src', 'href', 'action', 'data', 'poster', 'srcset'] as const

function shouldRewritePath(path: string): boolean {
	if (!path) return false

	// Don't rewrite external URLs
	if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//')) {
		return false
	}

	// Don't rewrite data URIs or other schemes
	if (path.includes(':') && !path.startsWith('./') && !path.startsWith('../')) {
		return false
	}

	return true
}

function normalizePath(path: string): string {
	const parts = path.split('/')
	const result: string[] = []

	for (const part of parts) {
		if (part === '.' || part === '') {
			if (part === '' && result.length === 0) {
				result.push(part)
			}
			continue
		}
		if (part === '..') {
			if (result.length > 0 && result[result.length - 1] !== '..') {
				result.pop()
			}
			continue
		}
		result.push(part)
	}

	return result.join('/')
}

function getDirectory(filepath: string): string {
	const lastSlash = filepath.lastIndexOf('/')
	if (lastSlash === -1) {
		return ''
	}
	return filepath.substring(0, lastSlash + 1)
}

function rewritePath(path: string, basePath: string, documentPath: string): string {
	if (!shouldRewritePath(path)) {
		return path
	}

	// Handle absolute paths: /file.js -> /base/file.js
	if (path.startsWith('/')) {
		return basePath + path.slice(1)
	}

	// Handle relative paths
	const documentDir = getDirectory(documentPath)
	let resolvedPath: string

	if (path.startsWith('./')) {
		resolvedPath = documentDir + path.slice(2)
	} else if (path.startsWith('../')) {
		resolvedPath = documentDir + path
	} else {
		resolvedPath = documentDir + path
	}

	resolvedPath = normalizePath(resolvedPath)
	return basePath + resolvedPath
}

function rewriteSrcset(srcset: string, basePath: string, documentPath: string): string {
	return srcset
		.split(',')
		.map((part) => {
			const trimmed = part.trim()
			const spaceIndex = trimmed.indexOf(' ')

			if (spaceIndex === -1) {
				return rewritePath(trimmed, basePath, documentPath)
			}

			const url = trimmed.substring(0, spaceIndex)
			const descriptor = trimmed.substring(spaceIndex)
			return rewritePath(url, basePath, documentPath) + descriptor
		})
		.join(', ')
}

/**
 * Rewrite paths in HTML content for serving from a base path
 */
export function rewriteHtmlPaths(html: string, basePath: string, documentPath: string): string {
	const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`

	let rewritten = html

	for (const attr of REWRITABLE_ATTRIBUTES) {
		if (attr === 'srcset') {
			const srcsetRegex = new RegExp(`\\b${attr}[ \\t]{0,5}=[ \\t]{0,5}"([^"]*)"`, 'gi')
			rewritten = rewritten.replace(srcsetRegex, (_match, value) => {
				const rewrittenValue = rewriteSrcset(value, normalizedBase, documentPath)
				return `${attr}="${rewrittenValue}"`
			})
		} else {
			const doubleQuoteRegex = new RegExp(`\\b${attr}[ \\t]{0,5}=[ \\t]{0,5}"([^"]*)"`, 'gi')
			const singleQuoteRegex = new RegExp(`\\b${attr}[ \\t]{0,5}=[ \\t]{0,5}'([^']*)'`, 'gi')
			const unquotedRegex = new RegExp(`\\b${attr}[ \\t]{0,5}=[ \\t]{0,5}(?!["'])([^\\s>]+)`, 'gi')

			rewritten = rewritten.replace(doubleQuoteRegex, (_match, value) => {
				const rewrittenValue = rewritePath(value, normalizedBase, documentPath)
				return `${attr}="${rewrittenValue}"`
			})

			rewritten = rewritten.replace(singleQuoteRegex, (_match, value) => {
				const rewrittenValue = rewritePath(value, normalizedBase, documentPath)
				return `${attr}='${rewrittenValue}'`
			})

			rewritten = rewritten.replace(unquotedRegex, (_match, value) => {
				const rewrittenValue = rewritePath(value, normalizedBase, documentPath)
				return `${attr}=${rewrittenValue}`
			})
		}
	}

	return rewritten
}

export function isHtmlFile(filepath: string): boolean {
	const ext = filepath.toLowerCase().split('.').pop()
	return ext === 'html' || ext === 'htm'
}
