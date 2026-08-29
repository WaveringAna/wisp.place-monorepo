import { createHash } from 'node:crypto'
import type { CustomDomainLookup, DomainLookup, SiteCache, SiteSettingsCache } from '@wispplace/database'
import postgres from 'postgres'
import { cache } from './cache-manager'

const writeDatabaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp'
const readDatabaseUrl = process.env.DATABASE_READ_URL || writeDatabaseUrl

const sql = postgres(readDatabaseUrl, {
	max: 10,
	idle_timeout: 20,
})

const writeSql = readDatabaseUrl === writeDatabaseUrl ? sql : postgres(writeDatabaseUrl, { max: 10, idle_timeout: 20 })

// Cache-only mode: skip all DB writes and only use tiered storage
export const CACHE_ONLY = process.env.CACHE_ONLY === 'true'

export interface SiteAnalyticsBucket {
	ownerDid: string
	siteRkey: string
	bucketStart: number
	requests: number
	htmlResponses: number
	status2xx: number
	status3xx: number
	status4xx: number
	status5xx: number
}

export interface SiteAnalyticsBatch {
	batchId: string
	instanceId: string
	buckets: readonly SiteAnalyticsBucket[]
}

export interface SiteAnalyticsCommitResult {
	duplicate: boolean
	acceptedBuckets: number
	acceptedRequests: number
	skippedBuckets: number
	skippedRequests: number
}

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
		{ ttl: (v) => (!v || !v.rkey ? NEGATIVE_TTL_MS : undefined) },
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
		{ ttl: (v) => (!v || !v.rkey ? NEGATIVE_TTL_MS : undefined) },
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
		{ ttl: (v) => (!v || !v.rkey ? NEGATIVE_TTL_MS : undefined) },
	)
}

/**
 * Upsert site cache entry (used by on-demand caching when a site is completely missing)
 *
 * The on-demand path only populates the local hot/warm tiers — it does NOT write
 * the S3 cold tier — so it must mark the row cold_synced=false. That signals the
 * firehose-service to do a full (re)download into S3 instead of trusting this
 * optimistic ledger and skipping files it never actually wrote to S3.
 */
export async function upsertSiteCache(
	did: string,
	rkey: string,
	recordCid: string,
	fileCids: Record<string, string>,
	coldSynced = false,
): Promise<void> {
	if (CACHE_ONLY) {
		console.log('[DB] Cache-only mode: skipping upsertSiteCache', { did, rkey })
		return
	}

	try {
		await writeSql`
      INSERT INTO site_cache (did, rkey, record_cid, file_cids, cached_at, updated_at, cold_synced)
      VALUES (${did}, ${rkey}, ${recordCid}, ${writeSql.json(fileCids ?? {})}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()), ${coldSynced})
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        record_cid = EXCLUDED.record_cid,
        file_cids = EXCLUDED.file_cids,
        updated_at = EXTRACT(EPOCH FROM NOW()),
        cold_synced = EXCLUDED.cold_synced
    `
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err))
		console.error('[DB] upsertSiteCache error:', { did, rkey, error: error.message })
		throw error
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
		const result = await writeSql`SELECT pg_try_advisory_lock(${Number(lockId)}) as acquired`
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
		await writeSql`SELECT pg_advisory_unlock(${Number(lockId)})`
		activeLocks.delete(key)
	} catch (err) {
		console.error('Failed to release lock', { key, error: err })
		// Still remove from tracking even if unlock fails
		activeLocks.delete(key)
	}
}

export async function commitSiteAnalyticsBatch(batch: SiteAnalyticsBatch): Promise<SiteAnalyticsCommitResult> {
	if (CACHE_ONLY) {
		throw new Error('analytics writes are disabled in cache-only mode')
	}
	if (batch.buckets.length === 0) {
		return {
			duplicate: false,
			acceptedBuckets: 0,
			acceptedRequests: 0,
			skippedBuckets: 0,
			skippedRequests: 0,
		}
	}

	return await writeSql.begin(async (tx) => {
		const inserted = await tx<Array<{ batch_id: string }>>`
			INSERT INTO analytics_ingest_batches (batch_id, instance_id)
			VALUES (${batch.batchId}, ${batch.instanceId})
			ON CONFLICT (batch_id) DO NOTHING
			RETURNING batch_id
		`
		if (inserted.length === 0) {
			return {
				duplicate: true,
				acceptedBuckets: 0,
				acceptedRequests: 0,
				skippedBuckets: 0,
				skippedRequests: 0,
			}
		}

		const accepted = await Promise.all(
			batch.buckets.map(async (bucket) => {
				const rows = await tx`
					INSERT INTO site_analytics_hourly (
						owner_did,
						site_rkey,
						bucket_start,
						requests,
						html_responses,
						status_2xx,
						status_3xx,
						status_4xx,
						status_5xx
					)
					SELECT
						${bucket.ownerDid},
						${bucket.siteRkey},
						${new Date(bucket.bucketStart)},
						${bucket.requests},
						${bucket.htmlResponses},
						${bucket.status2xx},
						${bucket.status3xx},
						${bucket.status4xx},
						${bucket.status5xx}
					WHERE EXISTS (
						SELECT 1
						FROM site_cache
						WHERE did = ${bucket.ownerDid}
							AND rkey = ${bucket.siteRkey}
					)
					ON CONFLICT (owner_did, site_rkey, bucket_start)
					DO UPDATE SET
						requests = site_analytics_hourly.requests + EXCLUDED.requests,
						html_responses = site_analytics_hourly.html_responses + EXCLUDED.html_responses,
						status_2xx = site_analytics_hourly.status_2xx + EXCLUDED.status_2xx,
						status_3xx = site_analytics_hourly.status_3xx + EXCLUDED.status_3xx,
						status_4xx = site_analytics_hourly.status_4xx + EXCLUDED.status_4xx,
						status_5xx = site_analytics_hourly.status_5xx + EXCLUDED.status_5xx,
						updated_at = NOW()
					RETURNING owner_did
				`
				return rows.length > 0
			}),
		)

		let acceptedBuckets = 0
		let acceptedRequests = 0
		let skippedRequests = 0
		for (let index = 0; index < accepted.length; index++) {
			const bucket = batch.buckets[index]
			if (!bucket) continue
			if (accepted[index]) {
				acceptedBuckets++
				acceptedRequests += bucket.requests
			} else {
				skippedRequests += bucket.requests
			}
		}

		return {
			duplicate: false,
			acceptedBuckets,
			acceptedRequests,
			skippedBuckets: batch.buckets.length - acceptedBuckets,
			skippedRequests,
		}
	})
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
		if (writeSql !== sql) await writeSql.end({ timeout: 5 })
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
