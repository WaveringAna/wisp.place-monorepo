/**
 * Site-scoped access grants for private sites.
 *
 * A credential presented in a URL (a share token, or a one-time owner handoff token) is
 * exchanged once for a **site-scoped session cookie** set on that site's own origin. Every
 * later request — including CSS, scripts, images, and navigation — carries that cookie
 * automatically, and the URL is redirected clean so the credential stops travelling in
 * query strings.
 *
 * This exists because a raw query-parameter credential authorizes only the single request
 * that carries it: relative subresources do not inherit a query string, so they would
 * arrive unauthenticated.
 *
 * The session cookie is deliberately:
 *   - host-only (no Domain attribute), so it is scoped to one private site's origin
 *   - short-lived, with the expiry enforced server-side rather than trusted from the client
 *   - backed by a database row, so revoking a share or deleting a site kills live sessions
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { PRIVATE_SHARE_QUERY_PARAM } from '@wispplace/constants'

/**
 * Cookie name for the per-site private session over plain http (local development).
 * Host-only by design.
 */
export const PRIVATE_SESSION_COOKIE = 'wsps'

/**
 * Cookie name for the per-site private session over https.
 *
 * The `__Host-` prefix makes the browser itself enforce the isolation this cookie
 * depends on: it may only ever be set by the site's own host, with `Secure`, `Path=/`,
 * and no `Domain` attribute. A page on one private site can otherwise toss a
 * `Domain=priv.<base>` cookie with this name into a visitor's jar, where it would be
 * sent to *every* private site — poisoning or shadowing the real session cookie
 * (RFC 6265 sends the older cookie first, and duplicate names are a parser-ordering
 * trap). With the prefix, such a Set-Cookie is rejected at the browser, and the
 * attacker's page cannot even create the forgery.
 */
export const PRIVATE_SESSION_COOKIE_SECURE = '__Host-wsps'

/** The session cookie name for the current request's transport security. */
export const sessionCookieName = (secure: boolean): string =>
	secure ? PRIVATE_SESSION_COOKIE_SECURE : PRIVATE_SESSION_COOKIE

/** Query parameter carrying a one-time owner handoff token. */
export const PRIVATE_GRANT_QUERY_PARAM = 'g'

/** How long an exchanged site session stays valid before it must be re-established. */
export const PRIVATE_SESSION_TTL_MINUTES = 60

/**
 * How long a one-time handoff token stays usable.
 *
 * Short, because it only has to survive one redirect. Not *so* short that a slow network,
 * a click-later habit, or a link preview fetch turns a working link into a 404.
 * Single-use consumption is what actually bounds the risk here; the clock is a backstop.
 */
export const OWNER_HANDOFF_TTL_SECONDS = 5 * 60

export type GrantKind = 'owner' | 'share'

export interface PrivateSessionRecord {
	sessionId: string
	siteId: string
	kind: GrantKind
	/** Set when `kind` is `owner`. The DID the session was issued to. */
	ownerDid: string | null
	/** Set when `kind` is `share`. Lets share revocation invalidate live sessions. */
	shareId: string | null
	expiresAt: Date
	createdAt: Date
}

export interface GeneratedSecret {
	/** Plaintext value. Goes to the client once; never persisted in this form. */
	value: string
	/** Lowercase hex sha256 of `value`. This is what gets stored. */
	hash: string
}

const generate = (prefix: string, bytes = 32): GeneratedSecret => {
	const value = `${prefix}${randomBytes(bytes).toString('base64url')}`
	return { value, hash: hashSecret(value) }
}

export const hashSecret = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** Mint a per-site session secret, stored hashed. */
export const generateSessionSecret = (): GeneratedSecret => generate('wsx_')

/** Mint a single-use owner handoff token, stored hashed. */
export const generateHandoffSecret = (): GeneratedSecret => generate('wsh_')

/** Constant-time comparison of two lowercase hex digests. */
export const secretsMatch = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false
	try {
		return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
	} catch {
		return false
	}
}

/**
 * Per-site hostname: `<siteId>.priv.<baseHost>`.
 *
 * Each private site gets its own origin so that one tenant's JavaScript cannot read another
 * tenant's content, and so a session cookie for one site is never sent to another.
 */
export const privateSiteHostname = (siteId: string, privateHost: string): string => `${siteId}.${privateHost}`

/**
 * Extract the site id from a per-site private hostname.
 *
 * Returns null when the host is not exactly one label below the private host, so neither
 * the bare private host nor a deeper nested name resolves to a site.
 */
export const siteIdFromHostname = (hostname: string, privateHost: string): string | null => {
	const suffix = `.${privateHost}`
	if (!hostname.endsWith(suffix)) return null
	const label = hostname.slice(0, -suffix.length)
	if (label.length === 0 || label.includes('.')) return null
	return label
}

/** Per-site origin URL. Opening it without a credential yields a 404. */
export const privateSiteUrl = (siteId: string, privateHost: string, scheme: 'http' | 'https'): string =>
	`${scheme}://${privateSiteHostname(siteId, privateHost)}/`

/**
 * One-time entry URL carrying a handoff token for a site's own origin.
 *
 * Used both for an owner crossing over from main-app and for a DID-scoped share redeemed
 * through the identity bounce.
 */
export const privateGrantUrlFor = (siteUrl: string, handoff: string): string =>
	`${siteUrl}?${PRIVATE_GRANT_QUERY_PARAM}=${encodeURIComponent(handoff)}`

/**
 * Share URL for a site origin. Carries the credential, so it is returned once, never
 * logged, and never persisted in this form.
 */
export const privateShareLinkUrl = (siteUrl: string, token: string): string =>
	`${siteUrl}?${PRIVATE_SHARE_QUERY_PARAM}=${encodeURIComponent(token)}`

/** Attributes for the site-scoped session cookie. No `Domain`, so it stays host-only. */
export const buildSessionCookie = (value: string, secure: boolean, maxAgeSeconds: number): string => {
	const parts = [
		`${sessionCookieName(secure)}=${value}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Lax',
		`Max-Age=${maxAgeSeconds}`,
	]
	if (secure) parts.push('Secure')
	return parts.join('; ')
}

/** Expired cookie used to clear a session. */
export const clearSessionCookie = (secure: boolean): string => buildSessionCookie('', secure, 0)
