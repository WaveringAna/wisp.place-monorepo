/**
 * AT Protocol OAuth permission sets for the `place.wisp.*` namespace.
 *
 * Background: atproto replaced the coarse `transition:*` scopes with granular
 * `repo:`/`rpc:`/`blob:` scopes, and then added *permission sets* on top — a
 * Lexicon document of type `permission-set` that bundles granular permissions
 * behind one human-readable name. A client asks for a set with
 * `include:<nsid>`; the authorization server resolves `<nsid>` through Lexicon
 * resolution (DNS `_lexicon.<authority>` -> a repo -> the
 * `com.atproto.lexicon.schema` record whose rkey is the NSID), shows the set's
 * `title`/`detail` on the consent screen, and *expands* the `include:` value
 * into the underlying granular scopes before minting the token.
 *
 * Two consequences drive the design of this file:
 *
 *  1. The access token's granted `scope` contains the **expanded** granular
 *     scopes, never the `include:` value we asked for. So a client can not
 *     check "did I get what I asked for" with string equality against the
 *     requested scope — it has to check semantically. That is what
 *     {@link missingCapabilities} is for.
 *  2. An authorization server that supports granular scopes but predates
 *     permission sets will silently ignore an unknown `include:` value and
 *     hand back a session with none of the permissions. Clients therefore keep
 *     the pre-expansion scope string around ({@link expandPermissionSets}) and
 *     retry with it when the granted scope comes back short.
 *
 * Permission sets may only reference NSIDs under their own authority
 * (`place.wisp.*` here), and may only contain `repo`/`rpc` permissions —
 * `atproto` and the wildcard `blob:` scope always have to be requested
 * alongside the `include:` value.
 */

export type RepoAction = 'create' | 'update' | 'delete'

/** All repo actions, in the order the atproto scope parser canonicalizes them. */
export const REPO_ACTIONS: readonly RepoAction[] = ['create', 'update', 'delete']

export interface LexiconRepoPermission {
	type: 'permission'
	resource: 'repo'
	collection: string[]
	action?: RepoAction[]
}

export interface LexiconRpcPermission {
	type: 'permission'
	resource: 'rpc'
	lxm: string[]
	/** `*` means "any service". Concrete audiences are rejected inside sets. */
	aud?: string
	/** Take the audience from the `?aud=` param on the `include:` scope. */
	inheritAud?: boolean
}

export type LexiconPermission = LexiconRepoPermission | LexiconRpcPermission

export interface LexiconPermissionSet {
	type: 'permission-set'
	title: string
	detail: string
	permissions: LexiconPermission[]
}

/** Repo collections that hold a user's sites. */
export const WISP_SITE_COLLECTIONS = [
	'place.wisp.fs',
	'place.wisp.subfs',
	'place.wisp.settings',
	'place.wisp.domain',
] as const

/** Repo collections that hold a user's webhook subscriptions. */
export const WISP_WEBHOOK_COLLECTIONS = ['place.wisp.v2.wh'] as const

/** XRPC methods the wisp.place hosting service exposes to site owners. */
export const WISP_HOSTING_LXMS = [
	'place.wisp.v2.domain.addSite',
	'place.wisp.v2.domain.claim',
	'place.wisp.v2.domain.claimSubdomain',
	'place.wisp.v2.domain.delete',
	'place.wisp.v2.domain.getList',
	'place.wisp.v2.domain.getStatus',
	'place.wisp.v2.domain.verify',
	'place.wisp.v2.privateSite.create',
	'place.wisp.v2.privateSite.createShare',
	'place.wisp.v2.privateSite.delete',
	'place.wisp.v2.privateSite.list',
	'place.wisp.v2.privateSite.listShares',
	'place.wisp.v2.privateSite.revokeShare',
	'place.wisp.v2.site.delete',
	'place.wisp.v2.site.getDomains',
	'place.wisp.v2.site.getList',
] as const

