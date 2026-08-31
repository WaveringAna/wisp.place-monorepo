import type { CustomDomainLookup, DomainLookup, SiteCache, SiteSettingsCache } from '@wispplace/database'
import postgres from 'postgres'
import { cache } from './cache-manager'

const writeDatabaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp'
const readDatabaseUrl = process.env.DATABASE_READ_URL || writeDatabaseUrl

// Cache-only mode: disable database-backed analytics writes.
export const CACHE_ONLY = process.env.CACHE_ONLY === 'true'

const sql = postgres(readDatabaseUrl, {
	max: 10,
	idle_timeout: 20,
})

// Analytics never writes in cache-only mode, so do not open an unused write pool.
const writeSql =
	CACHE_ONLY || readDatabaseUrl === writeDatabaseUrl ? sql : postgres(writeDatabaseUrl, { max: 10, idle_timeout: 20 })

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

export interface ClosableDatabasePool {
	end(options?: { timeout?: number }): Promise<void>
}

/**
 * Close each configured database pool once. Read and write pools can be the
 * same object when DATABASE_READ_URL is not configured.
 */
export function createDatabasePoolCloser(
	readPool: ClosableDatabasePool,
	writePool: ClosableDatabasePool,
	onError: () => void = () => {},
): () => Promise<void> {
	let closePromise: Promise<void> | undefined

	return (): Promise<void> => {
		if (closePromise) return closePromise

		closePromise = (async () => {
			const pools = readPool === writePool ? [readPool] : [readPool, writePool]
			const results = await Promise.allSettled(
				pools.map((pool) => Promise.resolve().then(() => pool.end({ timeout: 5 }))),
			)
			if (results.some((result) => result.status === 'rejected')) onError()
		})()
		return closePromise
	}
}

const closeDatabasePools = createDatabasePoolCloser(sql, writeSql, () => {
	console.error('[DB] One or more database pools failed to close cleanly')
})

let databaseClosePromise: Promise<void> | undefined

/**
 * Close the read and write pools during graceful shutdown.
 * This function is idempotent.
 */
export function closeDatabase(): Promise<void> {
	if (databaseClosePromise) return databaseClosePromise

	databaseClosePromise = (async () => {
		await closeDatabasePools()
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
