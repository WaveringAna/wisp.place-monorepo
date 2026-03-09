import { createHash } from 'node:crypto'
import type { CustomDomainLookup, DomainLookup, SiteCache, SiteSettingsCache } from '@wispplace/database'
import postgres from 'postgres'
import { cache } from './cache-manager'

const sql = postgres(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp', {
	max: 10,
	idle_timeout: 20,
})

// Cache-only mode: skip all DB writes and only use tiered storage
export const CACHE_ONLY = process.env.CACHE_ONLY === 'true'

export async function getWispDomain(domain: string): Promise<DomainLookup | null> {
	const key = domain.toLowerCase()
	return cache.getOrFetch('domains', key, async () => {
		const result = await sql<DomainLookup[]>`
      SELECT did, rkey FROM domains WHERE domain = ${key} LIMIT 1
    `
		return result[0] || null
	})
}

export async function getCustomDomain(domain: string): Promise<CustomDomainLookup | null> {
	const key = domain.toLowerCase()
	return cache.getOrFetch('customDomains', key, async () => {
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
	})
}

export async function getCustomDomainByHash(hash: string): Promise<CustomDomainLookup | null> {
	return cache.getOrFetch('customDomains', `hash:${hash}`, async () => {
		const result = await sql<CustomDomainLookup[]>`
      SELECT id, domain, did, rkey, verified FROM custom_domains
      WHERE id = ${hash} AND verified = true LIMIT 1
    `
		return result[0] || null
	})
}

export async function upsertSite(did: string, rkey: string, displayName?: string) {
	console.log('[DB] Read-only mode: skipping upsertSite', { did, rkey, displayName })
}

/**
 * Upsert site cache entry (used by on-demand caching when a site is completely missing)
 */
export async function upsertSiteCache(
	did: string,
	rkey: string,
	recordCid: string,
	fileCids: Record<string, string>,
): Promise<void> {
	if (CACHE_ONLY) {
		console.log('[DB] Cache-only mode: skipping upsertSiteCache', { did, rkey })
		return
	}

	try {
		await sql`
      INSERT INTO site_cache (did, rkey, record_cid, file_cids, cached_at, updated_at)
      VALUES (${did}, ${rkey}, ${recordCid}, ${sql.json(fileCids ?? {})}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        record_cid = EXCLUDED.record_cid,
        file_cids = EXCLUDED.file_cids,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err))
		console.error('[DB] upsertSiteCache error:', { did, rkey, error: error.message })
		throw error
	}
}

export interface SiteRecord {
	did: string
	rkey: string
	display_name?: string
}

export async function getAllSites(): Promise<SiteRecord[]> {
	try {
		const result = await sql<SiteRecord[]>`
      SELECT did, rkey, display_name FROM sites
      ORDER BY created_at DESC
    `
		return result
	} catch (err) {
		console.error('Failed to get all sites', err)
		return []
	}
}

/**
 * Generate a numeric lock ID from a string key
 * PostgreSQL advisory locks use bigint (64-bit signed integer)
 */
function stringToLockId(key: string): bigint {
	const hash = createHash('sha256').update(key).digest('hex')
	// Take first 16 hex characters (64 bits) and convert to bigint
	const hashNum = BigInt(`0x${hash.substring(0, 16)}`)
	// Keep within signed int64 range
	return hashNum & 0x7fffffffffffffffn
}

// Track active locks for cleanup on shutdown
const activeLocks = new Set<string>()

/**
 * Acquire a distributed lock using PostgreSQL advisory locks
 * Returns true if lock was acquired, false if already held by another instance
 * Lock is automatically released when the transaction ends or connection closes
 */
export async function tryAcquireLock(key: string): Promise<boolean> {
	const lockId = stringToLockId(key)

	try {
		const result = await sql`SELECT pg_try_advisory_lock(${Number(lockId)}) as acquired`
		const acquired = result[0]?.acquired === true
		if (acquired) {
			activeLocks.add(key)
		}
		return acquired
	} catch (err) {
		console.error('Failed to acquire lock', { key, error: err })
		return false
	}
}

/**
 * Release a distributed lock
 */
export async function releaseLock(key: string): Promise<void> {
	const lockId = stringToLockId(key)

	try {
		await sql`SELECT pg_advisory_unlock(${Number(lockId)})`
		activeLocks.delete(key)
	} catch (err) {
		console.error('Failed to release lock', { key, error: err })
		// Still remove from tracking even if unlock fails
		activeLocks.delete(key)
	}
}

/**
 * Close all database connections
 * Call this during graceful shutdown
 */
export async function closeDatabase(): Promise<void> {
	try {
		// Release all active advisory locks before closing connections
		if (activeLocks.size > 0) {
			console.log(`[DB] Releasing ${activeLocks.size} active advisory locks before shutdown`)
			for (const key of activeLocks) {
				await releaseLock(key)
			}
		}

		await sql.end({ timeout: 5 })
		console.log('[DB] Database connections closed')
	} catch (err) {
		console.error('[DB] Error closing database connections:', err)
	}
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
	const result = await sql<SiteCache[]>`
    SELECT did, rkey, record_cid, file_cids, cached_at, updated_at
    FROM site_cache
    WHERE did = ${did} AND rkey = ${rkey}
    LIMIT 1
  `
	return result[0] || null
}

export async function listSiteCachesForDid(did: string): Promise<SiteCache[]> {
	return await sql<SiteCache[]>`
    SELECT did, rkey, record_cid, file_cids, cached_at, updated_at
    FROM site_cache
    WHERE did = ${did}
    ORDER BY updated_at DESC
  `
}

export async function isSupporter(did: string): Promise<boolean> {
	const rows = await sql`SELECT 1 FROM supporter WHERE did = ${did} LIMIT 1`
	return rows.length > 0
}

export { sql }
