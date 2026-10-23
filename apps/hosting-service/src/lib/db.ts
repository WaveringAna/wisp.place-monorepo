import type { CustomDomainLookup, DomainLookup, SiteCache, SiteSettingsCache } from '@wispplace/database'
import { type HostingDbReadRetryOutcome, metricsCollector } from '@wispplace/observability'
import postgres from 'postgres'
import { type CacheManager, cache } from './cache-manager'
import { retryTransientRead } from './read-retry'

/** The tagged-template query the lookups issue; a `postgres` pool is one. */
export type HostingSql = <T extends readonly (object | undefined)[]>(
	strings: TemplateStringsArray,
	...parameters: readonly postgres.ParameterOrFragment<never>[]
) => Promise<T>

export type HostingDbDeps = {
	sql: HostingSql
	cache: Pick<CacheManager<'domains' | 'customDomains' | 'settings' | 'siteCache'>, 'getOrFetch'>
	onReadRetry?: (outcome: HostingDbReadRetryOutcome) => void
}

const UNDEFINED_TABLE = '42P01'

// Short TTL for negative / unmapped lookups so newly-mapped domains appear quickly.
const NEGATIVE_TTL_MS = 10_000

/** The hosting service's read-only lookups over one query function and one lookup cache. */
export function createHostingDb({ sql, cache, onReadRetry }: HostingDbDeps) {
	// Every query here is an idempotent read, and the pool can hand out a connection
	// that a proxy or the network already closed, so `read` is `sql` plus a short retry.
	const read = <T extends readonly (object | undefined)[]>(
		strings: TemplateStringsArray,
		...parameters: readonly postgres.ParameterOrFragment<never>[]
	): Promise<T> => retryTransientRead(() => sql<T>(strings, ...parameters), { onOutcome: onReadRetry })

	async function getWispDomain(domain: string): Promise<DomainLookup | null> {
		const key = domain.toLowerCase()
		return cache.getOrFetch(
			'domains',
			key,
			async () => {
				const result = await read<DomainLookup[]>`
        SELECT did, rkey FROM domains WHERE domain = ${key} LIMIT 1
      `
				return result[0] || null
			},
			{ ttl: (v) => (!v?.rkey ? NEGATIVE_TTL_MS : undefined) },
		)
	}

	async function getCustomDomain(domain: string): Promise<CustomDomainLookup | null> {
		const key = domain.toLowerCase()
		return cache.getOrFetch(
			'customDomains',
			key,
			async () => {
				const result = await read<CustomDomainLookup[]>`
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

	async function getCustomDomainByHash(hash: string): Promise<CustomDomainLookup | null> {
		return cache.getOrFetch(
			'customDomains',
			`hash:${hash}`,
			async () => {
				const result = await read<CustomDomainLookup[]>`
        SELECT id, domain, did, rkey, verified FROM custom_domains
        WHERE id = ${hash} AND verified = true LIMIT 1
      `
				return result[0] || null
			},
			{ ttl: (v) => (!v?.rkey ? NEGATIVE_TTL_MS : undefined) },
		)
	}

	async function getSiteSettingsCache(did: string, rkey: string): Promise<SiteSettingsCache | null> {
		return cache.getOrFetch('settings', `${did}:${rkey}`, async () => {
			const result = await read<SiteSettingsCache[]>`
        SELECT did, rkey, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at
        FROM site_settings_cache
        WHERE did = ${did} AND rkey = ${rkey}
        LIMIT 1
      `
			return result[0] || null
		})
	}

	/** One `site_cache` row straight from the database, bypassing the lookup cache. */
	async function readSiteCache(did: string, rkey: string): Promise<SiteCache | null> {
		const result = await read<SiteCache[]>`
      SELECT did, rkey, record_cid, file_cids, file_objects, cached_at, updated_at, absent_since
      FROM site_cache
      WHERE did = ${did} AND rkey = ${rkey}
      LIMIT 1
    `
		return result[0] || null
	}

	async function getSiteCache(did: string, rkey: string): Promise<SiteCache | null> {
		return cache.getOrFetch('siteCache', `${did}:${rkey}`, () => readSiteCache(did, rkey), {
			cacheIf: (v) => v !== null,
		})
	}

	/**
	 * One keyset page of `site_cache` rows after `(afterDid, afterRkey)`, for a
	 * background walk over every public site. Bypasses the lookup cache so the
	 * walk does not fill it with sites nobody is requesting.
	 */
	async function listSiteCachePage(afterDid: string, afterRkey: string, limit: number): Promise<SiteCache[]> {
		return await read<SiteCache[]>`
      SELECT did, rkey, record_cid, file_cids, file_objects, cached_at, updated_at, absent_since
      FROM site_cache
      WHERE (did, rkey) > (${afterDid}, ${afterRkey})
      ORDER BY did, rkey
      LIMIT ${limit}
    `
	}

	/**
	 * Subjects whose newest `!takedown` label from `labelerDid` is neither negated
	 * nor expired. A label scoped to one record version (a cid) takes down the
	 * whole site. Before the labeler has created its table there is nothing to obey.
	 */
	async function loadActiveTakedowns(labelerDid: string): Promise<string[]> {
		try {
			const rows = await read<{ uri: string }[]>`
        SELECT uri FROM (
          SELECT DISTINCT ON (uri) uri, neg, exp FROM labeler_labels
          WHERE val = '!takedown' AND src = ${labelerDid}
          ORDER BY uri, seq DESC
        ) latest
        WHERE NOT neg AND (exp IS NULL OR exp::timestamptz > now())
      `
			return rows.map((row) => row.uri)
		} catch (error) {
			if ((error as { code?: unknown }).code === UNDEFINED_TABLE) return []
			throw error
		}
	}

	return {
		getWispDomain,
		getCustomDomain,
		getCustomDomainByHash,
		getSiteSettingsCache,
		getSiteCache,
		readSiteCache,
		listSiteCachePage,
		loadActiveTakedowns,
	}
}

export type HostingDb = ReturnType<typeof createHostingDb>

// The hosting service only reads. Prefer the read replica, fall back to the primary.
const databaseUrl =
	process.env.DATABASE_READ_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp'

const sql = postgres(databaseUrl, {
	max: 10,
	idle_timeout: 20,
})

export const {
	getWispDomain,
	getCustomDomain,
	getCustomDomainByHash,
	getSiteSettingsCache,
	getSiteCache,
	readSiteCache,
	listSiteCachePage,
	loadActiveTakedowns,
} = createHostingDb({ sql, cache, onReadRetry: metricsCollector.recordHostingDbReadRetry })

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