/**
 * The subset of {@link WISP_HOSTING_LXMS} the CLI actually calls today.
 *
 * The set grants more than this, but the CLI only *requires* what it uses, so
 * a session minted before the permission sets existed still satisfies the
 * check and upgrading does not force everyone through a re-login.
 */
export const WISP_CLI_USED_LXMS = WISP_HOSTING_LXMS.filter((lxm) => lxm !== 'place.wisp.v2.site.getDomains')

/** XRPC methods for webhook signing secrets. */
export const WISP_SECRET_LXMS = [
	'place.wisp.v2.secret.create',
	'place.wisp.v2.secret.delete',
	'place.wisp.v2.secret.list',
	'place.wisp.v2.secret.rotate',
] as const

export const WISP_PERMISSION_SET_SITES = 'place.wisp.authSites'
export const WISP_PERMISSION_SET_WEBHOOKS = 'place.wisp.authWebhooks'
export const WISP_PERMISSION_SET_HOSTING = 'place.wisp.authHosting'
export const WISP_PERMISSION_SET_FULL = 'place.wisp.authFullAccess'

/**
 * The permission sets published at
 * `at://did:plc:.../com.atproto.lexicon.schema/<nsid>`.
 *
 * `aud: '*'` rather than `inheritAud: true` is deliberate: the hosting service
 * is self-hostable, so the CLI can be pointed at a different service DID with
 * `--service` *after* the session was minted. A set that pinned the audience
 * would force a re-authorization every time that flag changed.
 */
