import { computeCID } from '@wispplace/atproto-utils'
import { casKey, type FileObjects } from '@wispplace/fs-utils'
import type { StorageMetadata } from '@wispplace/tiered-storage'
import { shouldStayCompressed } from './stored-file-rules'

/**
 * One-shot conversion of `{did}/{rkey}/{path}` objects to content-addressed keys (CAS_STORAGE.md).
 *
 * The new cache writer derives a body's key from the manifest's `mimeType`, `encoding` and `base64`.
 * The old objects only record what was *stored*, so the manifest's encoding has to be recovered from
 * that, and only where it is unambiguous. Anything else is skipped and simply repulled from the PDS
 * the next time the site updates: the PDS is the source of truth.
 */

export type SkipReason =
	| 'missing-object'
	| 'no-source-cid'
	| 'cid-mismatch'
	| 'bad-metadata'
	| 'not-raw-blob'
	| 'changed-during-copy'

const SKIP_REASONS: readonly SkipReason[] = [
	'missing-object',
	'no-source-cid',
	'cid-mismatch',
	'bad-metadata',
	'not-raw-blob',
	'changed-during-copy',
]

type CasCustomMetadata = Record<string, string>

export type Classification =
	| { kind: 'ready'; key: string; custom: CasCustomMetadata }
	/** Stored identity under a type that a gzip manifest would have decompressed: only the bytes can tell. */
	| { kind: 'needs-raw-check'; key: string; custom: CasCustomMetadata }
	| { kind: 'skip'; reason: SkipReason }

const skip = (reason: SkipReason): Classification => ({ kind: 'skip', reason })

/**
 * Work out the CAS key the writer would give this file, from its legacy object's metadata alone.
 *
 * The writer keeps gzip only for types that benefit from it and decompresses everything else, whatever
 * the manifest said. Inverting that:
 *  - stored gzip: the type stays compressed (nothing else is ever stored as gzip), and the manifest said
 *    gzip. A manifest that left the encoding out of gzip bytes would store the same object, but under a
 *    key without the encoding; that one-off key difference only costs a repull on that site's next update;
 *  - stored identity under a type that stays compressed: the manifest said nothing;
 *  - stored identity under any other type: the manifest said nothing, or said gzip and the writer
 *    decompressed it. Those differ in their bytes, so this needs a look at them.
 */
export function classifyLegacyFile(
	file: { path: string; cid: string },
	metadata: StorageMetadata | null,
): Classification {
	if (!metadata) return skip('missing-object')
	const custom = metadata.customMetadata
	if (!custom?.sourceCid) return skip('no-source-cid')
	if (custom.sourceCid !== file.cid) return skip('cid-mismatch')
	if (!custom.uncompressedSize || !/^\d+$/.test(custom.uncompressedSize)) return skip('bad-metadata')
	if (custom.base64 !== 'true' && custom.base64 !== 'false') return skip('bad-metadata')
	if (custom.encoding !== undefined && custom.encoding !== 'gzip') return skip('bad-metadata')

	const mimeType = custom.mimeType || undefined
	const base64 = custom.base64 === 'true'
	const stays = shouldStayCompressed(file.path, mimeType)
	let manifestEncoding: 'gzip' | undefined
	let ambiguous = false
	if (custom.encoding === 'gzip') {
		if (!stays) return skip('bad-metadata')
		manifestEncoding = 'gzip'
	} else {
		ambiguous = !stays
	}

	let key: string
	try {
		key = casKey({ cid: file.cid, path: file.path, mimeType, encoding: manifestEncoding, base64 })
	} catch {
		return skip('bad-metadata')
	}
	const casCustom: CasCustomMetadata = {
		sourceCid: file.cid,
		base64: custom.base64,
		uncompressedSize: custom.uncompressedSize,
		...(mimeType ? { mimeType } : {}),
		...(custom.encoding ? { encoding: custom.encoding } : {}),
	}
	return { kind: ambiguous ? 'needs-raw-check' : 'ready', key, custom: casCustom }
}

/** Everything the migration needs from storage and the database, so it can be tested without either. */
export interface MigrationPorts {
	getMetadata(key: string): Promise<StorageMetadata | null>
	readObject(key: string): Promise<Uint8Array | null>
	/** Copy inside storage with the given metadata; false when the source is gone or no longer has `expectedChecksum`. */
	copyObject(from: string, to: string, metadata: StorageMetadata, expectedChecksum: string): Promise<boolean>
	registerObject(key: string, size: number): Promise<void>
	commitMapping(
		did: string,
		rkey: string,
		expected: {
			fileCids: Record<string, string>
			fileObjects: FileObjects | null
			recordCid: string
			updatedAt: number
		},
		mapping: FileObjects,
	): Promise<'committed' | 'stale'>
	deleteObject(key: string): Promise<void>
	listLegacyKeys(prefix: string): Promise<string[]>
}

