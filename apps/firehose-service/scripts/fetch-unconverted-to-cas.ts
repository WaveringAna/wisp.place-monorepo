#!/usr/bin/env bun
/**
 * Standalone migration helper: fetches missing / unconverted site records directly from PDS
 * and materializes their files into CAS storage (S3) and postgres before deploying the new services.
 *
 * Safe to run against live production while legacy services run, because:
 * 1. It writes bodies only to CAS keys (cas/...) and per-site .rewritten/
 * 2. It populates site_cache.file_objects, which legacy services ignore
 * 3. It runs with skipInvalidation: true to avoid redis pub/sub churn
 *
 * Usage:
 *   bun --env-file=apps/firehose-service/.env apps/firehose-service/scripts/fetch-unconverted-to-cas.ts [options]
 *
 * Options:
 *   --concurrency <n>   concurrent site syncs (default: 4)
 *   --limit <n>         maximum sites to process
 *   --site <did/rkey>   process specific site only (repeatable)
 *   --dry-run           list candidate sites without fetching or writing
 */
import { parseArgs } from 'node:util'

const { values } = parseArgs({
	options: {
		concurrency: { type: 'string', default: '4' },
		limit: { type: 'string' },
		site: { type: 'string', multiple: true },
		'dry-run': { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
})

if (values.help) {
	console.log(`Usage: bun --env-file=apps/firehose-service/.env apps/firehose-service/scripts/fetch-unconverted-to-cas.ts [options]

  --concurrency <n>  concurrent site syncs (default: 4)
  --limit <n>        maximum sites to process
  --site <did/rkey>  process specific site only (repeatable)
  --dry-run          list candidate sites without fetching or writing
`)
	process.exit(0)
}

const { DELETED_SITE_RECORD_CID } = await import('@wispplace/constants')
const { normalizeFileCids, normalizeFileObjects } = await import('@wispplace/fs-utils')
const { default: postgres } = await import('postgres')
const { config } = await import('../src/config')
const { fetchSiteRecord, handleSiteCreateOrUpdate } = await import('../src/lib/cache-writer')
const { closeDatabase } = await import('../src/lib/db')

const concurrency = Math.max(1, Number.parseInt(values.concurrency ?? '4', 10))
const limit = values.limit ? Number.parseInt(values.limit, 10) : undefined
const dryRun = values['dry-run']
const filterSites = new Set(values.site ?? [])

const sql = postgres(config.databaseUrl, { max: 2 })

interface CandidateSite {
	did: string
	rkey: string
	fileCount: number
	missingCount: number
}

async function findCandidates(): Promise<CandidateSite[]> {
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

	const candidates: CandidateSite[] = []

	for (const row of rows) {
		if (filterSites.size > 0 && !filterSites.has(`${row.did}/${row.rkey}`)) {
			continue
		}

		const cids = normalizeFileCids(row.file_cids).value
		const objects = normalizeFileObjects(row.file_objects)
		const nonRewritten = Object.keys(cids).filter((p) => !p.startsWith('.rewritten/'))

		if (!objects) {
			candidates.push({
				did: row.did,
				rkey: row.rkey,
				fileCount: nonRewritten.length,
				missingCount: nonRewritten.length,
			})
			continue
		}

		let missing = 0
		for (const path of nonRewritten) {
			if (objects[path] === undefined) {
				missing++
			}
		}

		if (missing > 0) {
			candidates.push({
				did: row.did,
				rkey: row.rkey,
				fileCount: nonRewritten.length,
				missingCount: missing,
			})
		}
	}

	return limit ? candidates.slice(0, limit) : candidates
}

async function main(): Promise<void> {
	const candidates = await findCandidates()
	console.log(`Found ${candidates.length} unconverted or incomplete sites needing CAS materialization`)

	if (candidates.length === 0) {
		console.log('All active sites are already fully converted to CAS!')
		return
	}

	if (dryRun) {
		console.log('Candidates (dry run):')
		for (const c of candidates) {
			console.log(`  ${c.did}/${c.rkey} (${c.missingCount}/${c.fileCount} missing)`)
		}
		return
	}

	let completed = 0
	let absentOnPds = 0
	let failed = 0
	const errors: Array<{ site: string; error: string }> = []

	const queue = [...candidates]
	const total = queue.length

	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			for (let item = queue.shift(); item; item = queue.shift()) {
				const tag = `${item.did}/${item.rkey}`
				try {
					const current = await fetchSiteRecord(item.did, item.rkey)
					if (!current) {
						absentOnPds++
						console.warn(`[fetch-unconverted] Record not found on PDS: ${tag}`)
						continue
					}

					await handleSiteCreateOrUpdate(item.did, item.rkey, current.record, current.cid, {
						forceDownload: true,
						skipInvalidation: true,
					})
					completed++
					console.log(`[fetch-unconverted] Materialized to CAS [${completed}/${total}]: ${tag}`)
				} catch (err) {
					failed++
					const errorMsg = err instanceof Error ? err.message : String(err)
					errors.push({ site: tag, error: errorMsg })
					console.error(`[fetch-unconverted] Failed to materialize ${tag}: ${errorMsg}`)
				}
			}
		}),
	)

	console.log('\nFinal Summary:')
	console.log(JSON.stringify({ total, completed, absentOnPds, failed, errors: errors.slice(0, 50) }, null, 2))
}

try {
	await main()
} finally {
	await sql.end({ timeout: 5 }).catch(() => {})
	await closeDatabase().catch(() => {})
	process.exit(0)
}
