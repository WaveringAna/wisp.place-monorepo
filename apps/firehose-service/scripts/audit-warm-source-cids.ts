#!/usr/bin/env bun
/**
 * Read-only warm-cache source identity audit.
 *
 * Inputs are local DiskStorageTier cache directories or sanitized JSONL
 * inventories containing only: node, key, sourceCid, and sourceDid.
 * The script does not invoke SSH, use environment endpoint overrides, or accept credentials.
 */
import { opendir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import { expandSubfs, getPdsForDid, type SubfsSubject } from '@wispplace/atproto-utils'
import { collectFileCidsFromEntries } from '@wispplace/fs-utils'
import { parseLexiconJson } from '@wispplace/lexicons/public-json'
import type { Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { validateRecord as validateFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { safeFetch, safeFetchJson } from '@wispplace/safe-fetch'

const DEFAULT_MAX_SITES = 50
const DEFAULT_MAX_OBJECTS = 2_000
const DEFAULT_CONCURRENCY = 8
const MAX_PDS_RECORD_BYTES = 1024 * 1024
const MAX_METADATA_BYTES = 64 * 1024
const MAX_ISSUE_DETAILS = 500

// Do not let Bun's automatic .env loading redirect this standalone audit to a
// local identity service. The audit always uses the public identity defaults.
for (const name of ['WISP_PLC_DIRECTORY_URL', 'WISP_HANDLE_RESOLVER_URL', 'WISP_ALLOW_LOCALHOST_FETCH']) {
	delete process.env[name]
}

interface WarmEntry {
	node: string
	key: string
	sourceCid?: string
	sourceDid?: string
}

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
	| 'orphaned_warm_path'
	| 'record_absent'
	| 'record_error'

interface Finding {
	kind: FindingKind
	node: string
	key: string
	expectedCid?: string
	observedCid?: string
	expectedDid?: string
	observedDid?: string
	errorCode?: string
}

class AuditError extends Error {
	constructor(readonly code: string) {
		super(code)
		this.name = 'AuditError'
	}
}

function help(): never {
	console.log(`Usage:
  bun --no-env-file apps/firehose-service/scripts/audit-warm-source-cids.ts [options]

Input options (at least one is required):
  --inventory <path>    Sanitized JSONL inventory; repeatable
  --cache-dir <path>    Local DiskStorageTier cache directory; repeatable
  --node <label>        Node label for one --cache-dir input (default: local)

Audit options:
  --max-sites <n>       Deterministically sample at most this many sites (default: ${DEFAULT_MAX_SITES})
  --max-objects <n>     Audit at most this many warm objects (default: ${DEFAULT_MAX_OBJECTS})
  --concurrency <n>     Concurrent PDS reads (default: ${DEFAULT_CONCURRENCY})
  --site <did/rkey>     Audit a specific site; repeatable
  --seed <text>         Deterministic sample seed (default: wisp-warm-cid-audit-v1)
  --report <path>       JSON report path (default: /tmp/wisp-warm-cid-audit-<timestamp>.json)
  --all                 Audit every discovered site and inventory entry
  --fail-on-findings    Exit 2 for mismatches, orphans, missing identity, or incomplete PDS reads
  --help                Show this help

Inventory JSONL schema:
  {"node":"edge-a","key":"did:plc:.../rkey/index.html","sourceCid":"bafk...","sourceDid":"did:plc:..."}

The script is read-only. It does not invoke SSH or accept credentials. It clears
identity endpoint overrides and does not include cache bytes, checksums, environment
values, or connection strings in reports. Use --no-env-file as shown above.`)
	process.exit(0)
}

function parsePositiveInteger(raw: string | undefined, name: string, fallback: number): number {
	if (raw === undefined) return fallback
	const value = Number(raw)
	if (!Number.isSafeInteger(value) || value < 1) throw new AuditError(`${name.slice(2).toUpperCase()}_INVALID`)
	return value
}

function parseSiteId(value: string): SiteRef {
	const slash = value.indexOf('/')
	if (slash <= 0 || slash === value.length - 1) throw new AuditError('SITE_INVALID')
	const did = value.slice(0, slash)
	const rkey = value.slice(slash + 1)
	if (!did.startsWith('did:') || rkey.includes('/')) throw new AuditError('SITE_INVALID')
	return { did, rkey, id: `${did}/${rkey}` }
}

function parseObjectKey(key: string): (SiteRef & { canonicalPath: string }) | null {
	const firstSlash = key.indexOf('/')
	const secondSlash = key.indexOf('/', firstSlash + 1)
	if (firstSlash <= 0 || secondSlash <= firstSlash + 1 || secondSlash === key.length - 1) return null
	const did = key.slice(0, firstSlash)
	const rkey = key.slice(firstSlash + 1, secondSlash)
	const objectPath = key.slice(secondSlash + 1)
	if (!did.startsWith('did:')) return null
	const canonicalPath = objectPath.startsWith('.rewritten/') ? objectPath.slice('.rewritten/'.length) : objectPath
	if (!canonicalPath) return null
	return { did, rkey, id: `${did}/${rkey}`, canonicalPath }
}

function boundedString(value: unknown, maximum: number): string | undefined {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : undefined
}

function parseInventoryRow(raw: unknown): WarmEntry | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
	const row = raw as Record<string, unknown>
	const node = boundedString(row.node, 128)
	const key = boundedString(row.key, 8192)
	if (!node || !key) return null
	const sourceCid = boundedString(row.sourceCid, 512)
	const sourceDid = boundedString(row.sourceDid, 2048)
	return { node, key, ...(sourceCid ? { sourceCid } : {}), ...(sourceDid ? { sourceDid } : {}) }
}

async function loadInventory(path: string): Promise<{ entries: WarmEntry[]; invalidRows: number }> {
	const text = await readFile(path, 'utf8')
	const entries: WarmEntry[] = []
	let invalidRows = 0
	for (const line of text.split('\n')) {
		if (!line.trim()) continue
		try {
			const entry = parseInventoryRow(JSON.parse(line))
			if (entry) entries.push(entry)
			else invalidRows++
		} catch {
			invalidRows++
		}
	}
	return { entries, invalidRows }
}

async function* metadataFiles(root: string, directory = root): AsyncGenerator<string> {
	const handle = await opendir(directory)
	for await (const entry of handle) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) yield* metadataFiles(root, path)
		else if (entry.isFile() && entry.name.endsWith('.meta')) yield path
	}
}

