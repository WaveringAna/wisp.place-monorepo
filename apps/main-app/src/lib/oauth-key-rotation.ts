/**
 * OAuth client key rotation policy.
 *
 * Rotation adds a key under a new kid and never replaces an existing kid's key
 * material. Every main-app instance, and every authorization server that cached
 * our /jwks.json, keeps verifying the keys it already knows, so an instance that
 * has not reloaded yet still signs with a key the PDS can check.
 *
 * Superseded keys stay published. Sessions are bound to the kid they were
 * created with and refresh with that key, so retiring one ends those sessions;
 * that is a manual step, not a timer.
 */

export type StoredKeyInfo = { kid: string; createdAt: number }

/** A new key is added once the newest key is older than this. */
export const KEY_MAX_AGE_S = 182.5 * 24 * 60 * 60

/** A new key is published this long before any instance signs with it. */
export const KEY_PUBLISH_LEAD_S = 60 * 60

/** Newest first, ties broken by kid so every instance agrees on the order. */
const newestFirst = <T extends StoredKeyInfo>(keys: T[]): T[] =>
	[...keys].sort((a, b) => b.createdAt - a.createdAt || a.kid.localeCompare(b.kid))

/**
 * Orders keys for the client keyset. @atproto/oauth-client signs new sessions
 * with the first usable key, so the signing key goes first: the newest key that
 * has been published for at least KEY_PUBLISH_LEAD_S, or the newest key when
 * none has (a fresh install).
 */
export function signingOrder<T extends StoredKeyInfo>(keys: T[], now: number): T[] {
	const ordered = newestFirst(keys)
	const signer = ordered.find((k) => k.createdAt <= now - KEY_PUBLISH_LEAD_S) ?? ordered[0]
	return signer ? [signer, ...ordered.filter((k) => k !== signer)] : []
}

export function needsRotation(keys: StoredKeyInfo[], now: number): boolean {
	const newest = newestFirst(keys)[0]
	return !newest || newest.createdAt < now - KEY_MAX_AGE_S
}

/** A kid that has never been used: the date plus random suffix. */
export function newKid(now: number): string {
	const day = new Date(now * 1000).toISOString().slice(0, 10).replaceAll('-', '')
	return `key-${day}-${crypto.randomUUID().slice(0, 8)}`
}
