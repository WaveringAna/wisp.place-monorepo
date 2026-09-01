import type { Did } from '@atproto/api'
import type { NodeOAuthClient, OAuthSession } from '@atproto/oauth-client-node'
import { countCookieOccurrences } from '@wispplace/private-sites'
import type { Cookie } from 'elysia'
import { logger } from './logger'

// __Host- prevents user-content subdomains from tossing a competing account cookie.
export const SESSION_COOKIE_NAME = process.env.NODE_ENV === 'production' ? '__Host-did' : 'did'

export interface AuthenticatedContext {
	did: Did
	session: OAuthSession
}

/**
 * How long one restored session answers further requests from the same DID.
 *
 * `client.restore` takes a cluster-wide Postgres advisory lock and reads
 * `oauth_sessions`, both on the primary. From a region that is a few hundred
 * milliseconds from the primary that is roughly three serialized round trips
 * per request, and because every request for one user contends on the same lock
 * name they could not overlap: opening the editor fires seven API calls plus one
 * per site, and they queued behind each other.
 *
 * This caches only the answer to "does this DID have a live session", which is
 * all most routes need. It does not cache tokens: the session object still
 * resolves its token set through the lock on every call it makes to a PDS, so
 * refresh-token rotation stays serialized cluster-wide. The cost is that a
 * session revoked on another node keeps answering here until the entry lapses.
 */
const SESSION_CACHE_TTL_MS = 30_000
const SESSION_CACHE_MAX = 2_000

interface SessionCacheEntry {
	pending: Promise<AuthenticatedContext | null>
	expiresAt: number
}

const sessionCache = new Map<string, SessionCacheEntry>()

const dropEntry = (did: string, entry: SessionCacheEntry): void => {
	// Only drop our own entry; a later request may already have replaced it.
	if (sessionCache.get(did) === entry) sessionCache.delete(did)
}

/**
 * Restore a session, collapsing concurrent requests for the same DID.
 *
 * The in-flight promise is what gets cached, not just its result. A cold page
 * load arrives as a burst of parallel requests, and without this they would all
 * miss and then serialize on the advisory lock one after another.
 */
const restoreSession = (client: NodeOAuthClient, did: Did): Promise<AuthenticatedContext | null> => {
	const now = Date.now()
	const cached = sessionCache.get(did)
	if (cached && cached.expiresAt > now) {
		sessionCache.delete(did)
		sessionCache.set(did, cached)
		return cached.pending
	}

	const entry: SessionCacheEntry = {
		expiresAt: now + SESSION_CACHE_TTL_MS,
		pending: client.restore(did, 'auto').then(
			(session) => {
				// A DID with no session must not stay cached as a negative answer:
				// the user may be signing in right now.
				if (!session) dropEntry(did, entry)
				return session ? { did, session } : null
			},
			(err) => {
				dropEntry(did, entry)
				throw err
			},
		),
	}

	sessionCache.delete(did)
	if (sessionCache.size >= SESSION_CACHE_MAX) {
		// Insertion-ordered, and every hit re-inserts, so this is the oldest.
		const oldest = sessionCache.keys().next()
		if (!oldest.done) sessionCache.delete(oldest.value)
	}
	sessionCache.set(did, entry)
	return entry.pending
}

/** Forget a cached session. Call this whenever a session is revoked here. */
export const invalidateSessionCache = (did: string): void => {
	sessionCache.delete(did)
}

/** Forget every cached session. */
export const clearSessionCache = (): void => {
	sessionCache.clear()
}

export const authenticateRequest = async (
	client: NodeOAuthClient,
	cookies: Record<string, Cookie<unknown>>,
	rawCookieHeader?: string | null,
): Promise<AuthenticatedContext | null> => {
	try {
		if (rawCookieHeader !== undefined && countCookieOccurrences(rawCookieHeader, SESSION_COOKIE_NAME) > 1) {
			return null
		}

		const did = cookies[SESSION_COOKIE_NAME]?.value as Did
		if (!did) return null

		return await restoreSession(client, did)
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
