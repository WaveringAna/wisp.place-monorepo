/**
 * Rewrites root-relative URL attributes in an HTML document so it serves correctly
 * from a `basePath` (e.g. `/did/rkey/`) instead of the site root.
 *
 * Uses Bun's streaming `HTMLRewriter`: only the attribute bytes we target are replaced;
 * everything else (text, inline `<script>`/`<style>`, custom elements like `<md-block>`,
 * unbalanced markup, HTML-looking content inside Markdown code spans) passes through
 * byte-for-byte. No DOM construction, no re-serialisation.
 */

const REWRITABLE_ATTRS: Record<string, 'url' | 'srcset'> = {
	src: 'url',
	href: 'url',
	action: 'url',
	data: 'url',
	poster: 'url',
	srcset: 'srcset',
}

function isRootRelative(url: string): boolean {
	if (!url || !url.startsWith('/')) return false
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

/**
 * Rewrite root-relative paths in an HTML document so it serves correctly from `basePath`.
 * Relative paths (`./foo`, `../foo`, bare filenames) are left alone — browsers resolve
 * them against the document URL, which already lives under `basePath`.
 */
export async function rewriteHtmlPaths(html: string, basePath: string): Promise<string> {
	const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`

	const rewriter = new HTMLRewriter().on('*', {
		element(el) {
			for (const [attr, type] of Object.entries(REWRITABLE_ATTRS)) {
				const value = el.getAttribute(attr)
				if (value == null) continue
				el.setAttribute(
					attr,
					type === 'srcset' ? rewriteSrcset(value, normalizedBase) : rewriteUrl(value, normalizedBase),
				)
			}
		},
	})

	return await rewriter.transform(new Response(html)).text()
}

/** Returns true if the file looks like HTML by content-type or extension. */
export function isHtmlContent(filepath: string, contentType?: string): boolean {
	if (contentType?.includes('text/html')) return true
	const ext = filepath.toLowerCase().split('.').pop()
	return ext === 'html' || ext === 'htm'
}
