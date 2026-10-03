import type { FileObjects } from '@wispplace/fs-utils'

/** What hosting knows about a site's files: the manifest CIDs and where each body lives in storage. */
export interface SiteManifest {
	readonly fileCids: Record<string, string>
	/** path -> CAS key. A manifest path with no entry has no stored body yet (see resolveStorageKey). */
	readonly fileObjects: FileObjects | null
}

const REWRITTEN_PREFIX = '.rewritten/'

function stripLeadingSlash(path: string): string {
	return path.startsWith('/') ? path.slice(1) : path
}

/**
 * Pre-rewritten HTML embeds the site's own path prefix, so it cannot be shared by content and lives
 * per site, under `{did}/{rkey}/.rewritten/{path}`.
 */
export function rewrittenStorageKey(did: string, rkey: string, path: string): string {
	return `${did}/${rkey}/${REWRITTEN_PREFIX}${stripLeadingSlash(path)}`
}

/**
 * Where the body for one path is stored, or null when the site has no stored body for it (not yet
 * converted, or mid-update). Callers treat null exactly like a missing object, which is a repair
 * request and never a read of some other key. Everything except pre-rewritten HTML comes from the
 * site's own `file_objects`.
 */
export function resolveStorageKey(
	did: string,
	rkey: string,
	filePath: string,
	fileObjects: FileObjects | null,
): string | null {
	const path = stripLeadingSlash(filePath)
	if (path.startsWith(REWRITTEN_PREFIX)) return rewrittenStorageKey(did, rkey, path.slice(REWRITTEN_PREFIX.length))
	// Own-property only: manifest paths are user data, so "constructor" must not find Object.prototype's.
	if (fileObjects && Object.getOwnPropertyDescriptor(fileObjects, path) !== undefined) {
		return fileObjects[path] as string
	}
	return null
}