async function loadCacheDirectory(root: string, node: string): Promise<{ entries: WarmEntry[]; invalidRows: number }> {
	const entries: WarmEntry[] = []
	let invalidRows = 0
	for await (const path of metadataFiles(root)) {
		try {
			const bytes = await readFile(path)
			if (bytes.byteLength > MAX_METADATA_BYTES) throw new AuditError('METADATA_OVERSIZED')
			const metadata = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
			const fallbackKey = relative(root, path).slice(0, -'.meta'.length)
			const key = boundedString(metadata.key, 8192) ?? fallbackKey
			const custom =
				typeof metadata.customMetadata === 'object' && metadata.customMetadata !== null
					? (metadata.customMetadata as Record<string, unknown>)
					: {}
			const parsed = parseInventoryRow({
				node,
				key,
				sourceCid: custom.sourceCid,
				sourceDid: custom.sourceDid,
			})
			if (parsed) entries.push(parsed)
			else invalidRows++
		} catch {
			invalidRows++
		}
	}
	return { entries, invalidRows }
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
			const leftId = identity(left)
			const rightId = identity(right)
			return stableHash(`${seed}:${leftId}`) - stableHash(`${seed}:${rightId}`) || leftId.localeCompare(rightId)
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

function errorCode(error: unknown): string {
	if (error instanceof AuditError) return error.code
	if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT'
	return 'FETCH_FAILED'
}

const { values } = parseArgs({
	options: {
		all: { type: 'boolean', default: false },
		'cache-dir': { type: 'string', multiple: true, default: [] },
		concurrency: { type: 'string' },
		'fail-on-findings': { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false },
		inventory: { type: 'string', multiple: true, default: [] },
		'max-objects': { type: 'string' },
		'max-sites': { type: 'string' },
		node: { type: 'string' },
		report: { type: 'string' },
		seed: { type: 'string', default: 'wisp-warm-cid-audit-v1' },
		site: { type: 'string', multiple: true, default: [] },
	},
	strict: true,
	allowPositionals: false,
})
if (values.help) help()
if ((values.inventory?.length ?? 0) === 0 && (values['cache-dir']?.length ?? 0) === 0)
	throw new AuditError('INPUT_REQUIRED')
if (values.node && (values['cache-dir']?.length ?? 0) !== 1) throw new AuditError('NODE_REQUIRES_ONE_CACHE_DIR')

const concurrency = parsePositiveInteger(values.concurrency, '--concurrency', DEFAULT_CONCURRENCY)
const maxSites = values.all
	? Number.MAX_SAFE_INTEGER
	: parsePositiveInteger(values['max-sites'], '--max-sites', DEFAULT_MAX_SITES)
const maxObjects = values.all
	? Number.MAX_SAFE_INTEGER
	: parsePositiveInteger(values['max-objects'], '--max-objects', DEFAULT_MAX_OBJECTS)
const requestedSites = (values.site ?? []).map(parseSiteId)
const reportPath = values.report ?? `/tmp/wisp-warm-cid-audit-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`

const loaded: WarmEntry[] = []
let invalidInventoryRows = 0
for (const path of values.inventory ?? []) {
	const result = await loadInventory(path)
	loaded.push(...result.entries)
	invalidInventoryRows += result.invalidRows
}
for (const [index, root] of (values['cache-dir'] ?? []).entries()) {
	const node = values.node ?? `${basename(root) || 'local'}-${index + 1}`
	const result = await loadCacheDirectory(root, node)
	loaded.push(...result.entries)
	invalidInventoryRows += result.invalidRows
}

const entries = [...new Map(loaded.map((entry) => [`${entry.node}\0${entry.key}`, entry])).values()]
const siteById = new Map<string, SiteRef>()
let malformedKeys = 0
for (const entry of entries) {
	const parsed = parseObjectKey(entry.key)
	if (parsed) siteById.set(parsed.id, parsed)
	else malformedKeys++
}
const discoveredSites = [...siteById.values()].sort((left, right) => left.id.localeCompare(right.id))
const selectedSites =
	requestedSites.length > 0
		? [...new Map(requestedSites.map((site) => [site.id, site])).values()]
		: deterministicSample(discoveredSites, maxSites, (site) => site.id, values.seed!)
const selectedSiteIds = new Set(selectedSites.map((site) => site.id))
const eligibleEntries = entries.filter((entry) => {
	const parsed = parseObjectKey(entry.key)
	return parsed !== null && selectedSiteIds.has(parsed.id)
})
const selectedEntries = deterministicSample(
	eligibleEntries,
	maxObjects,
	(entry) => `${entry.node}:${entry.key}`,
	values.seed!,
)

const identityFetch: Parameters<typeof getPdsForDid>[1] = (url, options) =>
	safeFetch(url, { signal: options?.signal, byteBudget: options?.byteBudget })
const pdsEndpoints = new Map<string, string>()
async function resolvePdsEndpoint(did: string, signal: AbortSignal): Promise<string> {
	const existing = pdsEndpoints.get(did)
	if (existing) return existing
	const endpoint = await getPdsForDid(did, identityFetch, undefined, { signal })
	if (!endpoint) throw new AuditError('PDS_UNRESOLVED')
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
			const body = (await response.json()) as { error?: unknown }
			if (body.error === 'RecordNotFound') return null
		} else await response.body?.cancel()
		throw new AuditError(`PDS_RECORD_HTTP_${response.status}`)
	}
	const body = (await response.json()) as { cid?: unknown; value?: unknown }
	if (typeof body.cid !== 'string' || body.cid.length === 0) throw new AuditError('PDS_RECORD_MISSING_CID')
	const record = parseLexiconJson<WispFsRecord>(body.value)
	if (!validateFsRecord(record).success || !record.root?.entries) throw new AuditError('PDS_RECORD_INVALID')
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

