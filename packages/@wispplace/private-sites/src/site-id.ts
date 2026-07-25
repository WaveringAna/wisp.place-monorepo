/**
 * Private site identifiers, storage-key namespacing, and response hardening.
 */

import { randomBytes } from 'node:crypto'
import { ADJECTIVES, ANIMALS, NOUNS } from './wordlist'

/**
 * Storage key prefix for private site content.
 *
 * Public site files live at `${did}/${rkey}/${path}`, where the first segment always
 * begins with `did:`. Private files live under this prefix instead, so the two key spaces
 * cannot collide and a public request cannot address private bytes. Enforced by test.
 */
export const PRIVATE_STORAGE_PREFIX = 'private'

/**
 * Site ids read as `lovable-plushie-dog-1226`: three words and four digits.
 *
 * Readable rather than random because the id is the site's hostname, and a person has to
 * recognise and say it. It is deliberately *not* a secret — the share token in the query
 * parameter is the only credential, and an unguessable hostname was never what kept a
 * private site private. Guessing a name still yields a 404 without a token.
 *
 * The shape stays record-key-compatible (lowercase letters, digits, hyphens, under 512
 * characters) so it can be reused unchanged as a permissioned space key under atproto
 * proposal 0016. It is also a valid DNS label: no leading or trailing hyphen, and short
 * enough for the 63-character limit.
 */
const SITE_ID_SUFFIX_DIGITS = 4
const SITE_ID_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}-[0-9]{4}$/

/** Uniform random index into a list, rejecting the biased tail of the byte range. */
const randomIndex = (length: number): number => {
	const limit = Math.floor(256 / length) * length
	for (;;) {
		const byte = randomBytes(1)[0]!
		if (byte < limit) return byte % length
	}
}

const pick = <T>(list: readonly T[]): T => list[randomIndex(list.length)]!

/** Generate a readable private site id. */
export const generateSiteId = (): string => {
	let digits = ''
	for (let i = 0; i < SITE_ID_SUFFIX_DIGITS; i += 1) digits += randomIndex(10)
	return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${pick(ANIMALS)}-${digits}`
}

const RECORD_ID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz'
const RECORD_ID_LENGTH = 13

/**
 * Generate an opaque internal row id, e.g. for a share, session, or handoff row.
 *
 * These are database keys rather than hostnames, so they stay short and opaque instead of
 * borrowing the readable site-id shape. They are not credentials either: the matching
 * secret is always stored separately as a hash.
 */
export const generateRecordId = (): string => {
	const bytes = randomBytes(RECORD_ID_LENGTH)
	let out = ''
	for (let i = 0; i < RECORD_ID_LENGTH; i += 1) {
		out += RECORD_ID_ALPHABET[bytes[i]! % RECORD_ID_ALPHABET.length]
	}
	return out
}

/**
 * Validate a private site id.
 *
 * Rejects anything that could escape the storage key namespace or address a different
 * host: no dots, no slashes, no uppercase, no leading or trailing hyphen.
 */
export const isValidSiteId = (siteId: string): boolean => {
	if (siteId.length > 63) return false
	return SITE_ID_PATTERN.test(siteId)
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
