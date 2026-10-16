/**
 * The labeler's append-only label log. The labeler creates it; hosting reads its
 * active `!takedown` labels. Plain statements so both, and their tests, apply the
 * same DDL.
 */

/** Idempotent: safe to rerun. */
export const LABELER_SCHEMA_STATEMENTS: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS labeler_labels (
		seq BIGSERIAL PRIMARY KEY,
		src TEXT NOT NULL,
		uri TEXT NOT NULL,
		cid TEXT,
		val TEXT NOT NULL,
		neg BOOLEAN NOT NULL DEFAULT false,
		-- cts and exp keep the exact strings that were signed
		cts TEXT NOT NULL,
		exp TEXT,
		sig BYTEA NOT NULL,
		-- the moderator's reason; never published
		note TEXT NOT NULL DEFAULT '',
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS labeler_labels_val_uri_seq ON labeler_labels (val, uri, seq DESC)`,
	`CREATE INDEX IF NOT EXISTS labeler_labels_uri_seq ON labeler_labels (uri, seq DESC)`,
]