export const WISP_PERMISSION_SETS: Record<string, LexiconPermissionSet> = {
	[WISP_PERMISSION_SET_SITES]: {
		type: 'permission-set',
		title: 'Manage your wisp.place sites',
		detail: 'Create, update, and delete your site files and settings.',
		permissions: [
			{
				type: 'permission',
				resource: 'repo',
				collection: [...WISP_SITE_COLLECTIONS],
				action: [...REPO_ACTIONS],
			},
		],
	},
	[WISP_PERMISSION_SET_WEBHOOKS]: {
		type: 'permission-set',
		title: 'Manage your wisp.place webhooks',
		detail: 'Create, update, and delete your webhook subscriptions.',
		permissions: [
			{
				type: 'permission',
				resource: 'repo',
				collection: [...WISP_WEBHOOK_COLLECTIONS],
				action: [...REPO_ACTIONS],
			},
		],
	},
	[WISP_PERMISSION_SET_HOSTING]: {
		type: 'permission-set',
		title: 'Use wisp.place hosting features',
		detail: 'Manage your sites, custom domains, and private site links.',
		permissions: [
			{
				type: 'permission',
				resource: 'rpc',
				aud: '*',
				lxm: [...WISP_HOSTING_LXMS],
			},
		],
	},
	[WISP_PERMISSION_SET_FULL]: {
		type: 'permission-set',
		title: 'Full wisp.place access',
		detail: 'Full control of your sites, domains, and webhooks.',
		permissions: [
			{
				type: 'permission',
				resource: 'repo',
				collection: [...WISP_SITE_COLLECTIONS, ...WISP_WEBHOOK_COLLECTIONS],
				action: [...REPO_ACTIONS],
			},
			{
				type: 'permission',
				resource: 'rpc',
				aud: '*',
				lxm: [...WISP_HOSTING_LXMS, ...WISP_SECRET_LXMS],
			},
		],
	},
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type WispCapability =
	| { resource: 'repo'; collection: string; action: RepoAction }
	| { resource: 'rpc'; lxm: string; aud: string }
	| { resource: 'blob'; mime: string }

/** Human-readable rendering, used in CLI warnings and server logs. */
export function describeCapability(capability: WispCapability): string {
	switch (capability.resource) {
		case 'repo':
			return `${capability.action} ${capability.collection} records`
		case 'rpc':
			return `call ${capability.lxm}`
		case 'blob':
			return `upload ${capability.mime} blobs`
	}
}

/** Every capability a permission set grants, flattened. */
export function permissionSetCapabilities(nsid: string): WispCapability[] {
	const set = WISP_PERMISSION_SETS[nsid]
	if (!set) throw new Error(`Unknown wisp permission set: ${nsid}`)

	const capabilities: WispCapability[] = []
	for (const permission of set.permissions) {
		if (permission.resource === 'repo') {
			for (const collection of permission.collection) {
				for (const action of permission.action ?? REPO_ACTIONS) {
					capabilities.push({ resource: 'repo', collection, action })
				}
			}
		} else {
			for (const lxm of permission.lxm) {
				capabilities.push({ resource: 'rpc', lxm, aud: permission.aud ?? '*' })
			}
		}
	}
	return capabilities
}

// ---------------------------------------------------------------------------
// Scope strings
// ---------------------------------------------------------------------------

/** `include:<nsid>` values for the given sets. */
export function includeScopes(nsids: readonly string[]): string[] {
	return nsids.map((nsid) => `include:${nsid}`)
}

/**
 * The granular scopes an authorization server expands the given sets into.
 *
 * Used as the fallback scope for servers that do not resolve permission sets,
 * so it has to stay semantically identical to the sets themselves.
 */
export function expandPermissionSets(nsids: readonly string[]): string[] {
	const scopes = new Set<string>()
	for (const nsid of nsids) {
		for (const permission of WISP_PERMISSION_SETS[nsid]?.permissions ?? []) {
			if (permission.resource === 'repo') {
				const actions = permission.action ?? REPO_ACTIONS
				// The `action` param is omitted when it matches the default, which
				// is what the atproto scope formatter does too.
				const suffix = actions.length === REPO_ACTIONS.length ? '' : `?${actions.map((a) => `action=${a}`).join('&')}`
				for (const collection of permission.collection) {
					scopes.add(`repo:${collection}${suffix}`)
				}
			} else {
				const aud = permission.aud ?? '*'
				for (const lxm of permission.lxm) {
					scopes.add(`rpc:${lxm}?aud=${aud}`)
				}
			}
		}
	}
	return [...scopes]
}

/**
 * Build the two scope strings a wisp client needs: the permission-set request
 * it prefers, and the pre-expansion fallback for servers that ignore it.
 *
 * `metadata` is the union of both, because an authorization server rejects any
 * requested scope value that the client did not declare up front.
 */
export function buildWispScopes(nsids: readonly string[], extra: readonly string[] = ['atproto', 'blob:*/*']) {
	const preferred = [...extra, ...includeScopes(nsids)]
	const legacy = [...extra, ...expandPermissionSets(nsids)]
	const metadata = [...new Set([...preferred, ...legacy])]
	return {
		preferred: preferred.join(' '),
		legacy: legacy.join(' '),
		metadata: metadata.join(' '),
	}
}

// ---------------------------------------------------------------------------
// Checking what was actually granted
// ---------------------------------------------------------------------------

interface ParsedScope {
	prefix: string
	positional?: string
	params?: URLSearchParams
}

/**
 * Split `repo:place.wisp.fs?action=create` into its parts, following the
 * atproto scope syntax (optional positional value after `:`, optional query
 * string after `?`, both percent-decoded).
 */
export function parseScopeValue(value: string): ParsedScope {
	const paramIdx = value.indexOf('?')
	const colonIdx = value.indexOf(':')
	const prefixEnd = paramIdx === -1 ? colonIdx : colonIdx === -1 ? paramIdx : Math.min(paramIdx, colonIdx)
	if (prefixEnd === -1) return { prefix: value }

	const prefix = value.slice(0, prefixEnd)
	let positional: string | undefined
	if (colonIdx !== -1 && (paramIdx === -1 || colonIdx < paramIdx)) {
		const raw = paramIdx === -1 ? value.slice(colonIdx + 1) : value.slice(colonIdx + 1, paramIdx)
		try {
			positional = decodeURIComponent(raw)
		} catch {
			positional = raw
		}
	}
	const params =
		paramIdx !== -1 && paramIdx < value.length - 1 ? new URLSearchParams(value.slice(paramIdx + 1)) : undefined
	return { prefix, positional, params }
}

/** Values of a repeatable scope param, including the positional shorthand. */
function scopeValues(parsed: ParsedScope, key: string): string[] {
	const fromParams = parsed.params?.getAll(key) ?? []
	if (fromParams.length > 0) return fromParams
	return parsed.positional !== undefined ? [parsed.positional] : []
}

function grantsCapability(parsed: ParsedScope, capability: WispCapability): boolean {
	if (parsed.prefix !== capability.resource) return false

	switch (capability.resource) {
		case 'repo': {
			const collections = scopeValues(parsed, 'collection')
			if (!collections.includes('*') && !collections.includes(capability.collection)) return false
			const actions = parsed.params?.getAll('action') ?? []
			return actions.length === 0 || actions.includes(capability.action)
		}
		case 'rpc': {
			const lxms = scopeValues(parsed, 'lxm')
			if (!lxms.includes('*') && !lxms.includes(capability.lxm)) return false
			const aud = parsed.params?.get('aud')
			// A capability that names `*` needs a grant for every audience.
			return aud === '*' || (capability.aud !== '*' && aud === capability.aud)
		}
		case 'blob': {
			const accepts = scopeValues(parsed, 'accept')
			if (accepts.length === 0) return false
			const [type] = capability.mime.split('/')
			return accepts.some((accept) => accept === '*/*' || accept === capability.mime || accept === `${type}/*`)
		}
	}
}

/** Which of `required` the granted scope does not cover. */
export function missingCapabilities(
	grantedScope: string | undefined,
	required: readonly WispCapability[],
): WispCapability[] {
	const granted = (grantedScope ?? '').split(/\s+/).filter(Boolean).map(parseScopeValue)
	return required.filter((capability) => !granted.some((parsed) => grantsCapability(parsed, capability)))
}

// ---------------------------------------------------------------------------
// Per-client scope definitions
// ---------------------------------------------------------------------------

/**
 * main-app talks to the user's PDS directly (it *is* the wisp.place service),
 * so it only ever needs repo writes plus blob uploads.
 */
export const WISP_APP_PERMISSION_SETS = [WISP_PERMISSION_SET_SITES, WISP_PERMISSION_SET_WEBHOOKS] as const

/**
 * The CLI writes records itself but reaches domain/private-site management
 * through proxied XRPC calls to the hosting service.
 */
export const WISP_CLI_PERMISSION_SETS = [WISP_PERMISSION_SET_SITES, WISP_PERMISSION_SET_HOSTING] as const

const BLOB_CAPABILITY: WispCapability = { resource: 'blob', mime: '*/*' }

/** What main-app must actually be able to do for the editor to work. */
export function wispAppRequiredCapabilities(): WispCapability[] {
	return [...WISP_APP_PERMISSION_SETS.flatMap(permissionSetCapabilities), BLOB_CAPABILITY]
}

/**
 * What the CLI must actually be able to do for `deploy` and friends to work.
 *
 * Deliberately narrower than what {@link WISP_CLI_PERMISSION_SETS} grants —
 * see {@link WISP_CLI_USED_LXMS}. Still wide enough to catch the failure that
 * matters: an authorization server that ignored the `include:` values grants
 * none of this.
 */
export function wispCliRequiredCapabilities(): WispCapability[] {
	const repo = ['place.wisp.fs', 'place.wisp.subfs', 'place.wisp.settings'].flatMap((collection) =>
		REPO_ACTIONS.map((action): WispCapability => ({ resource: 'repo', collection, action })),
	)
	const rpc = WISP_CLI_USED_LXMS.map((lxm): WispCapability => ({ resource: 'rpc', lxm, aud: '*' }))
	return [...repo, ...rpc, BLOB_CAPABILITY]
}
