import { DELETED_SITE_RECORD_CID } from '@wispplace/constants'
import type { SQL } from 'bun'

/**
 * Read-only queries used by primary helpers and by the explicitly eventual
 * presentation API. This module has no database-pool imports, so it cannot
 * accidentally create a second client or use the wrong endpoint.
 */

type SiteDomain = {
	type: 'wisp' | 'custom'
	domain: string
	verified?: boolean
	id?: string
}

type SitePresentationRow = {
	did: string
	rkey: string
	display_name: string | null
	created_at: number | string | null
	updated_at: number | string | null
	domains: SiteDomain[]
}

type SitesWithDomainsQueryRow = Omit<SitePresentationRow, 'domains'> & {
	domain_type: 'wisp' | 'custom' | null
	domain: string | null
	domain_id: string | null
	domain_verified: boolean | null
}

type WebhookEventLogRow = {
	rkey: string
	url: string
	event_kind: string
	event_did: string
	event_collection: string
	event_rkey: string
	cid: string | null
	status: string
	delivered_at: string
}

/**
 * Builds reusable read queries for both primary helpers and the narrower
 * eventual-read facade. Only db.ts decides which methods are safe to expose
 * through the replica-capable facade.
 */
export const createPresentationReadQueries = (sql: SQL) => {
	const getDomainByDid = async (did: string): Promise<string | null> => {
		const rows = await sql`SELECT domain FROM domains WHERE did = ${did} ORDER BY created_at ASC LIMIT 1`
		return rows[0]?.domain ?? null
	}

	const getAllWispDomains = async (did: string): Promise<Array<{ domain: string; rkey: string | null }>> => {
		const rows = await sql`SELECT domain, rkey FROM domains WHERE did = ${did} ORDER BY created_at ASC`
		return rows
	}

	const countWispDomains = async (did: string): Promise<number> => {
		const rows = await sql`SELECT COUNT(*) as count FROM domains WHERE did = ${did}`
		return Number(rows[0]?.count ?? 0)
	}

	const isDomainRegistered = async (domain: string) => {
		const domainLower = domain.toLowerCase().trim()

		// Preserve the current wisp-domain precedence if inconsistent data exists.
		const wispDomain = await sql`
			SELECT did, domain, rkey FROM domains WHERE domain = ${domainLower}
		`

		if (wispDomain.length > 0) {
			return {
				registered: true as const,
				type: 'wisp' as const,
				domain: wispDomain[0].domain,
				did: wispDomain[0].did,
				rkey: wispDomain[0].rkey,
			}
		}

		const customDomain = await sql`
			SELECT id, domain, did, rkey, verified FROM custom_domains WHERE domain = ${domainLower}
		`

		if (customDomain.length > 0) {
			return {
				registered: true as const,
				type: 'custom' as const,
				domain: customDomain[0].domain,
				did: customDomain[0].did,
				rkey: customDomain[0].rkey,
				verified: customDomain[0].verified,
			}
		}

		return { registered: false as const }
	}

	const getCustomDomainsByDid = async (did: string) => {
		const rows = await sql`SELECT * FROM custom_domains WHERE did = ${did} ORDER BY created_at DESC`
		return rows
	}

	const getCustomDomainInfo = async (domain: string) => {
		const rows = await sql`SELECT * FROM custom_domains WHERE domain = ${domain.toLowerCase()}`
		return rows[0] ?? null
	}

	const getSitesByDid = async (did: string) => {
		const rows = await sql`
			SELECT
				did,
				rkey,
				rkey AS display_name,
				cached_at AS created_at,
				updated_at
			FROM site_cache
			WHERE did = ${did} AND record_cid <> ${DELETED_SITE_RECORD_CID}
			ORDER BY cached_at DESC
		`
		return rows
	}

	/**
	 * One bulk query for a site's list view and all of its domain badges. The
	 * lateral UNION avoids both the former 1 + 2N request pattern and a
	 * wisp-domain × custom-domain join explosion.
	 */
	const getSitesWithDomainsByDid = async (did: string): Promise<SitePresentationRow[]> => {
		const rows = await sql<SitesWithDomainsQueryRow[]>`
			SELECT
				s.did,
				s.rkey,
				s.rkey AS display_name,
				s.cached_at AS created_at,
				s.updated_at,
				site_domain.domain_type,
				site_domain.domain,
				site_domain.domain_id,
				site_domain.domain_verified
			FROM site_cache s
			LEFT JOIN LATERAL (
				SELECT 'wisp'::TEXT AS domain_type, d.domain, NULL::TEXT AS domain_id, NULL::BOOLEAN AS domain_verified
				FROM domains d
				WHERE d.did = s.did AND d.rkey = s.rkey
				UNION ALL
				SELECT 'custom'::TEXT AS domain_type, cd.domain, cd.id AS domain_id, cd.verified AS domain_verified
				FROM custom_domains cd
				WHERE cd.did = s.did AND cd.rkey = s.rkey
			) site_domain ON true
			WHERE s.did = ${did} AND s.record_cid <> ${DELETED_SITE_RECORD_CID}
			ORDER BY s.cached_at DESC, site_domain.domain_type ASC NULLS LAST, site_domain.domain ASC NULLS LAST
		`

		const sites = new Map<string, SitePresentationRow>()
		const domainKeys = new Map<string, Set<string>>()
		for (const row of rows) {
			const key = `${row.did}:${row.rkey}`
			let site = sites.get(key)
			if (!site) {
				site = {
					did: row.did,
					rkey: row.rkey,
					display_name: row.display_name,
					created_at: row.created_at,
					updated_at: row.updated_at,
					domains: [],
				}
				sites.set(key, site)
				domainKeys.set(key, new Set())
			}

			if (!row.domain_type || !row.domain) continue
			const seen = domainKeys.get(key)!
			const domainKey = `${row.domain_type}:${row.domain_id ?? row.domain}`
			if (seen.has(domainKey)) continue
			seen.add(domainKey)

			if (row.domain_type === 'wisp') {
				site.domains.push({ type: 'wisp', domain: row.domain })
			} else {
				site.domains.push({
					type: 'custom',
					domain: row.domain,
					verified: row.domain_verified ?? false,
					id: row.domain_id ?? undefined,
				})
			}
		}

		return [...sites.values()]
	}

	const getDomainsBySite = async (did: string, rkey: string): Promise<SiteDomain[]> => {
		const [wispDomain, customDomains] = await Promise.all([
			sql`
				SELECT domain, rkey FROM domains
				WHERE did = ${did} AND rkey = ${rkey}
			`,
			sql`
				SELECT id, domain, verified FROM custom_domains
				WHERE did = ${did} AND rkey = ${rkey}
				ORDER BY created_at DESC
			`,
		])
		const domains: SiteDomain[] = []

		if (wispDomain.length > 0) {
			domains.push({
				type: 'wisp',
				domain: wispDomain[0].domain,
			})
		}

		for (const customDomain of customDomains) {
			domains.push({
				type: 'custom',
				domain: customDomain.domain,
				verified: customDomain.verified,
				id: customDomain.id,
			})
		}

		return domains
	}

	const getDomainCountBySite = async (did: string, rkey: string) => {
		const [wispCount, customCount] = await Promise.all([
			sql`
				SELECT COUNT(*) as count FROM domains
				WHERE did = ${did} AND rkey = ${rkey}
			`,
			sql`
				SELECT COUNT(*) as count FROM custom_domains
				WHERE did = ${did} AND rkey = ${rkey}
			`,
		])

		return {
			wisp: Number(wispCount[0]?.count || 0),
			custom: Number(customCount[0]?.count || 0),
			total: Number(wispCount[0]?.count || 0) + Number(customCount[0]?.count || 0),
		}
	}

	const isSupporter = async (did: string): Promise<boolean> => {
		const rows = await sql`SELECT 1 FROM supporter WHERE did = ${did} LIMIT 1`
		return rows.length > 0
	}

	const getAllSupporters = async () => {
		const rows = await sql`SELECT * FROM supporter ORDER BY created_at ASC`
		return rows
	}

	const getUserStatus = async (did: string) => {
		const [sites, domain] = await Promise.all([getSitesByDid(did), getDomainByDid(did)])
		return { sites, domain }
	}

	const getDomainsForDid = async (did: string) => {
		const [wispDomains, customDomains] = await Promise.all([getAllWispDomains(did), getCustomDomainsByDid(did)])
		return { wispDomains, customDomains }
	}

	const getDomainStatus = async (domain: string) => {
		const registration = await isDomainRegistered(domain)
		const customDomain =
			registration.registered && registration.type === 'custom' ? await getCustomDomainInfo(domain) : null
		return { registration, customDomain }
	}

	const getAdminDatabaseReport = async () => {
		const [siteCount, wispSubdomains, customDomainCount, siteSettingsCount, recentSites, recentDomains] =
			await Promise.all([
				sql<
					Array<{ count: string | number }>
				>`SELECT COUNT(*) as count FROM site_cache WHERE record_cid <> ${DELETED_SITE_RECORD_CID}`,
				sql<Array<{ count: string | number }>>`SELECT COUNT(*) as count FROM domains WHERE domain LIKE '%.wisp.place'`,
				sql<Array<{ count: string | number }>>`SELECT COUNT(*) as count FROM custom_domains WHERE verified = true`,
				sql<Array<{ count: string | number }>>`SELECT COUNT(*) as count FROM site_settings_cache`,
				sql`
				SELECT
					s.did,
					s.rkey,
					s.rkey as display_name,
					s.cached_at as created_at,
					d.domain as subdomain,
					cd.domain as custom_domain
				FROM site_cache s
				LEFT JOIN domains d ON s.did = d.did AND s.rkey = d.rkey AND d.domain LIKE '%.wisp.place'
				LEFT JOIN custom_domains cd ON s.did = cd.did AND s.rkey = cd.rkey AND cd.verified = true
				WHERE s.record_cid <> ${DELETED_SITE_RECORD_CID}
				ORDER BY s.cached_at DESC
				LIMIT 10
			`,
				sql`SELECT domain, did, rkey, verified, created_at FROM custom_domains ORDER BY created_at DESC LIMIT 10`,
			])

		return {
			stats: {
				totalSites: siteCount[0]?.count ?? 0,
				totalWispSubdomains: wispSubdomains[0]?.count ?? 0,
				totalCustomDomains: customDomainCount[0]?.count ?? 0,
				totalSiteCache: siteCount[0]?.count ?? 0,
				totalSiteSettingsCache: siteSettingsCount[0]?.count ?? 0,
			},
			recentSites,
			recentDomains,
		}
	}

	const getAdminSites = async (limit: number, offset: number) => {
		const [sites, customDomains] = await Promise.all([
			sql`
				SELECT
					s.did,
					s.rkey,
					s.rkey as display_name,
					s.cached_at as created_at,
					d.domain as subdomain,
					cd.domain as custom_domain
				FROM site_cache s
				LEFT JOIN domains d ON s.did = d.did AND s.rkey = d.rkey AND d.domain LIKE '%.wisp.place'
				LEFT JOIN custom_domains cd ON s.did = cd.did AND s.rkey = cd.rkey AND cd.verified = true
				WHERE s.record_cid <> ${DELETED_SITE_RECORD_CID}
				ORDER BY s.cached_at DESC
				LIMIT ${limit} OFFSET ${offset}
			`,
			sql`
				SELECT
					domain,
					did,
					rkey,
					verified,
					created_at
				FROM custom_domains
				ORDER BY created_at DESC
				LIMIT ${limit} OFFSET ${offset}
			`,
		])

		return { sites, customDomains }
	}

	const getWebhookEventHistory = async (ownerDid: string): Promise<WebhookEventLogRow[]> => {
		return await sql<WebhookEventLogRow[]>`
			SELECT rkey, url, event_kind, event_did, event_collection, event_rkey, cid, status, delivered_at
			FROM webhook_event_logs
			WHERE owner_did = ${ownerDid}
			ORDER BY delivered_at DESC
			LIMIT 100
		`
	}

	return {
		getDomainByDid,
		getAllWispDomains,
		countWispDomains,
		isDomainRegistered,
		getCustomDomainsByDid,
		getCustomDomainInfo,
		getSitesByDid,
		getSitesWithDomainsByDid,
		getDomainsBySite,
		getDomainCountBySite,
		isSupporter,
		getAllSupporters,
		getUserStatus,
		getDomainsForDid,
		getDomainStatus,
		getAdminDatabaseReport,
		getAdminSites,
		getWebhookEventHistory,
	}
}
