/**
 * Share-link token generation and comparison.
 *
 * Share tokens are bearer credentials that travel in a URL query parameter. They are
 * therefore treated as secrets throughout: generated from a CSPRNG, stored only as a
 * sha256 hash, returned in plaintext exactly once at creation, compared in constant time,
 * and never logged.
 *
 * Note this intentionally diverges from the existing `webhook_secrets` table, which stores
 * its tokens in plaintext. A credential that appears in shareable URLs warrants
 * hash-at-rest; changing webhook secrets is out of scope for this change.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SHARE_TOKEN_PREFIX = 'wss_'

/**
 * Number of random bytes behind a share token. 16 bytes = 128 bits, which renders as 22
 * base64url characters.
 *
 * Sized for the URL bar as much as for the threat model. This token *is* the whole of
 * `wisp.place/p/<token>`, a link meant to be pasted into a chat message, so every byte
 * costs four characters someone has to look at. 128 bits stays far outside reach of online
 * guessing, and online guessing is the only attack available: the plaintext is never
 * stored, so there is nothing to grind offline.
 *
 * Tokens issued at the previous length keep working. They are matched by hash, not length.
 */
const SHARE_TOKEN_BYTES = 16

/**
 * Length of the non-secret display prefix kept alongside the hash.
 *
 * Only the owner ever sees this, and only to tell two of their own links apart. Kept to
 * roughly a quarter of the token so a leaked database still leaves ~96 bits unknown.
 */
const DISPLAY_PREFIX_LENGTH = 6

export interface GeneratedShareToken {
	/** Plaintext token. Return to the creator once, then discard. Never persist. */
	token: string
	/** Lowercase hex sha256 of `token`. This is what gets persisted. */
	tokenHash: string
	/** Short non-secret fragment for UI identification. */
	tokenPrefix: string
}

/** Generate a new share token plus its at-rest representation. */
export const generateShareToken = (): GeneratedShareToken => {
	const token = `${SHARE_TOKEN_PREFIX}${randomBytes(SHARE_TOKEN_BYTES).toString('base64url')}`
	return {
		token,
		tokenHash: hashShareTokenSync(token),
		tokenPrefix: token.slice(0, SHARE_TOKEN_PREFIX.length + DISPLAY_PREFIX_LENGTH),
	}
}

/** Lowercase hex sha256 of a share token. */
export const hashShareTokenSync = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * Constant-time comparison of two lowercase hex digests.
 *
 * Both inputs are hashes of equal length in practice, but length is checked first because
 * `timingSafeEqual` throws on a length mismatch. Comparing hashes (not raw tokens) means a
 * length-based early return cannot leak anything about the underlying secret.
 */
export const timingSafeEqualHex = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false
	try {
		return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
	} catch {
		return false
	}
}

/**
 * Render a share token safely for logs or errors.
 *
 * Always prefer logging a `shareId`. Use this only where a token-shaped value might
 * otherwise reach a log sink.
 */
export const redactToken = (token: string | null | undefined): string => {
	if (!token) return '<none>'
	return `${token.slice(0, SHARE_TOKEN_PREFIX.length)}<redacted:${token.length}>`
}

/** Strip the share-token query parameter from a URL string so it is safe to log. */
export const redactUrlForLog = (rawUrl: string, paramName: string): string => {
	try {
		const url = new URL(rawUrl)
		if (url.searchParams.has(paramName)) {
			url.searchParams.set(paramName, 'REDACTED')
		}
		return url.toString()
	} catch {
		return '<unparseable-url>'
	}
}
