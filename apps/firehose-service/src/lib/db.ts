import { createHash } from 'node:crypto'
import type { SiteCache, SiteSettingsCache } from '@wispplace/database'
import { createLogger } from '@wispplace/observability'
import postgres from 'postgres'
import { config } from '../config'

const logger = createLogger('firehose-service')

const sql = postgres(config.databaseUrl, {
	max: 10,
	idle_timeout: 20,
	connect_timeout: 10,
})

/**
 * Dedicated pool for advisory locks.
 *
 * A site-write lock is held for the entire duration of a site sync, which
 * includes minutes of blob downloads. Holding those long-lived locks on the
 * main query pool would starve ordinary queries (the connection-pooling
 * starvation class of bug). Isolating them in their own small pool means a
 * stuck/slow sync can only ever exhaust lock connections, never block reads.
 */
const lockSql = postgres(config.databaseUrl, {
	max: 10,
	idle_timeout: 30,
	connect_timeout: 10,
})

/**
 * Generate a numeric advisory-lock id from a string key.
 *
 * MUST stay byte-for-byte identical to the hosting-service implementation so the
 * firehose, revalidate worker, and on-demand cache all contend for the SAME
 * Postgres advisory lock when they target the same site key.
 */
function stringToLockId(key: string): bigint {
	const hash = createHash('sha256').update(key).digest('hex')
	const hashNum = BigInt(`0x${hash.substring(0, 16)}`)
	return hashNum & 0x7fffffffffffffffn
}

/**
 * The unified per-site write-lock key. Shared verbatim with the hosting-service
 * on-demand path so all writers to a site's cache mutually exclude.
 */
export function siteWriteLockKey(did: string, rkey: string): string {
	return `site-write:${did}:${rkey}`
}

/**
 * Run `fn` while holding the per-site write lock, serializing all cache writers
 * for `${did}/${rkey}` across drivers and instances.
 *
 * Uses a blocking acquire (firehose updates must not be dropped) bounded by
 * lock_timeout so a stuck holder can't wedge the queue forever; on timeout it
 * proceeds without the lock rather than losing the update.
 */
export async function withSiteWriteLock<T>(did: string, rkey: string, fn: () => Promise<T>): Promise<T> {
	const lockId = Number(stringToLockId(siteWriteLockKey(did, rkey)))
	const conn = await lockSql.reserve()
	let held = false
	try {
		try {
			await conn`SET lock_timeout = '120s'`
			await conn`SELECT pg_advisory_lock(${lockId})`
			held = true
		} catch (err) {
			logger.warn(`[DB] Could not acquire site-write lock for ${did}/${rkey}; proceeding without it`, {
				did,
				rkey,
				error: err instanceof Error ? err.message : String(err),
			})
		}

		if (!held) {
			return await fn()
		}

		try {
			return await fn()
		} finally {
			await conn`SELECT pg_advisory_unlock(${lockId})`.catch((err) => {
				logger.error('[DB] Failed to release site-write lock', err, { did, rkey })
			})
		}
	} finally {
		conn.release()
	}
}

// Read functions

export async function getSiteCache(did: string, rkey: string): Promise<SiteCache | null> {
	const result = await sql<SiteCache[]>`
    SELECT did, rkey, record_cid, file_cids, cached_at, updated_at, cold_synced
    FROM site_cache
    WHERE did = ${did} AND rkey = ${rkey}
    LIMIT 1
  `
	return result[0] || null
}

export async function getSiteSettingsCache(did: string, rkey: string): Promise<SiteSettingsCache | null> {
	const result = await sql<SiteSettingsCache[]>`
    SELECT did, rkey, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at
    FROM site_settings_cache
    WHERE did = ${did} AND rkey = ${rkey}
    LIMIT 1
  `
	return result[0] || null
}

export async function listAllSiteCaches(): Promise<SiteCache[]> {
	return await sql<SiteCache[]>`
    SELECT did, rkey, record_cid, file_cids, cached_at, updated_at
    FROM site_cache
    ORDER BY updated_at DESC
  `
}

/**
 * List all known DIDs from all DID-bearing tables.
 * Missing tables are skipped to keep bootstrapping resilient.
 */
