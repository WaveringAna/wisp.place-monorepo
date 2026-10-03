/**
 * Schema for content-addressed site storage (see CAS_STORAGE.md). Kept as plain statements so
 * main-app's migration runner and tests apply exactly the same DDL.
 */

/** Idempotent: safe to rerun, and each statement is additive. */
export const CAS_SCHEMA_STATEMENTS: readonly string[] = [
	// path -> CAS key. NULL until the site is converted or written by the CAS writer.
	`ALTER TABLE site_cache ADD COLUMN IF NOT EXISTS file_objects JSONB`,
	// One row per stored body. refs counts the sites that reference the key (one per site).
	// unreferenced_at (epoch seconds) is set whenever refs is 0, including at creation, so the
	// garbage collector's grace period starts when an object becomes unreferenced.
	`CREATE TABLE IF NOT EXISTS cas_objects (
		key TEXT PRIMARY KEY,
		refs INTEGER NOT NULL DEFAULT 0 CHECK (refs >= 0),
		size BIGINT,
		created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
		unreferenced_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
	)`,
	`CREATE INDEX IF NOT EXISTS idx_cas_objects_unreferenced ON cas_objects(unreferenced_at) WHERE refs = 0`,
]
