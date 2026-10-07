import { createLogger } from '@wispplace/observability'
import type { Sql } from 'postgres'

const logger = createLogger('firehose-service')

/**
 * Garbage collection of content-addressed bodies.
 *
 * An object is collectable once nothing references it (`refs = 0`) and it has been unreferenced for
 * longer than the grace period. The grace period is what lets a site update that wrote or found a body
 * reference it later: it must outlast the longest update. Writers register an object before writing it
 * and restart the clock of any unreferenced object they reuse, so a collector that selected an object
 * earlier re-checks it under its row lock and finds it fresh.
 */

export interface CasGcPorts {
	/** Delete one object from storage. Deleting an absent object must succeed. */
	deleteObject(key: string): Promise<void>
}

export interface CasGcOptions {
	graceSeconds: number
	limit: number
	/** Clock override for tests. */
	nowSeconds?: number
	/** Test seam: runs after candidates are selected and before any is locked. */
	afterSelect?: (keys: readonly string[]) => Promise<void>
}

export interface CasGcResult {
	deleted: number
	/** No longer collectable by the time it was locked, or held by a writer. */
	skipped: number
	/** Storage refused the delete; the row is kept and the next pass retries. */
	failed: number
}

/** One bounded pass, oldest unreferenced objects first. */
export async function collectGarbage(sql: Sql, ports: CasGcPorts, options: CasGcOptions): Promise<CasGcResult> {
	const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
	const cutoff = now - options.graceSeconds
	const result: CasGcResult = { deleted: 0, skipped: 0, failed: 0 }

	const candidates = await sql<Array<{ key: string }>>`
		SELECT key FROM cas_objects
		WHERE refs = 0 AND unreferenced_at < ${cutoff}
		ORDER BY unreferenced_at, key
		LIMIT ${options.limit}
	`
	await options.afterSelect?.(candidates.map((row) => row.key))

	for (const { key } of candidates) {
		try {
			const outcome = await sql.begin(async (tx) => {
				// SKIP LOCKED: a row a writer is registering, touching or referencing is not ours to take.
				const locked = await tx`
					SELECT key FROM cas_objects
					WHERE key = ${key} AND refs = 0 AND unreferenced_at < ${cutoff}
					FOR UPDATE SKIP LOCKED
				`
				if (locked.length === 0) return 'skipped' as const
				// Storage first, row second, both under the lock: a failed delete rolls the row back, and
				// a writer waiting on this row re-registers and rewrites the object after it is gone.
				await ports.deleteObject(key)
				await tx`DELETE FROM cas_objects WHERE key = ${key}`
				return 'deleted' as const
			})
			result[outcome]++
		} catch (error) {
			result.failed++
			logger.warn('[CasGc] Could not delete an object; will retry', {
				errorKind: error instanceof Error ? error.constructor.name || 'Error' : 'UnknownError',
			})
		}
	}
	return result
}

export interface CasReconcileOptions {
	/** Most mismatches repaired in one pass. */
	limit: number
	nowSeconds?: number
	/** Test seam: runs after the snapshot is read and before any repair. */
	afterSnapshot?: () => Promise<void>
}

export interface CasReconcileResult {
	repaired: number
	/** Changed after the snapshot, so left for the next pass. */
	raced: number
}

/**
 * Recompute reference counts from the sites' stored mappings and repair drift: a crash between steps
 * of an update, a mapping that stopped parsing, or a row that never existed. Counts and mappings are
 * read in one repeatable-read snapshot, and a repair applies only if the count is still what the
 * snapshot saw, so it can never undo a concurrent update.
 */
export async function reconcileCasReferences(sql: Sql, options: CasReconcileOptions): Promise<CasReconcileResult> {
	const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
	const mismatches = await sql.begin('isolation level repeatable read read only', async (tx) => {
		return await tx<Array<{ key: string; expected: number; actual: number | null }>>`
			WITH expected AS (
				SELECT m.key, COUNT(*)::int AS refs FROM (
					SELECT DISTINCT sc.did, sc.rkey, v.value AS key
					FROM site_cache sc,
						LATERAL jsonb_each_text(
							CASE WHEN jsonb_typeof(sc.file_objects) = 'object' THEN sc.file_objects ELSE '{}'::jsonb END
						) AS v
				) m
				GROUP BY m.key
			)
			SELECT COALESCE(e.key, o.key) AS key, COALESCE(e.refs, 0) AS expected, o.refs AS actual
			FROM expected e FULL OUTER JOIN cas_objects o ON o.key = e.key
			WHERE o.key IS NULL OR COALESCE(e.refs, 0) <> o.refs
			ORDER BY 1
			LIMIT ${options.limit}
		`
	})
	await options.afterSnapshot?.()

	const result: CasReconcileResult = { repaired: 0, raced: 0 }
	for (const { key, expected, actual } of mismatches) {
		const changed =
			actual === null
				? await sql`
						INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${key}, ${expected}, NULL)
						ON CONFLICT (key) DO NOTHING
						RETURNING key
					`
				: await sql`
						UPDATE cas_objects
						SET refs = ${expected}, unreferenced_at = ${expected === 0 ? now : null}
						WHERE key = ${key} AND refs = ${actual}
						RETURNING key
					`
		if (changed.length > 0) result.repaired++
		else result.raced++
	}
	if (result.repaired > 0 || result.raced > 0) logger.info('[CasGc] Reconciled reference counts', { ...result })
	return result
}
