import type { NodeOAuthClient, OAuthSession } from '@atproto/oauth-client-node'
import { describeCapability, missingCapabilities, wispAppRequiredCapabilities } from '@wispplace/constants'
import { createLogger } from '@wispplace/observability'
import { OAUTH_LEGACY_SCOPE, OAUTH_SCOPE, recentGrantedScope } from './oauth-client'

const logger = createLogger('main-app')

/**
 * Marker carried through the OAuth `state` so a retry can not loop.
 *
 * `state` is opaque application state: the private-share flows put a JSON
 * object in it, plain logins put a UUID. Adding the marker keeps whatever was
 * there — a share redemption still resolves after a retry.
 */
const LEGACY_SCOPE_MARK = 'wispLegacyScope'

const parseState = (state: string | null | undefined): Record<string, unknown> | null => {
	if (!state) return null
	try {
		const parsed = JSON.parse(state)
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
	} catch {
		return null
	}
}

/** True when this callback belongs to a request that already fell back. */
export const isLegacyScopeState = (state: string | null | undefined): boolean =>
	parseState(state)?.[LEGACY_SCOPE_MARK] === true

const markLegacyScopeState = (state: string | null | undefined): string =>
	JSON.stringify({ ...(parseState(state) ?? {}), [LEGACY_SCOPE_MARK]: true })

/**
 * Strip the retry marker before handing `state` to code that expects the
 * original value.
 */
export const unmarkLegacyScopeState = (state: string | null | undefined): string | undefined => {
	const parsed = parseState(state)
	if (parsed?.[LEGACY_SCOPE_MARK] !== true) return state ?? undefined
	const { [LEGACY_SCOPE_MARK]: _mark, ...rest } = parsed
	return Object.keys(rest).length > 0 ? JSON.stringify(rest) : undefined
}

/**
 * Start an authorization request, preferring the published `place.wisp.*`
 * permission sets.
 *
 * An authorization server that cannot resolve them rejects the pushed request
 * with `invalid_scope`, so retry once with the granular expansion of the same
 * sets. Servers that predate permission sets entirely accept the request and
 * silently drop the `include:` values instead — that case is caught after the
 * callback by {@link missingGrantedCapabilities}.
 */
export const authorizeWisp = async (
	client: NodeOAuthClient,
	identifier: string,
	options: { state?: string } = {},
): Promise<URL> => {
	if (isLegacyScopeState(options.state)) {
		return await client.authorize(identifier, { ...options, scope: OAUTH_LEGACY_SCOPE })
	}

	try {
		return await client.authorize(identifier, { ...options, scope: OAUTH_SCOPE })
	} catch (err) {
		logger.warn('[Auth] Permission set scope rejected, retrying with granular scopes', {
			identifier,
			err: err instanceof Error ? err.message : String(err),
		})
		return await client.authorize(identifier, {
			...options,
			state: markLegacyScopeState(options.state),
			scope: OAUTH_LEGACY_SCOPE,
		})
	}
}

/**
 * Re-authorize with the granular scopes, keeping the original application
 * state so the post-login redirect still works.
 */
export const authorizeWispLegacy = async (
	client: NodeOAuthClient,
	identifier: string,
	state: string | null | undefined,
): Promise<URL> => await client.authorize(identifier, { state: markLegacyScopeState(state), scope: OAUTH_LEGACY_SCOPE })

/**
 * What main-app still can not do with the session it was just handed.
 *
 * The granted scope is always the granular expansion — the authorization
 * server rewrites `include:place.wisp.authSites` into the permissions the set
 * contains before minting the token — so this compares meaning, not strings.
 */
export const missingGrantedCapabilities = async (session: OAuthSession): Promise<string[]> => {
	try {
		// This process stored the session moments ago, so the scope is usually
		// already known. Asking the session for it instead would take the
		// cluster-wide advisory lock and read the primary to recover a value that
		// never changes for the life of the grant.
		const scope = recentGrantedScope(session.did) ?? (await session.getTokenInfo(false)).scope
		return missingCapabilities(scope, wispAppRequiredCapabilities()).map(describeCapability)
	} catch (err) {
		// Never block a login on an introspection failure.
		logger.warn('[Auth] Could not read granted scope', { err: err instanceof Error ? err.message : String(err) })
		return []
	}
}
