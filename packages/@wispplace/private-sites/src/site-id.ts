/**
 * Private site identifiers, storage-key namespacing, and response hardening.
 */

import { randomBytes } from 'node:crypto'

/**
 * Storage key prefix for private site content.
 *
 * Public site files live at `${did}/${rkey}/${path}`, where the first segment always
 * begins with `did:`. Private files live under this prefix instead, so the two key spaces
 * cannot collide and a public request cannot address private bytes. Enforced by test.
 */
export const PRIVATE_STORAGE_PREFIX = 'private'

const SITE_ID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz'
const SITE_ID_LENGTH = 13

/**
 * Generate a TID-shaped private site id.
 *
 * Constrained to record-key syntax so that it can be reused unchanged as a permissioned
 * space key (`skey`) under atproto proposal 0016, which specifies skeys as "analogous to a
 * record key". Keeping this migration-compatible is why the id is not a UUID or a
 * database serial.
 */
export const generateSiteId = (): string => {
	const bytes = randomBytes(SITE_ID_LENGTH)
	let out = ''
	for (let i = 0; i < SITE_ID_LENGTH; i += 1) {
		out += SITE_ID_ALPHABET[bytes[i]! % SITE_ID_ALPHABET.length]
	}
	return out
}

/** Validate a private site id. Rejects anything that could escape the key namespace. */
export const isValidSiteId = (siteId: string): boolean => {
	if (siteId.length !== SITE_ID_LENGTH) return false
	for (const ch of siteId) {
		if (!SITE_ID_ALPHABET.includes(ch)) return false
	}
	return true
}

/**
 * Build the tiered-storage key for a private site file.
 *
 * Throws on an invalid id rather than returning a possibly-traversing key, so a malformed
 * id can never be turned into a storage read.
 */
export const buildPrivateStorageKey = (siteId: string, filePath: string): string => {
	if (!isValidSiteId(siteId)) {
		throw new Error('invalid private site id')
	}
	const normalized = filePath.replace(/^\/+/, '')
	return `${PRIVATE_STORAGE_PREFIX}/${siteId}/${normalized}`
}

/**
 * Response headers applied to every private-site response.
 *
 * - `no-store` keeps private bytes out of shared and browser caches
 * - `no-referrer` stops the share token in the URL leaking to outbound links
 * - `noindex` keeps private sites out of search indexes
 */
export const privateResponseHeaders = (): Record<string, string> => ({
	'Cache-Control': 'no-store, no-cache, must-revalidate, private',
	Pragma: 'no-cache',
	'Referrer-Policy': 'no-referrer',
	'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
})
