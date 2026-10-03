import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression'

/**
 * Rules that decide how a manifest file is stored. They are shared by the cache writer and by the
 * migration that re-keys existing objects, which must reproduce the writer's decisions exactly.
 */

const TEXT_LIKE_MIME_TYPES = new Set([
	'text/html',
	'text/css',
	'text/javascript',
	'application/javascript',
	'application/json',
	'application/xml',
	'image/svg+xml',
])
const TEXT_LIKE_PATH_SUFFIXES = ['.html', '.htm', '.css', '.js', '.json', '.xml', '.svg']

export function isRedirectsFile(filePath: string): boolean {
	return filePath === '_redirects'
}

export function isTextLikeMime(mimeType?: string, path?: string): boolean {
	if (mimeType && TEXT_LIKE_MIME_TYPES.has(mimeType)) return true
	if (!path) return false
	const lowerPath = path.toLowerCase()
	return (
		lowerPath === '_redirects' ||
		lowerPath.endsWith('/_redirects') ||
		TEXT_LIKE_PATH_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix))
	)
}

/** Whether a gzip file keeps its compression when stored; others are stored decompressed. */
export function shouldStayCompressed(path: string, mimeType: string | undefined): boolean {
	return !isRedirectsFile(path) && shouldCompressMimeType(mimeType)
}
