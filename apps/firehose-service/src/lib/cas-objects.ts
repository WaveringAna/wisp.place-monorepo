import {
	type CasReferenceDiff,
	diffCasReferences,
	type FileObjects,
	isCasKey,
	normalizeFileCids,
	normalizeFileObjects,
} from '@wispplace/fs-utils'
import type { Sql } from 'postgres'

/** Statements issued per round trip while moving references; bounds one site's pipeline. */
const REFERENCE_BATCH = 500

/**
 * Register a body about to be written to storage, before any site references it. Registering first is
 * what keeps it from the garbage collector: the row exists, with a fresh clock, before the object does.
 * It starts unreferenced, so a crash before the site commit leaves a recoverable object, never a
 * dangling reference. Idempotent: an existing row keeps its references, an unreferenced one gets a
 * fresh clock, and a missing size is filled in.
 */
export async function recordCasObject(sql: Sql, key: string, size: number): Promise<void> {
	if (!isCasKey(key)) throw new Error('Refusing to record a key that is not a CAS key')
	await sql`
		INSERT INTO cas_objects (key, refs, size) VALUES (${key}, 0, ${size})
		ON CONFLICT (key) DO UPDATE SET
			size = COALESCE(cas_objects.size, EXCLUDED.size),
			unreferenced_at = CASE
				WHEN cas_objects.refs = 0 THEN EXTRACT(EPOCH FROM NOW())
				ELSE cas_objects.unreferenced_at
			END
	`
}

/**
 * Move one site's references from its stored `file_objects` to `next` (null: nothing mapped, e.g. deleted) and store `next`, in the caller's transaction. The site's row must already exist; it is
 * locked, so concurrent updates of one site serialize.
 *
 * Reference rows are touched one key at a time in sorted order across adds and releases. Two
 * sites changing overlapping key sets therefore always lock in the same order and cannot deadlock.
 * A stored mapping that no longer parses is treated as empty, so its references are never released
 * here; the reconcile job is what repairs that drift.
 */
export async function applyCasReferences(
	tx: Sql,
	did: string,
	rkey: string,
	next: FileObjects | null,
): Promise<CasReferenceDiff> {
	const rows = await tx<Array<{ file_objects: unknown }>>`
		SELECT file_objects FROM site_cache WHERE did = ${did} AND rkey = ${rkey} FOR UPDATE
	`
	const row = rows[0]
	if (!row) throw new Error(`Cannot apply CAS references: no site_cache row for ${did}/${rkey}`)

	// Nothing mapped before and nothing now (a tombstone rewritten, or an unconverted site): leave the row alone.
	if (row.file_objects === null && next === null) return { added: new Set(), removed: new Set() }

	const diff = diffCasReferences(normalizeFileObjects(row.file_objects), next)
	const changes = [
		...[...diff.added].map((key) => ({ key, add: true })),
		...[...diff.removed].map((key) => ({ key, add: false })),
	].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

	for (let start = 0; start < changes.length; start += REFERENCE_BATCH) {
		// Issued together, executed in order on this connection.
		await Promise.all(
			changes.slice(start, start + REFERENCE_BATCH).map(({ key, add }) =>
				add
					? tx`
						INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${key}, 1, NULL)
						ON CONFLICT (key) DO UPDATE
						SET refs = cas_objects.refs + 1, unreferenced_at = NULL
					`
					: tx`
						UPDATE cas_objects
						SET refs = refs - 1,
							unreferenced_at = CASE WHEN refs - 1 <= 0 THEN EXTRACT(EPOCH FROM NOW()) ELSE unreferenced_at END
						WHERE key = ${key} AND refs > 0
					`,
			),
		)
	}

	await tx`
		UPDATE site_cache SET file_objects = ${next === null ? null : tx.json(next)}
		WHERE did = ${did} AND rkey = ${rkey}
	`
	return diff
}

/**
 * Restart the garbage-collection clock of unreferenced objects a site update is about to reuse, so
 * the sweeper cannot delete one between the update finding it and committing its reference. Returns
 * the keys that still have a row. A key missing from that answer was collected after the update found
 * its object, so the caller must not reuse it. Referenced objects are left alone, and no row is created.
 *
 * Two statements on purpose: if the sweeper holds a row, the update waits for it, and only a statement
 * that starts afterwards sees the row gone.
 */