console.error(
	`Auditing ${selectedEntries.length} warm objects across ${selectedSites.length} sites and ${new Set(selectedEntries.map((entry) => entry.node)).size} nodes (read-only)...`,
)
const canonicalResults = await mapConcurrent(selectedSites, Math.min(concurrency, 4), async (site) => {
	try {
		return { site, canonical: await fetchCanonicalSite(site) }
	} catch (error) {
		return { site, canonical: undefined, errorCode: errorCode(error) }
	}
})
const canonicalBySite = new Map(canonicalResults.map((result) => [result.site.id, result]))

const findings: Finding[] = []
const totals: Record<string, number> = {}
const byNode: Record<string, Record<string, number>> = {}
function increment(node: string, kind: FindingKind): void {
	totals[kind] = (totals[kind] ?? 0) + 1
	byNode[node] ??= {}
	byNode[node]![kind] = (byNode[node]![kind] ?? 0) + 1
}
function addFinding(finding: Finding): void {
	increment(finding.node, finding.kind)
	if (finding.kind !== 'match' && findings.length < MAX_ISSUE_DETAILS) findings.push(finding)
}

for (const entry of selectedEntries) {
	const parsed = parseObjectKey(entry.key)!
	const result = canonicalBySite.get(parsed.id)!
	if (result.errorCode) {
		addFinding({ kind: 'record_error', node: entry.node, key: entry.key, errorCode: result.errorCode })
		continue
	}
	if (!result.canonical) {
		addFinding({ kind: 'record_absent', node: entry.node, key: entry.key })
		continue
	}
	const expectedCid = result.canonical.fileCids[parsed.canonicalPath]
	const expectedDid = result.canonical.ownerDidByPath.get(parsed.canonicalPath)
	if (!expectedCid || !expectedDid) {
		addFinding({ kind: 'orphaned_warm_path', node: entry.node, key: entry.key })
		continue
	}
	if (!entry.sourceCid || !entry.sourceDid) {
		addFinding({
			kind: 'missing_source_identity',
			node: entry.node,
			key: entry.key,
			expectedCid,
			observedCid: entry.sourceCid,
			expectedDid,
			observedDid: entry.sourceDid,
		})
		continue
	}
	const cidMatches = entry.sourceCid === expectedCid
	const didMatches = entry.sourceDid === expectedDid
	if (cidMatches && didMatches) {
		addFinding({ kind: 'match', node: entry.node, key: entry.key })
		continue
	}
	const kind =
		!cidMatches && !didMatches
			? 'source_cid_and_did_mismatch'
			: cidMatches
				? 'source_did_mismatch'
				: 'source_cid_mismatch'
	addFinding({
		kind,
		node: entry.node,
		key: entry.key,
		expectedCid,
		observedCid: entry.sourceCid,
		expectedDid,
		observedDid: entry.sourceDid,
	})
}

const report = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	readOnly: true,
	security: {
		credentialInputs: false,
		sshInvoked: false,
		reportIncludesCacheBytes: false,
		reportIncludesChecksums: false,
		reportMode: '0600',
	},
	scope: {
		all: values.all,
		seed: values.seed,
		inventoryFiles: values.inventory?.length ?? 0,
		cacheDirectories: values['cache-dir']?.length ?? 0,
		invalidInventoryRows,
		loadedObjects: entries.length,
		discoveredSites: discoveredSites.length,
		malformedKeys,
		selectedSites: selectedSites.length,
		selectedObjects: selectedEntries.length,
		selectedNodes: [...new Set(selectedEntries.map((entry) => entry.node))].sort(),
		maxSites: values.all ? null : maxSites,
		maxObjects: values.all ? null : maxObjects,
		concurrency,
	},
	totals,
	byNode,
	findings,
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ reportPath, scope: report.scope, totals, byNode }, null, 2))

if (values['fail-on-findings'] && Object.entries(totals).some(([kind, count]) => kind !== 'match' && count > 0)) {
	process.exitCode = 2
}
