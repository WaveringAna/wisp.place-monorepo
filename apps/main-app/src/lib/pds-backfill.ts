import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-node'
import {
	DEFAULT_REVALIDATE_STREAM,
	DELETED_SITE_RECORD_CID,
	enqueueSiteRevalidation,
	type RevalidateQueueClient,
} from '@wispplace/constants'
import { createLogger } from '@wispplace/observability'
import { db } from './db'
import { getConnectedRedisClient } from './redis'

const logger = createLogger('main-app:pds-backfill')

const PAGE_SIZE = 100
/** Enough for any real account; a runaway repo stops here instead of paging forever. */
const MAX_PAGES = 20
const STREAM = Bun.env.WISP_REVALIDATE_STREAM || DEFAULT_REVALIDATE_STREAM
const STREAM_MAX_LEN = Number(Bun.env.WISP_REVALIDATE_STREAM_MAXLEN) || 10_000
/** Signing in twice in a row should not queue the same sites twice. */
const DEDUPE_TTL_SECONDS = 600
export const PDS_BACKFILL_REASON = 'pds-backfill'

export interface SiteRecordRef {
	rkey: string
	cid: string
}

export interface CachedSite {
	recordCid: string
	coldSynced: boolean
}

/**
 * The sites the firehose has not materialized yet: records missing from
 * site_cache, cached at an older CID or as deleted, or still waiting for their
 * first full download (cold_synced = false, which includes rows seeded here).
 */
export const sitesToBackfill = (records: readonly SiteRecordRef[], cached: ReadonlyMap<string, CachedSite>) =>
	records.filter(({ rkey, cid }) => {
		const site = cached.get(rkey)
		return !site || site.recordCid === DELETED_SITE_RECORD_CID || site.recordCid !== cid || !site.coldSynced
	})

async function listSiteRecords(did: string, session: OAuthSession): Promise<SiteRecordRef[]> {
	const agent = new Agent((url, init) => session.fetchHandler(url, init))
	const records: SiteRecordRef[] = []
	let cursor: string | undefined
	for (let page = 0; page < MAX_PAGES; page++) {
		// Pages depend on the previous cursor, so they are fetched in order.
		const { data } = await agent.com.atproto.repo.listRecords({
			repo: did,
			collection: 'place.wisp.fs',
			limit: PAGE_SIZE,
			cursor,
		})
		for (const record of data.records) {
			const rkey = record.uri.split('/').pop()
			if (rkey) records.push({ rkey, cid: record.cid })
		}
		cursor = data.cursor
		if (!cursor || data.records.length === 0) break
	}
	return records
}

async function cachedSites(did: string): Promise<Map<string, CachedSite>> {
	const rows: { rkey: string; record_cid: string; cold_synced: boolean }[] =
		await db`SELECT rkey, record_cid, cold_synced FROM site_cache WHERE did = ${did}`
	return new Map(rows.map((row) => [row.rkey, { recordCid: row.record_cid, coldSynced: row.cold_synced }]))
}

/**
 * Lists a site immediately, before the firehose has fetched any of its files.
 * The row has no files and cold_synced = false, so the worker always does a
 * full download; DO NOTHING keeps a row the firehose wrote first untouched.
 */
async function seedSiteCache(did: string, sites: readonly SiteRecordRef[]): Promise<void> {
	if (sites.length === 0) return
	const rows = sites.map(({ rkey, cid }) => ({ did, rkey, record_cid: cid, file_cids: {}, cold_synced: false }))
	await db`
		INSERT INTO site_cache ${db(rows, 'did', 'rkey', 'record_cid', 'file_cids', 'cold_synced')}
		ON CONFLICT (did, rkey) DO NOTHING
	`
}

export interface BackfillResult {
	/** place.wisp.fs records found on the PDS. */
	found: number
	/** Sites handed to the firehose revalidation worker. */
	queued: number
}

/**
 * Makes sure every site on the user's PDS is listed and cached. Missing sites
 * get a placeholder site_cache row right away so the dashboard shows them; the
 * firehose service's revalidation worker then downloads the files and fills in
 * the row, as it does for every other site.
 */
export async function backfillSitesFromPds(did: string, session: OAuthSession): Promise<BackfillResult> {
	const [records, cached] = await Promise.all([listSiteRecords(did, session), cachedSites(did)])
	const pending = sitesToBackfill(records, cached)
	if (pending.length === 0) return { found: records.length, queued: 0 }
	await seedSiteCache(
		did,
		pending.filter(({ rkey }) => !cached.has(rkey)),
	)

	const redis = await getConnectedRedisClient()
	if (!redis) {
		logger.warn('[Backfill] REDIS_URL not set; cannot queue sites for the firehose worker', { did })
		return { found: records.length, queued: 0 }
	}
	const queue: RevalidateQueueClient = {
		eval: (script, keyCount, ...keysAndArgs) => redis.send('EVAL', [script, String(keyCount), ...keysAndArgs]),
	}

	const outcomes = await Promise.all(
		pending.map(({ rkey }) =>
			enqueueSiteRevalidation(queue, {
				stream: STREAM,
				maxLen: STREAM_MAX_LEN,
				dedupeTtlSeconds: DEDUPE_TTL_SECONDS,
				did,
				rkey,
				reason: PDS_BACKFILL_REASON,
			}),
		),
	)
	const queued = outcomes.filter((outcome) => outcome === 'enqueued' || outcome === 'deduped').length
	logger.info('[Backfill] Queued sites missing from site_cache', { did, found: records.length, queued })
	return { found: records.length, queued }
}
