import { documentRkeyForPath } from './publication'
import { STANDARD_SITE_DOCUMENT_COLLECTION } from './types'

export function buildStandardDocumentUri(did: string, path: string): string {
	return `at://${did}/${STANDARD_SITE_DOCUMENT_COLLECTION}/${documentRkeyForPath(path)}`
}

export function injectStandardSiteDocumentLink(
	html: string,
	documentUri: string,
): {
	html: string
	changed: boolean
} {
	const linkTag = `<link rel="site.standard.document" href="${escapeHtmlAttribute(documentUri)}" />`
	const existingLinkPattern = /<link\b(?=[^>]*\brel\s*=\s*["'][^"']*\bsite\.standard\.document\b[^"']*["'])[^>]*>/i

	if (existingLinkPattern.test(html)) {
		const rewritten = html.replace(existingLinkPattern, linkTag)
		return {
			html: rewritten,
			changed: rewritten !== html,
		}
	}

	const headClosePattern = /<\/head\s*>/i
	if (!headClosePattern.test(html)) {
		return { html, changed: false }
	}

	return {
		html: html.replace(headClosePattern, `\t\t${linkTag}\n\t</head>`),
		changed: true,
	}
}

function escapeHtmlAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
