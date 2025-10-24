import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-node'
import { upsertSite } from './db'

/**
 * Sync sites from user's PDS into the database cache
 * - Fetches all place.wisp.fs records from AT Protocol repo
 * - Validates record structure
 * - Backfills into sites table
 */
export async function syncSitesFromPDS(
	did: string,
	session: OAuthSession
): Promise<{ synced: number; errors: string[] }> {
	console.log(`[Sync] Starting site sync for ${did}`)

	const agent = new Agent((url, init) => session.fetchHandler(url, init))
	const errors: string[] = []
	let synced = 0

	try {
		// List all records in the place.wisp.fs collection
		console.log('[Sync] Fetching place.wisp.fs records from PDS')
		const records = await agent.com.atproto.repo.listRecords({
			repo: did,
			collection: 'place.wisp.fs',
			limit: 100 // Adjust if users might have more sites
		})

		console.log(`[Sync] Found ${records.data.records.length} records`)

		// Process each record
		for (const record of records.data.records) {
			try {
				const { uri, value } = record

				// Extract rkey from URI (at://did/collection/rkey)
				const rkey = uri.split('/').pop()
				if (!rkey) {
					errors.push(`Invalid URI format: ${uri}`)
					continue
				}

				// Validate record structure
				if (!value || typeof value !== 'object') {
					errors.push(`Invalid record value for ${rkey}`)
					continue
				}

				const siteValue = value as any

				// Check for required fields
				if (siteValue.$type !== 'place.wisp.fs') {
					errors.push(
						`Invalid $type for ${rkey}: ${siteValue.$type}`
					)
					continue
				}

				if (!siteValue.site || typeof siteValue.site !== 'string') {
					errors.push(`Missing or invalid site name for ${rkey}`)
					continue
				}

				// Upsert into database
				const displayName = siteValue.site
				await upsertSite(did, rkey, displayName)

				console.log(
					`[Sync] ✓ Synced site: ${displayName} (${rkey})`
				)
				synced++
			} catch (err) {
				const errorMsg = `Error processing record: ${err instanceof Error ? err.message : 'Unknown error'}`
				console.error(`[Sync] ${errorMsg}`)
				errors.push(errorMsg)
			}
		}

		console.log(
			`[Sync] Complete: ${synced} synced, ${errors.length} errors`
		)
		return { synced, errors }
	} catch (err) {
		const errorMsg = `Failed to fetch records from PDS: ${err instanceof Error ? err.message : 'Unknown error'}`
		console.error(`[Sync] ${errorMsg}`)
		errors.push(errorMsg)
		return { synced, errors }
	}
}
