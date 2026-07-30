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
