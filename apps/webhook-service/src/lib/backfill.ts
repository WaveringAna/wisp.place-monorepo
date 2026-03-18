import { getPdsForDid } from '@wispplace/atproto-utils'
import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import { createLogger } from '@wispplace/observability'
import { listAllKnownDids, upsertWebhookRecord } from './db'

const logger = createLogger('webhook-service:backfill')

interface ListRecordsResponse {
	records: Array<{
		uri: string
		cid: string
		value: WhRecord
	}>
	cursor?: string
}

/**
 * Fetch all place.wisp.v2.wh records for a DID from their PDS.
 * Pages through all results using the cursor.
 */
async function fetchWhRecordsForDid(did: string): Promise<Array<{ rkey: string; record: WhRecord }>> {
	const pdsUrl = await getPdsForDid(did)
	if (!pdsUrl) return []

	const results: Array<{ rkey: string; record: WhRecord }> = []
	let cursor: string | undefined

	do {
		const params = new URLSearchParams({
			repo: did,
			collection: 'place.wisp.v2.wh',
			limit: '100',
		})
		if (cursor) params.set('cursor', cursor)

		const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
			signal: AbortSignal.timeout(10_000),
		})

		if (!res.ok) {
			if (res.status === 404) return results // DID has no records of this type
			logger.warn(`[backfill] PDS returned ${res.status} for ${did}`)
			return results
		}

		const data = (await res.json()) as ListRecordsResponse
		cursor = data.cursor

		for (const r of data.records) {
			const rkey = r.uri.split('/').at(-1)
			if (!rkey) continue
			if (!r.value.scope?.aturi || !r.value.url) continue
			results.push({ rkey, record: r.value })
		}
	} while (cursor)

	return results
}

/**
 * On startup, scan all known DIDs for existing place.wisp.v2.wh records
 * and populate the local DB. This recovers webhook registrations that were
 * created while the service was offline.
 */
export async function runStartupBackfill(): Promise<void> {
	const dids = await listAllKnownDids()
	if (dids.length === 0) {
		logger.info('[backfill] No known DIDs to scan')
		return
	}

	logger.info(`[backfill] Scanning ${dids.length} known DIDs for place.wisp.v2.wh records`)

	let found = 0
	let failed = 0

	for (const did of dids) {
		try {
			const records = await fetchWhRecordsForDid(did)
			for (const { rkey, record } of records) {
				await upsertWebhookRecord(did, rkey, record)
				found++
				logger.info(`[backfill] Imported ${did}/${rkey}`)
			}
		} catch (err) {
			failed++
			logger.warn(`[backfill] Failed to scan ${did}`, { err: String(err) })
		}
	}

	logger.info(`[backfill] Done — ${found} webhook record(s) imported, ${failed} DID(s) failed`)
}
