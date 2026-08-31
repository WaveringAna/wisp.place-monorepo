/**
 * Rewrites root-relative URL attributes in an HTML document so it serves correctly
 * from a `basePath` (e.g. `/did/rkey/`) instead of the site root.
 *
 * Uses a byte-oriented tag scanner instead of a DOM parser so we can rewrite the
 * attributes we care about without reserializing the entire document. Raw-text
 * elements like `<script>` and `<style>` are copied through unchanged.
 */

const REWRITABLE_ATTRS: Record<string, 'url' | 'srcset'> = {
	src: 'url',
	href: 'url',
	action: 'url',
	data: 'url',
	poster: 'url',
	srcset: 'srcset',
}
const RAW_TEXT_TAGS = new Set(['script', 'style'])

function isRootRelative(url: string): boolean {
	if (!url?.startsWith('/')) return false
	// Protocol-relative (//cdn.example.com) — not a local path
	if (url.startsWith('//')) return false
	return true
}

function rewriteUrl(url: string, basePath: string): string {
	if (!isRootRelative(url)) return url
	if (url.startsWith(basePath)) return url
	const resolved = new URL(url, 'http://x')
	return basePath + resolved.pathname.slice(1) + resolved.search + resolved.hash
}

function rewriteSrcset(srcset: string, basePath: string): string {
	return srcset
		.split(',')
		.map((entry) => {
			const trimmed = entry.trim()
			const spaceIdx = trimmed.search(/\s/)
			if (spaceIdx === -1) return rewriteUrl(trimmed, basePath)
			const url = trimmed.slice(0, spaceIdx)
			const descriptor = trimmed.slice(spaceIdx)
			return rewriteUrl(url, basePath) + descriptor
		})
		.join(', ')
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rewriteTagAttributes(tagSource: string, basePath: string): string {
	return tagSource.replace(
		/\b(src|href|action|data|poster|srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
		(match, attr: string, _rawValue: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
			const value = doubleQuoted ?? singleQuoted ?? bare ?? ''
			const rewritten =
				REWRITABLE_ATTRS[attr.toLowerCase()] === 'srcset' ? rewriteSrcset(value, basePath) : rewriteUrl(value, basePath)
			if (rewritten === value) return match
			if (doubleQuoted !== undefined) return `${attr}="${rewritten}"`
			if (singleQuoted !== undefined) return `${attr}='${rewritten}'`
			return `${attr}=${rewritten}`
		},
	)
}

function rewriteHtmlPathsFallback(html: string, basePath: string): string {
	let output = ''
	let cursor = 0

	while (cursor < html.length) {
		const tagStart = html.indexOf('<', cursor)
		if (tagStart === -1) {
			output += html.slice(cursor)
			break
		}

		output += html.slice(cursor, tagStart)

		if (html.startsWith('<!--', tagStart)) {
			const commentEnd = html.indexOf('-->', tagStart + 4)
			if (commentEnd === -1) {
				output += html.slice(tagStart)
				break
			}
			output += html.slice(tagStart, commentEnd + 3)
			cursor = commentEnd + 3
			continue
		}

		const tagEnd = html.indexOf('>', tagStart + 1)
		if (tagEnd === -1) {
			output += html.slice(tagStart)
			break
		}

		const tagSource = html.slice(tagStart, tagEnd + 1)
		output += rewriteTagAttributes(tagSource, basePath)
		cursor = tagEnd + 1

		const tagNameMatch = /^<\s*([a-zA-Z][\w:-]*)/.exec(tagSource)
		const tagName = tagNameMatch?.[1]?.toLowerCase()
		const isSelfClosing = /\/\s*>$/.test(tagSource)
		if (!tagName || isSelfClosing || !RAW_TEXT_TAGS.has(tagName)) {
			continue
		}

		const closeTagPattern = new RegExp(`</\\s*${escapeRegExp(tagName)}\\s*>`, 'i')
		const remaining = html.slice(cursor)
		const closeMatch = closeTagPattern.exec(remaining)
		if (!closeMatch || closeMatch.index === undefined) {
			output += remaining
			break
		}

		const closeStart = cursor + closeMatch.index
		output += html.slice(cursor, closeStart)
		output += closeMatch[0]
		cursor = closeStart + closeMatch[0].length
	}

	return output
}

/**
 * Rewrite root-relative paths in an HTML document so it serves correctly from `basePath`.
 * Relative paths (`./foo`, `../foo`, bare filenames) are left alone — browsers resolve
 * them against the document URL, which already lives under `basePath`.
 */
export async function rewriteHtmlPaths(html: string, basePath: string): Promise<string> {
	const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`
	return rewriteHtmlPathsFallback(html, normalizedBase)
}

/** Returns true if the file looks like HTML by content-type or extension. */
export function isHtmlContent(filepath: string, contentType?: string): boolean {
	if (contentType?.includes('text/html')) return true
	const ext = filepath.toLowerCase().split('.').pop()
	return ext === 'html' || ext === 'htm'
}
