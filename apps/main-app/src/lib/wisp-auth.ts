import type { Did } from '@atproto/api'
import type { NodeOAuthClient, OAuthSession } from '@atproto/oauth-client-node'
import type { Cookie } from 'elysia'
import { logger } from './logger'

/**
 * Name of the signed account session cookie.
 *
 * Production uses the `__Host-` prefix so the browser itself refuses the cookie when it
 * is set with a `Domain` attribute. That is what stops cookie tossing from user-content
 * subdomains (`*.priv.wisp.place`, `sites.wisp.place`, claimed `*.wisp.place` domains):
 * a page on any of those origins can otherwise plant a `Domain=wisp.place` cookie named
 * `did`, and RFC 6265 ordering (oldest first) combined with first-wins parsing lets the
 * tossed cookie shadow the real one — a login CSRF where the victim browses as the
 * attacker.
 *
 * `__Host-` requires `Secure`, which local http development cannot offer, so the
 * unprefixed name is kept outside production. The duplicate-cookie guard below covers
 * the development topology instead.
 */
export const SESSION_COOKIE_NAME = process.env.NODE_ENV === 'production' ? '__Host-did' : 'did'

export interface AuthenticatedContext {
	did: Did
	session: OAuthSession
}

/**
 * Count how many times a cookie name appears in a raw `Cookie` header.
 *
 * Browsers are the only realistic source of duplicate names, and a duplicate account
 * cookie is exactly what a cookie-tossing attack produces. Failing closed on any
 * duplicate removes the parser-ordering question (first-wins vs last-wins) entirely.
 */
export const countCookieOccurrences = (header: string | null | undefined, name: string): number => {
	if (!header) return 0
	let count = 0
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq === -1) continue
		if (part.slice(0, eq).trim() === name) count += 1
	}
	return count
}

export const authenticateRequest = async (
	client: NodeOAuthClient,
	cookies: Record<string, Cookie<unknown>>,
	rawCookieHeader?: string | null,
): Promise<AuthenticatedContext | null> => {
	try {
		// More than one cookie carrying the session name means the jar was tampered with
		// (e.g. a Domain-scoped cookie tossed from a sibling subdomain). Refuse to pick one.
		if (rawCookieHeader !== undefined && countCookieOccurrences(rawCookieHeader, SESSION_COOKIE_NAME) > 1) {
			return null
		}

		const did = cookies[SESSION_COOKIE_NAME]?.value as Did
		if (!did) return null

		const session = await client.restore(did, 'auto')
		return session ? { did, session } : null
	} catch (err) {
		logger.error('[Auth] Authentication error', err)
		return null
	}
}

export const requireAuth = async (
	client: NodeOAuthClient,
	cookies: Record<string, Cookie<unknown>>,
	rawCookieHeader?: string | null,
): Promise<AuthenticatedContext> => {
	const auth = await authenticateRequest(client, cookies, rawCookieHeader)
	if (!auth) {
		throw new Error('Authentication required')
	}
	return auth
}