export async function listAllKnownDids(): Promise<string[]> {
	const sources: Array<{ name: string; fetch: () => Promise<Array<{ did: string }>> }> = [
		{
			name: 'site_cache',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM site_cache
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
		{
			name: 'site_settings_cache',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM site_settings_cache
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
		{
			name: 'domains',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM domains
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
		{
			name: 'custom_domains',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM custom_domains
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
		{
			name: 'supporter',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM supporter
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
	]
	const dids = new Set<string>()

	for (const source of sources) {
		try {
			const rows = await source.fetch()
			for (const row of rows) {
				if (typeof row.did === 'string' && row.did.length > 0) {
					dids.add(row.did)
				}
			}
		} catch {
			logger.warn(`[DB] Skipping DID source table ${source.name}`)
		}
	}

	return [...dids].sort()
}

// Write functions

export async function upsertSiteCache(
	did: string,
	rkey: string,
	recordCid: string,
	fileCids: Record<string, string>,
	// The firehose owns the S3 cold tier, so it always marks the row synced once
	// it has finished writing files. Defaults to true to keep existing call sites
	// (and the contract that this function is only called after S3 writes) intact.
	coldSynced = true,
): Promise<void> {
	logger.debug(`[DB] upsertSiteCache starting for ${did}/${rkey}`)
	try {
		await sql`
      INSERT INTO site_cache (did, rkey, record_cid, file_cids, cached_at, updated_at, cold_synced)
      VALUES (${did}, ${rkey}, ${recordCid}, ${sql.json(fileCids ?? {})}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()), ${coldSynced})
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        record_cid = EXCLUDED.record_cid,
        file_cids = EXCLUDED.file_cids,
        updated_at = EXTRACT(EPOCH FROM NOW()),
        cold_synced = EXCLUDED.cold_synced
    `
		logger.debug(`[DB] upsertSiteCache completed for ${did}/${rkey}`)
	} catch (err) {
		logger.error('[DB] upsertSiteCache error', err, { did, rkey })
		throw err
	}
}

export async function deleteSiteCache(did: string, rkey: string): Promise<void> {
	await sql`DELETE FROM site_cache WHERE did = ${did} AND rkey = ${rkey}`
}

export async function upsertSiteSettingsCache(
	did: string,
	rkey: string,
	recordCid: string,
	settings: {
		directoryListing: boolean
		spaMode?: string
		custom404?: string
		indexFiles?: string[]
		cleanUrls: boolean
		headers?: Array<{ name: string; value: string; path?: string }>
	},
): Promise<void> {
	const directoryListing = settings.directoryListing ?? false
	const spaMode = settings.spaMode ?? null
	const custom404 = settings.custom404 ?? null
	const cleanUrls = settings.cleanUrls ?? true

	const indexFiles = settings.indexFiles ?? []
	const headers = settings.headers ?? []

	logger.debug(`[DB] upsertSiteSettingsCache starting for ${did}/${rkey}`, {
		directoryListing,
		spaMode,
		custom404,
		indexFiles,
		cleanUrls,
		headers,
	})

	try {
		await sql`
      INSERT INTO site_settings_cache (did, rkey, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at)
      VALUES (
        ${did},
        ${rkey},
        ${recordCid},
        ${directoryListing},
        ${spaMode},
        ${custom404},
        ${sql.json(indexFiles)},
        ${cleanUrls},
        ${sql.json(headers)},
        EXTRACT(EPOCH FROM NOW()),
        EXTRACT(EPOCH FROM NOW())
      )
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        record_cid = EXCLUDED.record_cid,
        directory_listing = EXCLUDED.directory_listing,
        spa_mode = EXCLUDED.spa_mode,
        custom_404 = EXCLUDED.custom_404,
        index_files = EXCLUDED.index_files,
        clean_urls = EXCLUDED.clean_urls,
        headers = EXCLUDED.headers,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `
		logger.debug(`[DB] upsertSiteSettingsCache completed for ${did}/${rkey}`)
	} catch (err) {
		logger.error('[DB] upsertSiteSettingsCache error', err, { did, rkey })
		throw err
	}
}

export async function deleteSiteSettingsCache(did: string, rkey: string): Promise<void> {
	await sql`DELETE FROM site_settings_cache WHERE did = ${did} AND rkey = ${rkey}`
}

export async function isSupporter(did: string): Promise<boolean> {
	const rows = await sql`SELECT 1 FROM supporter WHERE did = ${did} LIMIT 1`
	return rows.length > 0
}

export async function closeDatabase(): Promise<void> {
	await Promise.all([sql.end({ timeout: 5 }), lockSql.end({ timeout: 5 })])
	logger.info('[DB] Database connections closed')
}

export { sql }
