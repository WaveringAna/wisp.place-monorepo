import { buildWispScopes, WISP_CLI_PERMISSION_SETS, WISP_HOSTING_LXMS } from '@wispplace/constants'

export const DEFAULT_WISP_SERVICE_DID = 'did:web:wisp.place'
export const WISP_PROXY_SERVICE_ID = 'wisp_xrpc'

/** XRPC methods the CLI reaches through the hosting service proxy. */
export const WISP_SERVICE_LXMS = WISP_HOSTING_LXMS

function isDid(value: string): value is `did:${string}:${string}` {
	if (!value.startsWith('did:')) {
		return false
	}

	if (value.length < 8) {
		return false
	}

	if (value.includes('#') || /\s/.test(value)) {
		return false
	}

	const methodSeparator = value.indexOf(':', 4)
	if (methodSeparator <= 4 || methodSeparator >= value.length - 1) {
		return false
	}

	return true
}

export function parseServiceDid(input?: string): `did:${string}:${string}` {
	const value = (input?.trim() || DEFAULT_WISP_SERVICE_DID).trim()

	if (!isDid(value)) {
		throw new Error(`Invalid --service value "${value}". Expected did:...`)
	}

	return value
}

const WISP_CLI_SCOPES = buildWispScopes([...WISP_CLI_PERMISSION_SETS])

/**
 * Scope the CLI asks for: one `include:` per published permission set, so the
 * consent screen shows "Manage your wisp.place sites" instead of a wall of
 * `repo:`/`rpc:` values.
 */
export const WISP_OAUTH_SCOPE = WISP_CLI_SCOPES.preferred

/**
 * The granular expansion of those sets. Authorization servers that support
 * granular scopes but not permission sets ignore an unknown `include:` value
 * and hand back a session with no permissions at all, so the login flow falls
 * back to this.
 */
export const WISP_OAUTH_LEGACY_SCOPE = WISP_CLI_SCOPES.legacy
