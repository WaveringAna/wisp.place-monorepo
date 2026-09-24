import type { CustomDomainLookup, DomainLookup, SiteCache, SiteSettingsCache } from '@wispplace/database'
import postgres from 'postgres'
import { cache } from './cache-manager'

// The hosting service only reads. Prefer the read replica, fall back to the primary.
const databaseUrl =
	process.env.DATABASE_READ_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp'

const sql = postgres(databaseUrl, {
	max: 10,
	idle_timeout: 20,
})

// Short TTL for negative / unmapped lookups so newly-mapped domains appear quickly.
const NEGATIVE_TTL_MS = 10_000

export async function getWispDomain(domain: string): Promise<DomainLookup | null> {
	const key = domain.toLowerCase()
	return cache.getOrFetch(
		'domains',
		key,
		async () => {
			const result = await sql<DomainLookup[]>`
      SELECT did, rkey FROM domains WHERE domain = ${key} LIMIT 1
    `
			return result[0] || null
		},
		{ ttl: (v) => (!v?.rkey ? NEGATIVE_TTL_MS : undefined) },
	)
}

export async function getCustomDomain(domain: string): Promise<CustomDomainLookup | null> {
	const key = domain.toLowerCase()
	return cache.getOrFetch(
		'customDomains',
		key,
		async () => {
			const result = await sql<CustomDomainLookup[]>`
      SELECT cd.id, cd.domain, cd.did, cd.rkey, cd.verified
      FROM custom_domains cd
      LEFT JOIN site_cache sc
        ON sc.did = cd.did
       AND sc.rkey = cd.rkey
      WHERE cd.domain = ${key} AND cd.verified = true
      ORDER BY
        (cd.rkey IS NOT NULL) DESC,
        (sc.did IS NOT NULL) DESC,
        cd.last_verified_at DESC NULLS LAST,
        cd.created_at DESC
      LIMIT 1
    `
			return result[0] || null
		},
		{ ttl: (v) => (!v?.rkey ? NEGATIVE_TTL_MS : undefined) },
	)
}

export async function getCustomDomainByHash(hash: string): Promise<CustomDomainLookup | null> {
	return cache.getOrFetch(
		'customDomains',
		`hash:${hash}`,
		async () => {
			const result = await sql<CustomDomainLookup[]>`
      SELECT id, domain, did, rkey, verified FROM custom_domains
      WHERE id = ${hash} AND verified = true LIMIT 1
    `
			return result[0] || null
		},
		{ ttl: (v) => (!v?.rkey ? NEGATIVE_TTL_MS : undefined) },
	)
}

export interface ClosableDatabasePool {
	end(options?: { timeout?: number }): Promise<void>
}

/** Close a pool at most once, however many times shutdown asks. */
export function createDatabasePoolCloser(
	pool: ClosableDatabasePool,
	onError: () => void = () => {},
): () => Promise<void> {
	let closePromise: Promise<void> | undefined

	return (): Promise<void> => {
		if (closePromise) return closePromise

		closePromise = Promise.resolve()
			.then(() => pool.end({ timeout: 5 }))
			.catch(() => onError())
		return closePromise
	}
}

const closeDatabasePool = createDatabasePoolCloser(sql, () => {
	console.error('[DB] Database pool failed to close cleanly')
})

let databaseClosePromise: Promise<void> | undefined

/**
 * Close the database pool during graceful shutdown.
 * This function is idempotent.
 */
export function closeDatabase(): Promise<void> {
	if (databaseClosePromise) return databaseClosePromise

	databaseClosePromise = (async () => {
		await closeDatabasePool()
		console.log('[DB] Database connections closed')
	})()
	return databaseClosePromise
}

// Site cache queries

export async function getSiteSettingsCache(did: string, rkey: string): Promise<SiteSettingsCache | null> {
	return cache.getOrFetch('settings', `${did}:${rkey}`, async () => {
		const result = await sql<SiteSettingsCache[]>`
      SELECT did, rkey, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at
      FROM site_settings_cache
      WHERE did = ${did} AND rkey = ${rkey}
      LIMIT 1
    `
		return result[0] || null
	})
}

export async function getSiteCache(did: string, rkey: string): Promise<SiteCache | null> {
	return cache.getOrFetch(
		'siteCache',
		`${did}:${rkey}`,
		async () => {
			const result = await sql<SiteCache[]>`
        SELECT did, rkey, record_cid, file_cids, cached_at, updated_at
        FROM site_cache
        WHERE did = ${did} AND rkey = ${rkey}
        LIMIT 1
      `
			return result[0] || null
		},
		{ cacheIf: (v) => v !== null },
	)
}
