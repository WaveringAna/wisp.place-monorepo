import type { ClientMetadata } from '@atproto/oauth-client-node'
import { buildWispScopes, WISP_APP_PERMISSION_SETS } from '@wispplace/constants'

// `OAUTH_SCOPE` names the published `place.wisp.*` permission sets, so the
// consent screen reads "Manage your wisp.place sites" rather than listing six
// raw `repo:` values. `OAUTH_LEGACY_SCOPE` is the granular expansion of those
// same sets, used when an authorization server does not resolve permission
// sets. `OAUTH_CLIENT_SCOPE` is the union: a server rejects any requested scope
// value the client did not declare in its metadata, so both strategies have to
// be declared up front.
const wispScopes = buildWispScopes([...WISP_APP_PERMISSION_SETS])
export const OAUTH_SCOPE = wispScopes.preferred
export const OAUTH_LEGACY_SCOPE = wispScopes.legacy
const OAUTH_CLIENT_SCOPE = wispScopes.metadata

/**
 * Builds static OAuth client metadata without opening a database connection.
 * Keeping this module pure lets metadata endpoints and unit tests avoid the
 * OAuth state/session store and its primary database startup work.
 */
export const createClientMetadata = (
	config: {
		domain: `http://${string}` | `https://${string}`
		clientName: string
	},
	isLocalDev = Bun.env.LOCAL_DEV === 'true',
): ClientMetadata => {
	if (isLocalDev) {
		// Loopback client for local development
		// For loopback, scopes and redirect_uri must be in client_id query string
		const redirectUri = 'http://127.0.0.1:8000/api/auth/callback'
		const params = new URLSearchParams()
		params.append('redirect_uri', redirectUri)
		params.append('scope', OAUTH_CLIENT_SCOPE)

		return {
			client_id: `http://localhost?${params.toString()}`,
			client_name: config.clientName,
			client_uri: 'https://wisp.place',
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			application_type: 'web',
			token_endpoint_auth_method: 'none',
			scope: OAUTH_CLIENT_SCOPE,
			dpop_bound_access_tokens: false,
			subject_type: 'public',
			authorization_signed_response_alg: 'ES256',
		} as ClientMetadata
	}

	// Production client with private_key_jwt
	return {
		client_id: `${config.domain}/oauth-client-metadata.json`,
		client_name: config.clientName,
		client_uri: config.domain,
		logo_uri: `${config.domain}/logo.png`,
		tos_uri: `${config.domain}/tos`,
		policy_uri: `${config.domain}/policy`,
		redirect_uris: [`${config.domain}/api/auth/callback`],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		application_type: 'web',
		token_endpoint_auth_method: 'private_key_jwt',
		token_endpoint_auth_signing_alg: 'ES256',
		scope: OAUTH_CLIENT_SCOPE,
		dpop_bound_access_tokens: true,
		jwks_uri: `${config.domain}/jwks.json`,
		subject_type: 'public',
		authorization_signed_response_alg: 'ES256',
	} as ClientMetadata
}
