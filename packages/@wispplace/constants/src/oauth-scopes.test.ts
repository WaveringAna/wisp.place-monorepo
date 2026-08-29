import { describe, expect, it } from 'bun:test'
import {
	buildWispScopes,
	expandPermissionSets,
	missingCapabilities,
	parseScopeValue,
	permissionSetCapabilities,
	WISP_APP_PERMISSION_SETS,
	WISP_CLI_PERMISSION_SETS,
	WISP_CLI_USED_LXMS,
	WISP_PERMISSION_SET_FULL,
	WISP_PERMISSION_SET_HOSTING,
	WISP_PERMISSION_SET_SITES,
	WISP_PERMISSION_SETS,
	wispAppRequiredCapabilities,
	wispCliRequiredCapabilities,
} from './oauth-scopes'

/**
 * What an authorization server actually puts in the token after resolving our
 * `include:` values. Produced by `IncludeScope#toScopes` from
 * `@atproto/oauth-scopes` against the published lexicons — note that a set
 * collapses into one grouped scope per permission entry, not one scope per
 * collection, which is why the checks below have to be semantic.
 */
const GRANTED_BY_SERVER = {
	[WISP_PERMISSION_SET_SITES]:
		'repo?collection=place.wisp.domain&collection=place.wisp.fs&collection=place.wisp.settings&collection=place.wisp.subfs',
	[WISP_PERMISSION_SET_HOSTING]:
		'rpc?lxm=place.wisp.v2.domain.addSite&lxm=place.wisp.v2.domain.claim&lxm=place.wisp.v2.domain.claimSubdomain&lxm=place.wisp.v2.domain.delete&lxm=place.wisp.v2.domain.getList&lxm=place.wisp.v2.domain.getStatus&lxm=place.wisp.v2.domain.verify&lxm=place.wisp.v2.privateSite.create&lxm=place.wisp.v2.privateSite.createShare&lxm=place.wisp.v2.privateSite.delete&lxm=place.wisp.v2.privateSite.list&lxm=place.wisp.v2.privateSite.listShares&lxm=place.wisp.v2.privateSite.revokeShare&lxm=place.wisp.v2.site.delete&lxm=place.wisp.v2.site.getDomains&lxm=place.wisp.v2.site.getList&aud=*',
	'place.wisp.authWebhooks': 'repo:place.wisp.v2.wh',
}

describe('permission sets', () => {
	it('only references NSIDs under the place.wisp authority', () => {
		// A permission set may only grant access to resources in its own NSID
		// group; anything else is dropped by the authorization server.
		for (const nsid of Object.keys(WISP_PERMISSION_SETS)) {
			expect(nsid.startsWith('place.wisp.')).toBe(true)
			for (const capability of permissionSetCapabilities(nsid)) {
				expect(capability.resource === 'repo' || capability.resource === 'rpc').toBe(true)
				const target = capability.resource === 'repo' ? capability.collection : (capability as { lxm: string }).lxm
				expect(target.startsWith('place.wisp.')).toBe(true)
			}
		}
	})

	it('never pins a concrete audience, which sets are not allowed to do', () => {
		for (const set of Object.values(WISP_PERMISSION_SETS)) {
			for (const permission of set.permissions) {
				if (permission.resource === 'rpc') expect(permission.aud ?? '*').toBe('*')
			}
		}
	})

	it('makes authFullAccess a superset of every other set', () => {
		const full = new Set(permissionSetCapabilities(WISP_PERMISSION_SET_FULL).map((c) => JSON.stringify(c)))
		for (const nsid of Object.keys(WISP_PERMISSION_SETS)) {
			if (nsid === WISP_PERMISSION_SET_FULL) continue
			for (const capability of permissionSetCapabilities(nsid)) {
				expect(full.has(JSON.stringify(capability))).toBe(true)
			}
		}
	})
})

describe('scope strings', () => {
	it('asks for permission sets and declares the fallback alongside them', () => {
		const { preferred, legacy, metadata } = buildWispScopes([...WISP_CLI_PERMISSION_SETS])

		expect(preferred.split(' ')).toContain('include:place.wisp.authSites')
		expect(preferred).not.toContain('repo:place.wisp.fs')
		expect(legacy.split(' ')).toContain('repo:place.wisp.fs')
		expect(legacy).not.toContain('include:')

		// The authorization server rejects any requested value not declared in
		// the client metadata, so the union has to cover both strategies.
		for (const scope of [...preferred.split(' '), ...legacy.split(' ')]) {
			expect(metadata.split(' ')).toContain(scope)
		}
	})

	it('keeps atproto and the blob scope out of the sets', () => {
		// Neither can live inside a permission set, so both must be requested
		// directly every time.
		const { preferred, legacy } = buildWispScopes([...WISP_APP_PERMISSION_SETS])
		for (const scope of [preferred, legacy]) {
			expect(scope.split(' ')).toContain('atproto')
			expect(scope.split(' ')).toContain('blob:*/*')
		}
		expect(expandPermissionSets([WISP_PERMISSION_SET_SITES])).not.toContain('atproto')
	})
})

