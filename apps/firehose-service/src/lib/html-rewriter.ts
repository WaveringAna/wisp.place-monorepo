import { parse } from 'node-html-parser'

/**
 * Attributes whose values are rewritten.
 * - `'url'`    — a single URL string
 * - `'srcset'` — a comma-separated list of `<url> [descriptor]` entries
 */
const REWRITABLE_ATTRS: Record<string, 'url' | 'srcset'> = {
	src: 'url',
	href: 'url',
	action: 'url',
	data: 'url',
	poster: 'url',
	srcset: 'srcset',
}

/** Returns true if the URL is a root-relative path that needs prefixing (e.g. `/style.css`). */
function isRootRelative(url: string): boolean {
	if (!url || !url.startsWith('/')) return false
	// Protocol-relative (//cdn.example.com) — not a local path
	if (url.startsWith('//')) return false
	return true
}

/**
 * Prepend `basePath` to a root-relative URL, preserving query string and hash.
 */
function rewriteUrl(url: string, basePath: string): string {
	if (!isRootRelative(url)) return url
	if (url.startsWith(basePath)) return url
	const resolved = new URL(url, 'http://x')
	return basePath + resolved.pathname.slice(1) + resolved.search + resolved.hash
}

/** Rewrite each root-relative URL in a `srcset` value (comma-separated `<url> [descriptor]` list). */
function rewriteSrcset(srcset: string, basePath: string): string {
	return srcset
		.split(',')
		.map((entry) => {
			const trimmed = entry.trim()
			const spaceIdx = trimmed.search(/\s/)
			if (spaceIdx === -1) return rewriteUrl(trimmed, basePath)
			const url = trimmed.slice(0, spaceIdx)
			const descriptor = trimmed.slice(spaceIdx) // keeps leading whitespace + e.g. "2x"
			return rewriteUrl(url, basePath) + descriptor
		})
		.join(', ')
}

/**
 * Rewrite root-relative paths in an HTML document so it serves correctly from `basePath`.
 *
 * @param html         Raw HTML string.
 * @param basePath     Wisp serving prefix, e.g. `/did/rkey/`.
 * @param documentPath Storage path of this file — unused for path resolution but
 *                     kept in the signature for potential future use (e.g. logging).
 */
export function rewriteHtmlPaths(html: string, basePath: string, _documentPath: string): string {
	const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`

	const root = parse(html, {
		comment: true,
		blockTextElements: { script: true, style: true, pre: true, code: true },
	})

	// Rewrite <base href> so the browser uses the correct base at runtime for
	// JS fetch, form submits, dynamic navigation, etc.
	const baseEl = root.querySelector('base')
	if (baseEl) {
		const baseHref = baseEl.getAttribute('href')
		if (baseHref) {
			baseEl.setAttribute('href', rewriteUrl(baseHref, normalizedBase))
		}
	}

	for (const el of root.querySelectorAll('*')) {
		for (const [attr, type] of Object.entries(REWRITABLE_ATTRS)) {
			const value = el.getAttribute(attr)
			if (value == null) continue
			el.setAttribute(
				attr,
				type === 'srcset' ? rewriteSrcset(value, normalizedBase) : rewriteUrl(value, normalizedBase),
			)
		}
	}

	return root.toString()
}

/** Returns true for `.html` and `.htm` files. */
export function isHtmlFile(filepath: string): boolean {
	const ext = filepath.toLowerCase().split('.').pop()
	return ext === 'html' || ext === 'htm'
}