export interface SiteToMigrate {
	did: string
	rkey: string
	fileCids: Record<string, string>
	fileObjects: FileObjects | null
	recordCid: string
	updatedAt: number
}

export interface SiteMigrationReport {
	did: string
	rkey: string
	status: 'migrated' | 'partial' | 'empty' | 'stale' | 'dry-run'
	/** Bodies copied (or, in a dry run, that would be). */
	copied: number
	/** Bodies that already existed under their CAS key. */
	reused: number
	skipped: Record<SkipReason, number>
}

function emptySkipped(): Record<SkipReason, number> {
	return Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<SkipReason, number>
}

const REWRITTEN_PREFIX = '.rewritten/'

/** The metadata of the new object: the old one, rekeyed, without the owner it no longer belongs to. */
function casObjectMetadata(source: StorageMetadata, key: string, custom: CasCustomMetadata): StorageMetadata {
	return { ...source, key, accessCount: 0, lastAccessed: new Date(), customMetadata: custom }
}

export async function migrateSite(
	site: SiteToMigrate,
	ports: MigrationPorts,
	options: { dryRun: boolean },
): Promise<SiteMigrationReport> {
	const report: SiteMigrationReport = {
		did: site.did,
		rkey: site.rkey,
		status: 'empty',
		copied: 0,
		reused: 0,
		skipped: emptySkipped(),
	}
	const mapping: FileObjects = {}
	const sizes = new Map<string, number>()

	for (const [path, cid] of Object.entries(site.fileCids)) {
		if (path.startsWith(REWRITTEN_PREFIX)) continue
		const legacyKey = `${site.did}/${site.rkey}/${path}`
		const metadata = await ports.getMetadata(legacyKey)
		const classification = classifyLegacyFile({ path, cid }, metadata)
		if (classification.kind === 'skip' || !metadata) {
			report.skipped[classification.kind === 'skip' ? classification.reason : 'missing-object']++
			continue
		}
		if (classification.kind === 'needs-raw-check') {
			const bytes = await ports.readObject(legacyKey)
			if (!bytes) {
				report.skipped['missing-object']++
				continue
			}
			if (computeCID(bytes) !== cid) {
				report.skipped['not-raw-blob']++
				continue
			}
		}

		const { key } = classification
		if (await ports.getMetadata(key)) {
			report.reused++
		} else if (options.dryRun) {
			report.copied++
		} else {
			const copied = await ports.copyObject(
				legacyKey,
				key,
				casObjectMetadata(metadata, key, classification.custom),
				metadata.checksum,
			)
			if (!copied) {
				report.skipped['changed-during-copy']++
				continue
			}
			report.copied++
		}
		mapping[path] = key
		sizes.set(key, metadata.size)
	}

	if (options.dryRun) return { ...report, status: 'dry-run' }
	if (Object.keys(mapping).length === 0) return report

	// Idempotent: objects the writer or an earlier run registered keep their row.
	for (const [key, size] of sizes) await ports.registerObject(key, size)
	const outcome = await ports.commitMapping(
		site.did,
		site.rkey,
		{ fileCids: site.fileCids, fileObjects: site.fileObjects, recordCid: site.recordCid, updatedAt: site.updatedAt },
		mapping,
	)
	const skippedTotal = Object.values(report.skipped).reduce((sum, count) => sum + count, 0)
	return { ...report, status: outcome === 'stale' ? 'stale' : skippedTotal > 0 ? 'partial' : 'migrated' }
}

export interface LegacyDeleteResult {
	deleted: number
	skipped?: 'incomplete-mapping' | 'missing-object'
}

/**
 * Remove a site's legacy originals once everything they were copied to is verifiably in place. Only
 * the site's own `{did}/{rkey}/{path}` keys go: never `.rewritten/` HTML (per site) and never `cas/`.
 */
export async function deleteLegacyObjects(
	site: SiteToMigrate & { fileObjects: FileObjects | null },
	ports: MigrationPorts,
): Promise<LegacyDeleteResult> {
	const { fileObjects } = site
	const paths = Object.keys(site.fileCids)
	if (!fileObjects || !paths.every((path) => Object.getOwnPropertyDescriptor(fileObjects, path) !== undefined)) {
		return { deleted: 0, skipped: 'incomplete-mapping' }
	}
	for (const key of new Set(Object.values(fileObjects))) {
		if (!(await ports.getMetadata(key))) return { deleted: 0, skipped: 'missing-object' }
	}

	const prefix = `${site.did}/${site.rkey}/`
	const legacy = new Set(paths.filter((path) => !path.startsWith(REWRITTEN_PREFIX)).map((path) => `${prefix}${path}`))
	let deleted = 0
	for (const key of await ports.listLegacyKeys(prefix)) {
		if (!legacy.has(key)) continue
		await ports.deleteObject(key)
		deleted++
	}
	return { deleted }
}