describe('parseScopeValue', () => {
	it('reads the positional form', () => {
		expect(parseScopeValue('repo:place.wisp.fs')).toMatchObject({ prefix: 'repo', positional: 'place.wisp.fs' })
	})

	it('reads the grouped form', () => {
		const parsed = parseScopeValue('rpc?lxm=place.wisp.v2.site.getList&aud=*')
		expect(parsed.prefix).toBe('rpc')
		expect(parsed.params?.getAll('lxm')).toEqual(['place.wisp.v2.site.getList'])
		expect(parsed.params?.get('aud')).toBe('*')
	})

	it('reads a bare scope value', () => {
		expect(parseScopeValue('atproto')).toEqual({ prefix: 'atproto' })
	})
})

describe('missingCapabilities', () => {
	const grantedForSets = (nsids: readonly string[]) =>
		['atproto', 'blob:*/*', ...nsids.map((nsid) => GRANTED_BY_SERVER[nsid as keyof typeof GRANTED_BY_SERVER])].join(' ')

	it('accepts the grouped scopes a server expands our sets into', () => {
		expect(missingCapabilities(grantedForSets(WISP_APP_PERMISSION_SETS), wispAppRequiredCapabilities())).toEqual([])
		expect(missingCapabilities(grantedForSets(WISP_CLI_PERMISSION_SETS), wispCliRequiredCapabilities())).toEqual([])
	})

	it('accepts the granular fallback scopes', () => {
		const legacy = buildWispScopes([...WISP_CLI_PERMISSION_SETS]).legacy
		expect(missingCapabilities(legacy, wispCliRequiredCapabilities())).toEqual([])
	})

	it('reports everything when a server silently ignored the include: values', () => {
		// This is the failure mode the login retry exists for: the request is
		// accepted, but nothing in it was understood.
		const missing = missingCapabilities('atproto blob:*/*', wispCliRequiredCapabilities())
		expect(missing.length).toBe(wispCliRequiredCapabilities().length - 1)
	})

	it('rejects a repo scope that is missing an action', () => {
		expect(
			missingCapabilities('repo:place.wisp.fs?action=create&action=update', [
				{ resource: 'repo', collection: 'place.wisp.fs', action: 'delete' },
			]),
		).toHaveLength(1)
		expect(
			missingCapabilities('repo:place.wisp.fs?action=create&action=update', [
				{ resource: 'repo', collection: 'place.wisp.fs', action: 'update' },
			]),
		).toEqual([])
	})

	it('treats a wildcard grant as covering everything', () => {
		expect(
			missingCapabilities('repo:*', [{ resource: 'repo', collection: 'place.wisp.fs', action: 'delete' }]),
		).toEqual([])
	})

	it('does not accept a service-specific grant where any service is needed', () => {
		// The CLI can be pointed at a self-hosted service after login, so its rpc
		// capabilities ask for `aud=*` and a pinned audience is not enough.
		const pinned = 'rpc:place.wisp.v2.site.getList?aud=did:web:wisp.place%23wisp_xrpc'
		expect(
			missingCapabilities(pinned, [{ resource: 'rpc', lxm: 'place.wisp.v2.site.getList', aud: '*' }]),
		).toHaveLength(1)
		expect(
			missingCapabilities(pinned, [
				{ resource: 'rpc', lxm: 'place.wisp.v2.site.getList', aud: 'did:web:wisp.place#wisp_xrpc' },
			]),
		).toEqual([])
	})

	it('matches blob scopes by media type', () => {
		expect(missingCapabilities('blob:image/*', [{ resource: 'blob', mime: 'image/png' }])).toEqual([])
		expect(missingCapabilities('blob:image/*', [{ resource: 'blob', mime: 'text/html' }])).toHaveLength(1)
	})
})

describe('upgrade compatibility', () => {
	// The exact scope strings shipped before permission sets existed. Sessions
	// minted with these must keep working, or every user is silently forced
	// through a re-login on upgrade.
	const PRE_PERMISSION_SET_CLI_SCOPE = [
		'atproto',
		'repo:place.wisp.fs',
		'repo:place.wisp.subfs',
		'repo:place.wisp.settings',
		'blob:*/*',
		...WISP_CLI_USED_LXMS.map((lxm) => `rpc:${lxm}?aud=*`),
	].join(' ')

	const PRE_PERMISSION_SET_APP_SCOPE =
		'atproto repo:place.wisp.fs repo:place.wisp.domain repo:place.wisp.subfs repo:place.wisp.settings repo:place.wisp.v2.wh blob:*/*'

	it('still accepts sessions minted before permission sets', () => {
		expect(missingCapabilities(PRE_PERMISSION_SET_CLI_SCOPE, wispCliRequiredCapabilities())).toEqual([])
		expect(missingCapabilities(PRE_PERMISSION_SET_APP_SCOPE, wispAppRequiredCapabilities())).toEqual([])
	})

	it('requires no more than the sets grant', () => {
		const granted = new Set(
			[...WISP_CLI_PERMISSION_SETS.flatMap(permissionSetCapabilities), { resource: 'blob', mime: '*/*' }].map((c) =>
				JSON.stringify(c),
			),
		)
		for (const capability of wispCliRequiredCapabilities()) {
			expect(granted.has(JSON.stringify(capability))).toBe(true)
		}
	})
})
