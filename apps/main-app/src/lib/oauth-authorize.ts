import type { NodeOAuthClient, OAuthSession } from '@atproto/oauth-client-node'
import {
	describeCapability,
	MARQUE_DNS_SETUP_SCOPES,
	marqueDnsCapabilities,
	missingCapabilities,
	previewSetupCapabilities,
	TANGLED_PREVIEW_SETUP_SCOPES,
	type WispCapability,
	wispAppRequiredCapabilities,
} from '@wispplace/constants'
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

/**
 * Permissions a user grants on top of the usual sets, one feature at a time,
 * so an ordinary sign-in never asks for them.
 */
const ADD_ONS = {
	/** Set deploy secrets on tangled spindles for pull-request previews. */
	ci: { scopes: TANGLED_PREVIEW_SETUP_SCOPES, capabilities: previewSetupCapabilities, tab: 'cli' },
	/** Add a custom domain's records to its marque.at zone. */
	marque: { scopes: MARQUE_DNS_SETUP_SCOPES, capabilities: marqueDnsCapabilities, tab: 'domains' },
} as const satisfies Record<string, { scopes: readonly string[]; capabilities: () => WispCapability[]; tab: string }>

export type ScopeAddOn = keyof typeof ADD_ONS

const SCOPE_ADD_ONS = Object.keys(ADD_ONS) as ScopeAddOn[]

export const isScopeAddOn = (value: unknown): value is ScopeAddOn => SCOPE_ADD_ONS.includes(value as ScopeAddOn)

/** Marks a sign-in started to grant an add-on: it names the add-on and every one the request asks for. */
const SETUP_MARK = 'wispSetup'
const ADD_ONS_MARK = 'wispAddOns'

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

/** The add-on a sign-in was started to grant, if any. */
export const setupAddOn = (state: string | null | undefined): ScopeAddOn | null => {
	const addOn = parseState(state)?.[SETUP_MARK]
	return isScopeAddOn(addOn) ? addOn : null
}

/** The dashboard tab a sign-in for this add-on lands back on. */
export const setupTab = (addOn: ScopeAddOn): string => ADD_ONS[addOn].tab

/**
 * State for a sign-in that grants `addOn`. A new grant replaces the old one, so
 * it asks again for the add-ons the session already holds. `extra` rides along
 * for the callback; the nonce keeps every request's state distinct.
 */
export const setupState = (
	addOn: ScopeAddOn,
	held: readonly ScopeAddOn[],
	extra: Record<string, string> = {},
): string =>
	JSON.stringify({
		...extra,
		[SETUP_MARK]: addOn,
		[ADD_ONS_MARK]: [...new Set([...held, addOn])],
		nonce: crypto.randomUUID(),
	})

/** A string value carried in `state` by {@link setupState}. */
export const stateValue = (state: string | null | undefined, key: string): string | undefined => {
	const value = parseState(state)?.[key]
	return typeof value === 'string' ? value : undefined
}

const requestedAddOns = (state: string | null | undefined): ScopeAddOn[] => {
	const addOns = parseState(state)?.[ADD_ONS_MARK]
	return Array.isArray(addOns) ? addOns.filter(isScopeAddOn) : []
}

const withAddOns = (scope: string, state: string | null | undefined): string =>
	[scope, ...requestedAddOns(state).flatMap((addOn) => ADD_ONS[addOn].scopes)].join(' ')

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
		return await client.authorize(identifier, { ...options, scope: withAddOns(OAUTH_LEGACY_SCOPE, options.state) })
	}

	try {
		return await client.authorize(identifier, { ...options, scope: withAddOns(OAUTH_SCOPE, options.state) })
	} catch (err) {
		logger.warn('[Auth] Permission set scope rejected, retrying with granular scopes', {
			identifier,
			err: err instanceof Error ? err.message : String(err),
		})
		return await client.authorize(identifier, {
			...options,
			state: markLegacyScopeState(options.state),
			scope: withAddOns(OAUTH_LEGACY_SCOPE, options.state),
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
): Promise<URL> =>
	await client.authorize(identifier, {
		state: markLegacyScopeState(state),
		scope: withAddOns(OAUTH_LEGACY_SCOPE, state),
	})

const grantedScope = async (session: OAuthSession): Promise<string | undefined> =>
	recentGrantedScope(session.did) ?? (await session.getTokenInfo(false)).scope

/** The add-ons this session was granted. Never throws: unknown means none. */
export const grantedAddOns = async (session: OAuthSession): Promise<ScopeAddOn[]> => {
	try {
		const scope = await grantedScope(session)
		return SCOPE_ADD_ONS.filter((addOn) => missingCapabilities(scope, ADD_ONS[addOn].capabilities()).length === 0)
	} catch {
		return []
	}
}

/** Whether this session may set a deploy secret on a spindle. */
export const canSetSpindleSecrets = async (session: OAuthSession): Promise<boolean> =>
	(await grantedAddOns(session)).includes('ci')

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
		const scope = await grantedScope(session)
		return missingCapabilities(scope, wispAppRequiredCapabilities()).map(describeCapability)
	} catch (err) {
		// Never block a login on an introspection failure.
		logger.warn('[Auth] Could not read granted scope', { err: err instanceof Error ? err.message : String(err) })
		return []
	}
}
