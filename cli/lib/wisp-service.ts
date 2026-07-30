export const DEFAULT_WISP_SERVICE_DID = 'did:web:wisp.place'
export const WISP_PROXY_SERVICE_ID = 'wisp_xrpc'

export const WISP_OAUTH_BASE_SCOPES = [
	'atproto',
	'repo:place.wisp.fs',
	'repo:place.wisp.subfs',
	'repo:place.wisp.settings',
	'blob:*/*',
] as const

export const WISP_SERVICE_LXMS = [
	'place.wisp.v2.domain.addSite',
	'place.wisp.v2.domain.claim',
	'place.wisp.v2.domain.claimSubdomain',
	'place.wisp.v2.domain.delete',
	'place.wisp.v2.domain.getList',
	'place.wisp.v2.domain.getStatus',
	'place.wisp.v2.site.delete',
	'place.wisp.v2.site.getList',
] as const

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

function buildRpcScope(aud: string, lxm: string): string {
	return `rpc:${lxm}?aud=${aud}`
}

export function buildWispRpcScopes(): string[] {
	return WISP_SERVICE_LXMS.map((lxm) => buildRpcScope('*', lxm))
}

export function buildWispOAuthScopes(): string[] {
	return [...WISP_OAUTH_BASE_SCOPES, ...buildWispRpcScopes()]
}

export const WISP_OAUTH_SCOPE = buildWispOAuthScopes().join(' ')