export async function touchCasObjects(sql: Sql, keys: readonly string[]): Promise<string[]> {
	if (keys.length === 0) return []
	if (!keys.every(isCasKey)) throw new Error('Refusing to touch a key that is not a CAS key')
	const wanted = [...keys]
	await sql`
		UPDATE cas_objects SET unreferenced_at = EXTRACT(EPOCH FROM NOW())
		WHERE key = ANY(${wanted}) AND refs = 0
	`
	const alive = await sql<Array<{ key: string }>>`SELECT key FROM cas_objects WHERE key = ANY(${wanted})`
	return alive.map((row) => row.key)
}

export interface MigrationSiteRow {
	did: string
	rkey: string
	fileCids: Record<string, string>
	fileObjects: FileObjects | null
	recordCid: string
	updatedAt: number
}

/** A page of live sites after `after`, in (did, rkey) order. Tombstones and absent sites are not migrated. */
export async function listSitesForMigration(
	sql: Sql,
	after: { did: string; rkey: string } | null,
	limit: number,
	deletedRecordCid: string,
): Promise<MigrationSiteRow[]> {
	const rows = await sql<
		Array<{
			did: string
			rkey: string
			file_cids: unknown
			file_objects: unknown
			record_cid: string
			updated_at: number | string
		}>
	>`
		SELECT did, rkey, file_cids, file_objects, record_cid, updated_at FROM site_cache
		WHERE record_cid <> ${deletedRecordCid} AND absent_since IS NULL
			AND (${after === null} OR (did, rkey) > (${after?.did ?? ''}, ${after?.rkey ?? ''}))
		ORDER BY did, rkey
		LIMIT ${limit}
	`
	return rows.map((row) => ({
		did: row.did,
		rkey: row.rkey,
		fileCids: normalizeFileCids(row.file_cids).value,
		fileObjects: normalizeFileObjects(row.file_objects),
		recordCid: row.record_cid,
		updatedAt: Number(row.updated_at),
	}))
}

function sameFileCids(a: Record<string, string>, b: Record<string, string>): boolean {
	const keys = Object.keys(a)
	return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/**
 * Store a migrated mapping for one site, atomically with its references. It is applied only if the
 * site is exactly as it was when scanned, and only if it does not contradict a mapping already there:
 * a site the cache writer has since rewritten is the writer's, and the migration leaves it alone.
 */
function sameFileObjects(a: FileObjects | null, b: FileObjects | null): boolean {
	if (a === null && b === null) return true
	if (a === null || b === null) return false
	const keysA = Object.keys(a)
	const keysB = Object.keys(b)
	return keysA.length === keysB.length && keysA.every((k) => a[k] === b[k])
}

/**
 * Expected site snapshot captured during the migration scan.
 * Every field must match under row lock to guarantee no concurrent writer mutated the row.
 */
export interface ExpectedSiteState {
	fileCids: Record<string, string>
	fileObjects: FileObjects | null
	recordCid: string
	updatedAt: number
}

/**
 * Store a migrated mapping for one site, atomically with its references.
 *
 * Full snapshot fencing:
 * 1. `file_cids` must match the scanned snapshot.
 * 2. `file_objects` must match the scanned snapshot (prevents overwriting a CAS writer that tied on timestamp/record_cid).
 * 3. `record_cid` must match the scanned snapshot.
 * 4. `updated_at` must match the scanned snapshot.
 * Any concurrent mutation by a legacy or CAS writer causes commit to fail closed as 'stale'.
 */
export async function commitMigratedMapping(
	sql: Sql,
	did: string,
	rkey: string,
	expected: ExpectedSiteState,
	mapping: FileObjects,
): Promise<'committed' | 'stale'> {
	return await sql.begin(async (tx) => {
		const rows = await tx<
			Array<{ file_cids: unknown; file_objects: unknown; record_cid: string; updated_at: number | string }>
		>`
			SELECT file_cids, file_objects, record_cid, updated_at FROM site_cache WHERE did = ${did} AND rkey = ${rkey} FOR UPDATE
		`
		const row = rows[0]
		if (!row) return 'stale' as const
		if (!sameFileCids(normalizeFileCids(row.file_cids).value, expected.fileCids)) return 'stale' as const
		if (!sameFileObjects(normalizeFileObjects(row.file_objects), expected.fileObjects)) return 'stale' as const
		if (row.record_cid !== expected.recordCid) return 'stale' as const
		if (Number(row.updated_at) !== expected.updatedAt) return 'stale' as const

		await applyCasReferences(tx as unknown as Sql, did, rkey, mapping)
		return 'committed' as const
	})
}
