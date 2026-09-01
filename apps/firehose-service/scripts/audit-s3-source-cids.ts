#!/usr/bin/env bun
/**
 * Read-only audit of S3 cache object source identity metadata against current
 * place.wisp.fs records on the records' authoritative PDSes.
 *
 * This script never writes to S3, a PDS, Redis, or Postgres.
 */
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { expandSubfs, getPdsForDid, type SubfsSubject } from '@wispplace/atproto-utils'
import { collectFileCidsFromEntries } from '@wispplace/fs-utils'
import { parseLexiconJson } from '@wispplace/lexicons/public-json'
import type { Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { validateRecord as validateFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { safeFetch, safeFetchJson } from '@wispplace/safe-fetch'
import { S3StorageTier } from '@wispplace/tiered-storage'

const DEFAULT_MAX_SITES = 50
const DEFAULT_MAX_OBJECTS = 2_000
const DEFAULT_CONCURRENCY = 8
const MAX_PDS_RECORD_BYTES = 1024 * 1024
const MAX_ISSUE_DETAILS = 500

interface SiteRef {
	did: string
	rkey: string
	id: string
}

interface CanonicalSite extends SiteRef {
	recordCid: string
	fileCids: Readonly<Record<string, string>>
	ownerDidByPath: ReadonlyMap<string, string>
}

type FindingKind =
	| 'match'
	| 'missing_source_identity'
	| 'source_cid_mismatch'
	| 'source_did_mismatch'
	| 'source_cid_and_did_mismatch'
	| 'orphaned_cached_path'
	| 'metadata_missing'
	| 'metadata_read_error'

interface Finding {
	kind: FindingKind
	key: string
	expectedCid?: string
	observedCid?: string
	expectedDid?: string
	observedDid?: string
	error?: string
}

interface SiteResult extends SiteRef {
	status: 'audited' | 'record_absent' | 'record_error'
	recordCid?: string
	canonicalFiles?: number
	selectedObjects: number
	counts: Record<string, number>
	findings: Finding[]
	error?: string
}

function help(): never {
	console.log(`Usage:
  bun --env-file=apps/firehose-service/.env apps/firehose-service/scripts/audit-s3-source-cids.ts [options]

Options:
  --max-sites <n>       Deterministically sample at most this many sites (default: ${DEFAULT_MAX_SITES})
  --max-objects <n>     Audit at most this many objects across sampled sites (default: ${DEFAULT_MAX_OBJECTS})
  --concurrency <n>     Concurrent PDS and S3 metadata reads (default: ${DEFAULT_CONCURRENCY})
  --site <did/rkey>     Audit a specific site; repeatable
  --prefix <prefix>     Limit the initial S3 key listing
  --seed <text>         Deterministic sample seed (default: wisp-s3-cid-audit-v1)
  --report <path>       JSON report path (default: /tmp/wisp-s3-cid-audit-<timestamp>.json)
  --all                 Audit every discovered site and object
  --fail-on-findings    Exit 2 for CID/DID/path findings or missing identity metadata
  --help                Show this help

The audit is read-only. Rewritten HTML keys are checked against the original
file path because their sourceCid identifies the immutable source blob.`)
	process.exit(0)
}

function parsePositiveInteger(raw: string | undefined, name: string, fallback: number): number {
	if (raw === undefined) return fallback
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
	return value
}

function requiredEnvironment(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`Missing required environment variable: ${name}`)
	return value
}

function parseBooleanEnvironment(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback
	return ['1', 'true', 'yes'].includes(value.toLowerCase())
}

function parseSiteId(value: string): SiteRef {
	const slash = value.indexOf('/')
	if (slash <= 0 || slash === value.length - 1) throw new Error(`Invalid --site value: ${value}`)
	const did = value.slice(0, slash)
	const rkey = value.slice(slash + 1)
	if (!did.startsWith('did:') || rkey.includes('/')) throw new Error(`Invalid --site value: ${value}`)
	return { did, rkey, id: `${did}/${rkey}` }
}

function parseObjectKey(key: string): (SiteRef & { objectPath: string; canonicalPath: string }) | null {
	const firstSlash = key.indexOf('/')
	const secondSlash = key.indexOf('/', firstSlash + 1)
	if (firstSlash <= 0 || secondSlash <= firstSlash + 1 || secondSlash === key.length - 1) return null
	const did = key.slice(0, firstSlash)
	const rkey = key.slice(firstSlash + 1, secondSlash)
	const objectPath = key.slice(secondSlash + 1)
	if (!did.startsWith('did:')) return null
	const canonicalPath = objectPath.startsWith('.rewritten/') ? objectPath.slice('.rewritten/'.length) : objectPath
	if (!canonicalPath) return null
	return { did, rkey, id: `${did}/${rkey}`, objectPath, canonicalPath }
}

function stableHash(value: string): number {
	let hash = 0x811c9dc5
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}

function deterministicSample<T>(
	values: readonly T[],
	limit: number,
	identity: (value: T) => string,
	seed: string,
): T[] {
	if (values.length <= limit) return [...values]
	return [...values]
		.sort((left, right) => {
			const delta = stableHash(`${seed}:${identity(left)}`) - stableHash(`${seed}:${identity(right)}`)
			return delta || identity(left).localeCompare(identity(right))
		})
		.slice(0, limit)
}

async function mapConcurrent<T, R>(
	values: readonly T[],
	concurrency: number,
	mapper: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length)
	let nextIndex = 0
	async function worker(): Promise<void> {
		while (true) {
			const index = nextIndex++
			if (index >= values.length) return
			results[index] = await mapper(values[index]!)
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
	return results
}

function safeError(error: unknown): string {
	if (!(error instanceof Error)) return 'UNKNOWN_ERROR'
	if (/^[A-Z][A-Z0-9_]{2,127}$/.test(error.message)) return error.message
	return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'UNKNOWN_ERROR'
}

const { values } = parseArgs({
	options: {
		all: { type: 'boolean', default: false },
		concurrency: { type: 'string' },
		'fail-on-findings': { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false },
		'max-objects': { type: 'string' },
		'max-sites': { type: 'string' },
		prefix: { type: 'string' },
		report: { type: 'string' },
		seed: { type: 'string', default: 'wisp-s3-cid-audit-v1' },
		site: { type: 'string', multiple: true, default: [] },
	},
	strict: true,
	allowPositionals: false,
})
if (values.help) help()

const concurrency = parsePositiveInteger(values.concurrency, '--concurrency', DEFAULT_CONCURRENCY)
const maxSites = values.all
	? Number.MAX_SAFE_INTEGER
	: parsePositiveInteger(values['max-sites'], '--max-sites', DEFAULT_MAX_SITES)
const maxObjects = values.all
	? Number.MAX_SAFE_INTEGER
	: parsePositiveInteger(values['max-objects'], '--max-objects', DEFAULT_MAX_OBJECTS)
const requestedSites = (values.site ?? []).map(parseSiteId)
const reportPath = values.report ?? `/tmp/wisp-s3-cid-audit-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`

const tier = new S3StorageTier({
	bucket: requiredEnvironment('S3_BUCKET'),
	region: process.env.S3_REGION || 'us-east-1',
	endpoint: process.env.S3_ENDPOINT,
	prefix: process.env.S3_PREFIX,
	forcePathStyle: parseBooleanEnvironment(process.env.S3_FORCE_PATH_STYLE, true),
	credentials:
		process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
			? {
					accessKeyId: process.env.AWS_ACCESS_KEY_ID,
					secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
				}
			: undefined,
})

console.error('Listing S3 object keys (read-only)...')
const keysBySite = new Map<string, string[]>()
let listedObjects = 0
let malformedKeys = 0
for await (const key of tier.listKeys(values.prefix)) {
	listedObjects++
	const parsed = parseObjectKey(key)
	if (!parsed) {
		malformedKeys++
		continue
	}
	const existing = keysBySite.get(parsed.id)
	if (existing) existing.push(key)
	else keysBySite.set(parsed.id, [key])
}

const discoveredSites = [...keysBySite.keys()].sort().map(parseSiteId)
let selectedSites: SiteRef[]
if (requestedSites.length > 0) {
	selectedSites = [...new Map(requestedSites.map((site) => [site.id, site])).values()]
	for (const site of selectedSites) {
		if (!keysBySite.has(site.id)) keysBySite.set(site.id, [])
	}
} else {
	selectedSites = deterministicSample(discoveredSites, maxSites, (site) => site.id, values.seed!)
}

// Round-robin deterministic object sampling preserves coverage across selected sites.
const perSiteCandidates = new Map<string, string[]>()
for (const site of selectedSites) {
	perSiteCandidates.set(
		site.id,
		deterministicSample(keysBySite.get(site.id) ?? [], Number.MAX_SAFE_INTEGER, (key) => key, values.seed!),
	)
}
const selectedKeysBySite = new Map<string, string[]>()
let selectedObjects = 0
for (let offset = 0; selectedObjects < maxObjects; offset++) {
	let added = false
	for (const site of selectedSites) {
		const key = perSiteCandidates.get(site.id)?.[offset]
		if (!key || selectedObjects >= maxObjects) continue
		const existing = selectedKeysBySite.get(site.id)
		if (existing) existing.push(key)
		else selectedKeysBySite.set(site.id, [key])
		selectedObjects++
		added = true
	}
	if (!added) break
}
selectedSites = selectedSites.filter(
	(site) => requestedSites.length > 0 || (selectedKeysBySite.get(site.id)?.length ?? 0) > 0,
)

const identityFetch: Parameters<typeof getPdsForDid>[1] = (url, options) =>
	safeFetch(url, { signal: options?.signal, byteBudget: options?.byteBudget })
const pdsEndpoints = new Map<string, string>()
async function resolvePdsEndpoint(did: string, signal: AbortSignal): Promise<string> {
	const existing = pdsEndpoints.get(did)
	if (existing) return existing
	const endpoint = await getPdsForDid(did, identityFetch, undefined, { signal })
	if (!endpoint) throw new Error('PDS_UNRESOLVED')
	pdsEndpoints.set(did, endpoint)
	return endpoint
}

async function fetchCanonicalSite(site: SiteRef): Promise<CanonicalSite | null> {
	const signal = AbortSignal.timeout(30_000)
	const rootPds = await resolvePdsEndpoint(site.did, signal)
	const query = new URLSearchParams({ repo: site.did, collection: 'place.wisp.fs', rkey: site.rkey })
	const response = await safeFetch(`${rootPds}/xrpc/com.atproto.repo.getRecord?${query.toString()}`, {
		signal,
		maxSize: MAX_PDS_RECORD_BYTES,
	})
	if (response.status === 404) {
		await response.body?.cancel()
		return null
	}
	if (!response.ok) {
		if (response.status === 400) {
			const errorBody = (await response.json()) as { error?: unknown }
			if (errorBody.error === 'RecordNotFound') return null
		} else {
			await response.body?.cancel()
		}
		throw new Error(`PDS_RECORD_HTTP_${response.status}`)
	}
	const body = (await response.json()) as { cid?: unknown; value?: unknown }
	if (typeof body.cid !== 'string' || body.cid.length === 0) throw new Error('PDS_RECORD_MISSING_CID')
	const record = parseLexiconJson<WispFsRecord>(body.value)
	if (!validateFsRecord(record).success || !record.root?.entries) throw new Error('PDS_RECORD_INVALID')

	const expanded = await expandSubfs(record.root, {
		rootOwnerDid: site.did,
		signal,
		limits: {
			maxConcurrentFetches: Math.min(4, concurrency),
			maxDepth: 10,
			maxEntries: 40_000,
			maxFiles: 10_000,
			maxRecords: 100,
			maxRawJsonBytes: 10 * 1024 * 1024,
		},
		fetchSubfsRecord: async (subject: SubfsSubject) => {
			const endpoint = await resolvePdsEndpoint(subject.repo, signal)
			const subjectQuery = new URLSearchParams({
				repo: subject.repo,
				collection: subject.collection,
				rkey: subject.rkey,
			})
			const data = await safeFetchJson<{ value?: unknown }>(
				`${endpoint}/xrpc/com.atproto.repo.getRecord?${subjectQuery.toString()}`,
				{ signal, maxSize: MAX_PDS_RECORD_BYTES },
			)
			return data.value
		},
	})
	const fileCids: Record<string, string> = {}
	collectFileCidsFromEntries(expanded.root.entries, '', fileCids)
	return { ...site, recordCid: body.cid, fileCids, ownerDidByPath: expanded.ownerDidByFilePath }
}

function increment(counts: Record<string, number>, kind: string): void {
	counts[kind] = (counts[kind] ?? 0) + 1
}

async function auditSite(site: SiteRef): Promise<SiteResult> {
	const keys = selectedKeysBySite.get(site.id) ?? []
	let canonical: CanonicalSite | null
	try {
		canonical = await fetchCanonicalSite(site)
	} catch (error) {
		return {
			...site,
			status: 'record_error',
			selectedObjects: keys.length,
			counts: {},
			findings: [],
			error: safeError(error),
		}
	}
	if (!canonical) {
		return {
			...site,
			status: 'record_absent',
			selectedObjects: keys.length,
			counts: { record_absent: 1, orphaned_cached_path: keys.length },
			findings: keys.slice(0, MAX_ISSUE_DETAILS).map((key) => ({ kind: 'orphaned_cached_path', key })),
		}
	}

	const counts: Record<string, number> = {}
	const findings = await mapConcurrent(keys, concurrency, async (key): Promise<Finding> => {
		const parsed = parseObjectKey(key)!
		const expectedCid = canonical.fileCids[parsed.canonicalPath]
		const expectedDid = canonical.ownerDidByPath.get(parsed.canonicalPath)
		if (!expectedCid || !expectedDid) {
			increment(counts, 'orphaned_cached_path')
			return { kind: 'orphaned_cached_path', key }
		}
		try {
			const metadata = await tier.getMetadata(key)
			if (!metadata) {
				increment(counts, 'metadata_missing')
				return { kind: 'metadata_missing', key, expectedCid, expectedDid }
			}
			const observedCid = metadata.customMetadata?.sourceCid
			const observedDid = metadata.customMetadata?.sourceDid
			if (!observedCid || !observedDid) {
				increment(counts, 'missing_source_identity')
				return { kind: 'missing_source_identity', key, expectedCid, observedCid, expectedDid, observedDid }
			}
			const cidMatches = observedCid === expectedCid
			const didMatches = observedDid === expectedDid
			if (cidMatches && didMatches) {
				increment(counts, 'match')
				return { kind: 'match', key }
			}
			const kind =
				!cidMatches && !didMatches
					? 'source_cid_and_did_mismatch'
					: cidMatches
						? 'source_did_mismatch'
						: 'source_cid_mismatch'
			increment(counts, kind)
			return { kind, key, expectedCid, observedCid, expectedDid, observedDid }
		} catch (error) {
			increment(counts, 'metadata_read_error')
			return { kind: 'metadata_read_error', key, expectedCid, expectedDid, error: safeError(error) }
		}
	})

	return {
		...site,
		status: 'audited',
		recordCid: canonical.recordCid,
		canonicalFiles: Object.keys(canonical.fileCids).length,
		selectedObjects: keys.length,
		counts,
		findings: findings.filter((finding) => finding.kind !== 'match').slice(0, MAX_ISSUE_DETAILS),
	}
}

console.error(
	`Auditing ${selectedObjects} objects across ${selectedSites.length} sites with concurrency ${concurrency} (read-only)...`,
)
const siteResults = await mapConcurrent(selectedSites, Math.min(concurrency, 4), auditSite)
const totals: Record<string, number> = {}
for (const site of siteResults) {
	increment(totals, `site_${site.status}`)
	for (const [kind, count] of Object.entries(site.counts)) totals[kind] = (totals[kind] ?? 0) + count
}

const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	readOnly: true,
	security: {
		sshInvoked: false,
		credentialValuesReported: false,
		reportIncludesObjectBytes: false,
		reportIncludesConnectionStrings: false,
		reportMode: '0600',
	},
	scope: {
		all: values.all,
		prefix: values.prefix ?? null,
		seed: values.seed,
		requestedSites: requestedSites.map((site) => site.id),
		listedObjects,
		discoveredSites: discoveredSites.length,
		malformedKeys,
		selectedSites: selectedSites.length,
		selectedObjects,
		maxSites: values.all ? null : maxSites,
		maxObjects: values.all ? null : maxObjects,
		concurrency,
	},
	totals,
	sites: siteResults,
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ reportPath, scope: report.scope, totals }, null, 2))

const findingKinds = [
	'missing_source_identity',
	'source_cid_mismatch',
	'source_did_mismatch',
	'source_cid_and_did_mismatch',
	'orphaned_cached_path',
	'metadata_missing',
	'metadata_read_error',
]
if (
	values['fail-on-findings'] &&
	((totals.site_record_error ?? 0) > 0 || findingKinds.some((kind) => (totals[kind] ?? 0) > 0))
) {
	process.exitCode = 2
}
