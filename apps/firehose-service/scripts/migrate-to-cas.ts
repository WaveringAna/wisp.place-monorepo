#!/usr/bin/env bun
/**
 * One-shot conversion of cached site files to content-addressed storage (CAS_STORAGE.md).
 * Delete this script and src/lib/cas-migration.ts once every site has been converted.
 *
 *   dry-run        classify every file and report what would happen; changes nothing
 *   migrate        copy objects to their CAS keys inside S3 and store each site's mapping
 *   delete-legacy  after the new code is deployed and verified, remove the old {did}/{rkey}/{path}
 *                  objects of sites whose mapping is complete and whose CAS objects all exist
 *
 * Old code ignores the new column, so `migrate` is safe to run while the old services serve. Run it
 * twice around a short firehose pause: a site updated during the first pass is reported `stale`.
 */
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { DELETED_SITE_RECORD_CID } from '@wispplace/constants'
import { S3StorageTier } from '@wispplace/tiered-storage'
import postgres from 'postgres'
import {
	deleteLegacyObjects,
	type MigrationPorts,
	migrateSite,
	type SiteMigrationReport,
} from '../src/lib/cas-migration'
import {
	commitMigratedMapping,
	listSitesForMigration,
	type MigrationSiteRow,
	recordCasObject,
} from '../src/lib/cas-objects'
import { resolveS3Prefix } from '../src/lib/s3-prefix'

const PAGE_SIZE = 200
const MAX_REPORTED_SITES = 500

type Mode = 'dry-run' | 'migrate' | 'delete-legacy'

function required(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`Missing required environment variable: ${name}`)
	return value
}

const { values } = parseArgs({
	options: {
		mode: { type: 'string', default: 'dry-run' },
		concurrency: { type: 'string', default: '6' },
		site: { type: 'string', multiple: true },
		report: { type: 'string' },
		yes: { type: 'boolean', default: false },
		help: { type: 'boolean', default: false },
	},
})

if (values.help) {
	console.log(`Usage: bun --env-file=apps/firehose-service/.env apps/firehose-service/scripts/migrate-to-cas.ts [options]

  --mode <dry-run|migrate|delete-legacy>   (default: dry-run)
  --site <did/rkey>      limit to one site; repeatable
  --concurrency <n>      sites processed at once (default: 6)
  --report <path>        JSON report path
  --yes                  required for any mode that changes data`)
	process.exit(0)
}

const mode = values.mode as Mode
if (!['dry-run', 'migrate', 'delete-legacy'].includes(mode)) throw new Error(`Unknown --mode ${values.mode}`)
if (mode !== 'dry-run' && !values.yes) throw new Error(`--mode ${mode} changes data: pass --yes to confirm`)
const concurrency = Number(values.concurrency)
if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer')
const only = new Set(values.site ?? [])

const tier = new S3StorageTier({
	bucket: required('S3_BUCKET'),
	region: process.env.S3_REGION || 'us-east-1',
	endpoint: process.env.S3_ENDPOINT,
	prefix: resolveS3Prefix(process.env.S3_PREFIX),
	forcePathStyle: !['0', 'false', 'no'].includes((process.env.S3_FORCE_PATH_STYLE ?? 'true').toLowerCase()),
	credentials:
		process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
			? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
			: undefined,
})
const sql = postgres(required('DATABASE_URL'), { max: concurrency + 2 })

const ports: MigrationPorts = {
	getMetadata: (key) => tier.getMetadata(key),
	readObject: (key) => tier.get(key),
	copyObject: (from, to, metadata, expectedChecksum) => tier.copyObject(from, to, metadata, expectedChecksum),
	registerObject: (key, size) => recordCasObject(sql, key, size),
	commitMapping: (did, rkey, expected, mapping) => commitMigratedMapping(sql, did, rkey, expected, mapping),
	deleteObject: (key) => tier.delete(key),
	listLegacyKeys: async (prefix) => {
		const keys: string[] = []
		for await (const key of tier.listKeys(prefix)) keys.push(key)
		return keys
	},
}

interface Totals {
	sites: number
	byStatus: Record<string, number>
	copied: number
	reused: number
	deleted: number
	skipped: Record<string, number>
}
const totals: Totals = { sites: 0, byStatus: {}, copied: 0, reused: 0, deleted: 0, skipped: {} }
const notable: Array<Record<string, unknown>> = []

function bump(map: Record<string, number>, key: string, by = 1): void {
	map[key] = (map[key] ?? 0) + by
}

async function processSite(site: MigrationSiteRow): Promise<void> {
	if (mode === 'delete-legacy') {
		const result = await deleteLegacyObjects(site, ports)
		totals.deleted += result.deleted
		bump(totals.byStatus, result.skipped ?? 'deleted')
		if (result.skipped) notable.push({ site: `${site.did}/${site.rkey}`, ...result })
		return
	}
	const report: SiteMigrationReport = await migrateSite(site, ports, { dryRun: mode === 'dry-run' })
	totals.copied += report.copied
	totals.reused += report.reused
	bump(totals.byStatus, report.status)
	for (const [reason, count] of Object.entries(report.skipped)) if (count > 0) bump(totals.skipped, reason, count)
	if (report.status !== 'migrated' && report.status !== 'dry-run') notable.push({ ...report })
	else if (report.status === 'dry-run' && Object.values(report.skipped).some((count) => count > 0))
		notable.push({ ...report })
}

async function run(): Promise<void> {
	let after: { did: string; rkey: string } | null = null
	for (;;) {
		const page = await listSitesForMigration(sql, after, PAGE_SIZE, DELETED_SITE_RECORD_CID)
		if (page.length === 0) break
		const last = page[page.length - 1] as MigrationSiteRow
		after = { did: last.did, rkey: last.rkey }
		const selected = page.filter((site) => only.size === 0 || only.has(`${site.did}/${site.rkey}`))
		const queue = [...selected]
		await Promise.all(
			Array.from({ length: concurrency }, async () => {
				for (let site = queue.shift(); site; site = queue.shift()) {
					try {
						await processSite(site)
					} catch (error) {
						bump(totals.byStatus, 'error')
						notable.push({
							site: `${site.did}/${site.rkey}`,
							error: error instanceof Error ? error.message : String(error),
						})
					}
					totals.sites++
				}
			}),
		)
		console.log(`[migrate-to-cas] ${totals.sites} sites processed (${mode})`)
	}
}

try {
	await run()
} finally {
	await sql.end()
}
const reportPath = values.report ?? `/tmp/wisp-cas-${mode}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`
await writeFile(reportPath, JSON.stringify({ mode, totals, notable: notable.slice(0, MAX_REPORTED_SITES) }, null, 2))
console.log(JSON.stringify(totals, null, 2))
console.log(`report: ${reportPath}`)
process.exit(0)
