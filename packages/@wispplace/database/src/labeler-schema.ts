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

/**
 * The moderation queue beside the label log: one row per published site, verdicts
 * on sites or whole accounts, an audit log, and sign-in state. Idempotent.
 */
export const MODERATION_SCHEMA_STATEMENTS: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS moderation_sites (
		uri TEXT PRIMARY KEY,
		did TEXT NOT NULL,
		rkey TEXT NOT NULL,
		record_cid TEXT NOT NULL DEFAULT '',
		handle TEXT NOT NULL DEFAULT '',
		url TEXT NOT NULL DEFAULT '',
		domains TEXT[] NOT NULL DEFAULT '{}',
		title TEXT NOT NULL DEFAULT '',
		excerpt TEXT NOT NULL DEFAULT '',
		outbound TEXT[] NOT NULL DEFAULT '{}',
		files INTEGER NOT NULL DEFAULT 0,
		first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
		-- when this version of the site was published (site_cache.updated_at)
		updated TIMESTAMPTZ NOT NULL,
		deleted BOOLEAN NOT NULL DEFAULT false,
		-- the model's pass over this record version: pending, clear or flagged
		state TEXT NOT NULL DEFAULT 'pending',
		triage JSONB,
		triage_attempts INTEGER NOT NULL DEFAULT 0,
		triage_after TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS moderation_sites_state_updated ON moderation_sites (state, updated DESC)`,
	`CREATE INDEX IF NOT EXISTS moderation_sites_updated ON moderation_sites (updated DESC)`,
	`CREATE INDEX IF NOT EXISTS moderation_sites_did ON moderation_sites (did)`,
	// subject is a site URI or an account DID; one current verdict each
	`CREATE TABLE IF NOT EXISTS moderation_verdicts (
		subject TEXT PRIMARY KEY,
		verdict TEXT NOT NULL,
		note TEXT NOT NULL DEFAULT '',
		moderator TEXT NOT NULL,
		at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE TABLE IF NOT EXISTS moderation_events (
		id BIGSERIAL PRIMARY KEY,
		subject TEXT NOT NULL,
		kind TEXT NOT NULL,
		actor TEXT NOT NULL,
		data JSONB NOT NULL DEFAULT '{}',
		at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS moderation_events_subject ON moderation_events (subject, id DESC)`,
	`CREATE TABLE IF NOT EXISTS moderation_cursor (name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS moderation_oauth (
		kind TEXT NOT NULL,
		key TEXT NOT NULL,
		value JSONB NOT NULL,
		expires_at TIMESTAMPTZ,
		PRIMARY KEY (kind, key)
	)`,
	`CREATE TABLE IF NOT EXISTS moderation_logins (
		id TEXT PRIMARY KEY,
		did TEXT NOT NULL,
		expires_at TIMESTAMPTZ NOT NULL
	)`,
]
