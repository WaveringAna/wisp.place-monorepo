#!/usr/bin/env bun
/**
 * Finds all active sites in site_cache that are missing CAS file_objects mapping
 * (or have incomplete mappings) and enqueues them for revalidation.
 *
 * Usage:
 *   bun --env-file=apps/firehose-service/.env apps/firehose-service/scripts/enqueue-unconverted.ts [--dry-run]
 */
import { parseArgs } from 'node:util'
import { DELETED_SITE_RECORD_CID } from '@wispplace/constants'
import { normalizeFileCids, normalizeFileObjects } from '@wispplace/fs-utils'
import Redis from 'ioredis'
import postgres from 'postgres'
import { enqueueSiteRevalidationWithRedis } from '../src/lib/cache-invalidation'

function required(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`Missing required environment variable: ${name}`)
	return value
}

const { values } = parseArgs({
	options: {
		'dry-run': { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
})

if (values.help) {
	console.log(
		'Usage: bun --env-file=apps/firehose-service/.env apps/firehose-service/scripts/enqueue-unconverted.ts [--dry-run]',
	)
	process.exit(0)
}

const dryRun = values['dry-run']
const sql = postgres(required('DATABASE_URL'), { max: 2 })
const redis = new Redis(required('REDIS_URL'))

try {
	const rows = await sql<
		Array<{
			did: string
			rkey: string
			file_cids: unknown
			file_objects: unknown
		}>
	>`
		SELECT did, rkey, file_cids, file_objects
		FROM site_cache
		WHERE record_cid <> ${DELETED_SITE_RECORD_CID}
		  AND absent_since IS NULL
		ORDER BY did, rkey
	`

	const unconverted: Array<{ did: string; rkey: string; missingCount: number }> = []

	for (const row of rows) {
		const cids = normalizeFileCids(row.file_cids).value
		const objects = normalizeFileObjects(row.file_objects)
		if (!objects) {
			unconverted.push({ did: row.did, rkey: row.rkey, missingCount: Object.keys(cids).length })
			continue
		}
		let missing = 0
		for (const path of Object.keys(cids)) {
			if (path.startsWith('.rewritten/')) continue
			if (objects[path] === undefined) {
				missing++
			}
		}
		if (missing > 0) {
			unconverted.push({ did: row.did, rkey: row.rkey, missingCount: missing })
		}
	}

	console.log(`Found ${unconverted.length} unconverted/partially-converted sites out of ${rows.length} total`)

	if (dryRun) {
		console.log('Dry run complete. No sites enqueued.')
		process.exit(0)
	}

	let enqueued = 0
	let deduplicated = 0
	let errors = 0

	for (const site of unconverted) {
		const outcome = await enqueueSiteRevalidationWithRedis(
			redis,
			site.did,
			site.rkey,
			'storage-miss:cas-migration-prewarm',
		)
		if (outcome === 'enqueued') enqueued++
		else if (outcome === 'deduplicated') deduplicated++
		else {
			console.warn(`Enqueue outcome for ${site.did}/${site.rkey}: ${outcome}`)
			errors++
		}
	}

	console.log(JSON.stringify({ total: unconverted.length, enqueued, deduplicated, errors }, null, 2))
} finally {
	redis.disconnect()
	await sql.end()
	process.exit(0)
}
