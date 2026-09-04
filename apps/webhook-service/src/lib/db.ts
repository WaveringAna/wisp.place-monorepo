import { createHash } from 'node:crypto'
import {
	decryptWebhookSecret,
	isValidWebhookSecretId,
	parseWebhookSecretEncryptionKeyring,
} from '@wispplace/atproto-utils'
import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import { createLogger } from '@wispplace/observability'
import { SQL } from 'bun'
import { config } from '../config'
import { assertValidAtprotoRevision } from './atproto-revision'

/** A webhook entry as returned from the DB, with ownership info split out from the KV key. */
export interface WebhookEntry {
	ownerDid: string
	rkey: string
	record: WhRecord
}

const logger = createLogger('webhook-service:db')

// config.parseConfig validates protocol, credentials, length, and production
// requirements before this module constructs a connection. Never read raw env
// here: otherwise a malformed production DATABASE_URL can bypass config.
const validatedDatabaseUrl = config.databaseUrl
if (!validatedDatabaseUrl) throw new Error('DATABASE_URL is required')

export const db = new SQL(validatedDatabaseUrl)

/**
 * A statement runner: the shared pool, or one open transaction on it.
 *
 * Intake commits a whole batch through one executor - deliveries, backlink
 * state, registry mutations, and the stream cursor - so a crash replays that
 * batch instead of leaving the cursor ahead of the effects it claims.
 */
export type SqlExecutor = typeof db

/** Run one intake batch so its cursor and its effects commit together. */
export async function runIntakeBatch<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
	return db.begin(async (tx) => work(tx as unknown as SqlExecutor)) as Promise<T>
}

/**
 * Serialize all schema bootstrap work across replicas. The transaction-scoped
 * advisory lock is released automatically on commit/rollback. lock_timeout
 * makes a wedged migration fail startup rather than wait forever.
 */
async function runDatabaseMigrations(): Promise<void> {
	await db.begin(async (tx) => {
		await tx`SET LOCAL lock_timeout = '5000ms'`
		await tx`SELECT pg_advisory_xact_lock(814732190)`
		// These migrations are deliberately idempotent. Existing deployments can start
		// a new worker before every replica has seen the same application version.
		await tx`
		  CREATE TABLE IF NOT EXISTS webhooks (
		    did       TEXT NOT NULL,
		    rkey      TEXT NOT NULL,
		    url       TEXT NOT NULL,
		    scope_aturi TEXT NOT NULL,
		    enabled   BOOLEAN NOT NULL DEFAULT TRUE,
		    created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
		    updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
		    PRIMARY KEY (did, rkey)
		  )
		`

		await tx`CREATE INDEX IF NOT EXISTS webhooks_did_idx ON webhooks (did)`

		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_records (
		    k          TEXT PRIMARY KEY,
		    v          JSONB NOT NULL,
		    updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
		    source_revision TEXT,
		    source_cid TEXT,
		    source_time_us BIGINT,
		    source_generation BIGINT NOT NULL DEFAULT 0
		  )
		`
		await tx`ALTER TABLE webhook_records ADD COLUMN IF NOT EXISTS source_revision TEXT`
		await tx`ALTER TABLE webhook_records ADD COLUMN IF NOT EXISTS source_cid TEXT`
		await tx`ALTER TABLE webhook_records ADD COLUMN IF NOT EXISTS source_time_us BIGINT`
		await tx`ALTER TABLE webhook_records ADD COLUMN IF NOT EXISTS source_generation BIGINT NOT NULL DEFAULT 0`

		await tx`
		  CREATE TABLE IF NOT EXISTS jetstream_cursor (
		    id            TEXT PRIMARY KEY DEFAULT 'singleton',
		    seq           BIGINT NOT NULL,
		    jetstream_url TEXT,
		    saved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		  )
		`

		/** Per-consumer cursors avoid advancing one stream because another is ahead. */
		await tx`
		  CREATE TABLE IF NOT EXISTS jetstream_cursors (
		    consumer_id TEXT NOT NULL,
		    relay_id TEXT NOT NULL,
		    seq BIGINT NOT NULL CHECK (seq >= 0),
		    saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		    PRIMARY KEY (consumer_id, relay_id)
		  )
		`
		/** A restart-safe keyset continuation for bounded startup backfill. */
		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_backfill_state (
		    id TEXT PRIMARY KEY CHECK (id = 'singleton'),
		    continuation TEXT,
		    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		  )
		`

		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_event_logs (
		    id               BIGSERIAL PRIMARY KEY,
		    owner_did        TEXT NOT NULL,
		    rkey             TEXT NOT NULL,
		    url              TEXT NOT NULL,
		    event_kind       TEXT NOT NULL,
		    event_did        TEXT NOT NULL,
		    event_collection TEXT NOT NULL,
		    event_rkey       TEXT NOT NULL,
		    cid              TEXT,
		    status           TEXT NOT NULL,
		    delivered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
		  )
		`
		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_event_logs_owner_did_idx
		  ON webhook_event_logs (owner_did, delivered_at DESC)
		`
		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_intake_quarantines (
		    quarantine_id TEXT PRIMARY KEY,
		    relay_id TEXT NOT NULL,
		    source_time_us BIGINT NOT NULL,
		    source_revision TEXT NOT NULL,
		    event_at_uri_hash TEXT NOT NULL,
		    reason TEXT NOT NULL,
		    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		  )
		`
		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_intake_quarantines_retention_idx
		  ON webhook_intake_quarantines (last_seen_at ASC)
		`
		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_schema_migrations (
		    name TEXT PRIMARY KEY,
		    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		  )
		`
		const redactionMigration = await tx<Array<{ name: string }>>`
		  INSERT INTO webhook_schema_migrations (name)
		  VALUES ('webhook_event_log_url_redaction_v1')
		  ON CONFLICT (name) DO NOTHING
		  RETURNING name
		`
		if (redactionMigration.length > 0) {
			// Database backups made before this migration can still contain historical URLs;
			// operators must rotate them under their normal backup-retention policy.
			await tx`UPDATE webhook_event_logs SET url = '[redacted]' WHERE url <> '[redacted]'`
		}

		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_secrets (
		    did TEXT NOT NULL,
		    name TEXT NOT NULL,
		    token TEXT NOT NULL,
		    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		    last_rotated_at TIMESTAMPTZ,
		    PRIMARY KEY (did, name)
		  )
		`

		/** One immutable payload/source identity is shared by all subscription rows. */
		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_delivery_events (
		    event_id TEXT PRIMARY KEY,
		    payload JSONB NOT NULL,
		    payload_body TEXT NOT NULL,
		    source_relay_id TEXT NOT NULL,
		    source_time_us BIGINT NOT NULL,
		    source_revision TEXT NOT NULL,
		    source_operation TEXT NOT NULL,
		    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		  )
		`
		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_delivery_events_created_idx
		  ON webhook_delivery_events (created_at ASC)
		`

		/**
		 * Durable delivery queue. `payload_body` is canonical JSON and is the exact
		 * byte sequence that is signed. No plaintext signing secret is stored here.
		 */
		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_delivery_outbox (
		    delivery_id TEXT PRIMARY KEY,
		    event_id TEXT REFERENCES webhook_delivery_events(event_id) ON DELETE RESTRICT,
		    owner_did TEXT NOT NULL,
		    webhook_rkey TEXT NOT NULL,
		    target_url TEXT NOT NULL,
		    secret_id TEXT,
		    signing_mode TEXT NOT NULL DEFAULT 'none',
		    subscription_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
		    subscription_fingerprint TEXT NOT NULL DEFAULT '',
		    -- Nullable legacy columns support rolling upgrades; new rows use event_id.
		    payload JSONB,
		    payload_body TEXT,
		    source_relay_id TEXT,
		    source_time_us BIGINT,
		    source_revision TEXT,
		    source_operation TEXT,
		    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
		    status TEXT NOT NULL DEFAULT 'pending',
		    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		    lease_token TEXT,
		    leased_until TIMESTAMPTZ,
		    last_error_kind TEXT,
		    last_http_status INTEGER,
		    delivered_at TIMESTAMPTZ,
		    dead_lettered_at TIMESTAMPTZ,
		    cancelled_at TIMESTAMPTZ,
		    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		    CHECK (status IN ('pending', 'leased', 'delivered', 'dead_letter', 'cancelled_subscription_changed')),
		    CHECK (signing_mode IN ('none', 'secret_id', 'record_secret'))
		  )
		`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS event_id TEXT`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS subscription_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb`
		await tx`ALTER TABLE webhook_delivery_outbox ALTER COLUMN subscription_snapshot SET DEFAULT '{}'::jsonb`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS subscription_fingerprint TEXT NOT NULL DEFAULT ''`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS payload JSONB`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS payload_body TEXT`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS source_relay_id TEXT`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS source_time_us BIGINT`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS source_revision TEXT`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS source_operation TEXT`
		await tx`ALTER TABLE webhook_delivery_outbox ALTER COLUMN payload DROP NOT NULL`
		await tx`ALTER TABLE webhook_delivery_outbox ALTER COLUMN payload_body DROP NOT NULL`
		await tx`ALTER TABLE webhook_delivery_outbox ALTER COLUMN source_relay_id DROP NOT NULL`
		await tx`ALTER TABLE webhook_delivery_outbox ALTER COLUMN source_time_us DROP NOT NULL`
		await tx`ALTER TABLE webhook_delivery_outbox ALTER COLUMN source_revision DROP NOT NULL`
		await tx`ALTER TABLE webhook_delivery_outbox ALTER COLUMN source_operation DROP NOT NULL`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS signing_mode TEXT NOT NULL DEFAULT 'none'`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS lease_token TEXT`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS last_error_kind TEXT`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS last_http_status INTEGER`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
		await tx`ALTER TABLE webhook_delivery_outbox ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
		await tx`
		  DO $$ BEGIN
		    IF NOT EXISTS (
		      SELECT 1 FROM pg_constraint WHERE conname = 'webhook_delivery_outbox_event_id_fkey'
		    ) THEN
		      ALTER TABLE webhook_delivery_outbox
		      ADD CONSTRAINT webhook_delivery_outbox_event_id_fkey
		      FOREIGN KEY (event_id) REFERENCES webhook_delivery_events(event_id) ON DELETE RESTRICT;
		    END IF;
		  END $$
		`
		await tx`ALTER TABLE webhook_delivery_outbox DROP CONSTRAINT IF EXISTS webhook_delivery_outbox_status_check`
		await tx`
		  ALTER TABLE webhook_delivery_outbox
		  ADD CONSTRAINT webhook_delivery_outbox_status_check
		  CHECK (status IN ('pending', 'leased', 'delivered', 'dead_letter', 'cancelled_subscription_changed'))
		`

		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_delivery_outbox_ready_idx
		  ON webhook_delivery_outbox (next_attempt_at ASC, created_at ASC)
		  WHERE status IN ('pending', 'leased')
		`
		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_delivery_outbox_owner_idx
		  ON webhook_delivery_outbox (owner_did, created_at DESC)
		`
		await tx`CREATE INDEX IF NOT EXISTS webhook_delivery_outbox_event_idx ON webhook_delivery_outbox (event_id)`
		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_delivery_outbox_retention_idx
		  ON webhook_delivery_outbox (status, delivered_at, dead_lettered_at)
		`

		/** Owner generations fence an asynchronous full backfill from live events. */
		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_owner_generations (
		    owner_did TEXT PRIMARY KEY,
		    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
		    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		  )
		`

		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_owner_reconciliations (
		    owner_did TEXT PRIMARY KEY,
		    generation BIGINT NOT NULL,
		    status TEXT NOT NULL CHECK (status IN ('scanning', 'complete', 'failed')),
		    pages INTEGER NOT NULL DEFAULT 0,
		    records INTEGER NOT NULL DEFAULT 0,
		    decoded_bytes BIGINT NOT NULL DEFAULT 0,
		    prune_batches INTEGER NOT NULL DEFAULT 0,
		    pruned_records BIGINT NOT NULL DEFAULT 0,
		    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		    last_failed_at TIMESTAMPTZ
		  )
		`
		await tx`ALTER TABLE webhook_owner_reconciliations ADD COLUMN IF NOT EXISTS prune_batches INTEGER NOT NULL DEFAULT 0`
		await tx`ALTER TABLE webhook_owner_reconciliations ADD COLUMN IF NOT EXISTS pruned_records BIGINT NOT NULL DEFAULT 0`

		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_record_tombstones (
		    k TEXT PRIMARY KEY,
		    owner_did TEXT NOT NULL,
		    rkey TEXT NOT NULL,
		    source_generation BIGINT NOT NULL CHECK (source_generation >= 0),
		    source_revision TEXT,
		    source_cid TEXT,
		    source_time_us BIGINT,
		    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		  )
		`
		await tx`ALTER TABLE webhook_record_tombstones ADD COLUMN IF NOT EXISTS source_revision TEXT`
		await tx`ALTER TABLE webhook_record_tombstones ADD COLUMN IF NOT EXISTS source_cid TEXT`
		await tx`ALTER TABLE webhook_record_tombstones ADD COLUMN IF NOT EXISTS source_time_us BIGINT`

		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_record_tombstones_owner_idx
		  ON webhook_record_tombstones (owner_did, source_generation)
		`
		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_record_tombstones_deleted_idx
		  ON webhook_record_tombstones (deleted_at ASC)
		`

		await tx`
		  CREATE TABLE IF NOT EXISTS webhook_backlink_references (
		    event_at_uri TEXT PRIMARY KEY,
		    refs JSONB NOT NULL,
		    last_seq BIGINT NOT NULL CHECK (last_seq >= 0),
		    last_rev TEXT NOT NULL,
		    expires_at TIMESTAMPTZ NOT NULL,
		    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		  )
		`
		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_backlink_references_expiry_idx
		  ON webhook_backlink_references (expires_at ASC)
		`
		await tx`
		  CREATE INDEX IF NOT EXISTS webhook_backlink_references_updated_idx
		  ON webhook_backlink_references (updated_at ASC)
		`
	})
}

await runDatabaseMigrations()

function webhookKey(did: string, rkey: string): string {
	return `${did}/${rkey}`
}

function isNonEmptyBoundedString(value: string, maximum: number): boolean {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function assertWebhookKey(did: string, rkey: string): void {
	if (!isNonEmptyBoundedString(did, 2048) || !isNonEmptyBoundedString(rkey, 1024) || did.includes('/')) {
		throw new Error('Invalid webhook identifier')
	}
}

/** Persist only lexicon-owned fields. The generated type has an open index signature. */
function sanitizeWebhookRecord(value: WhRecord): WhRecord {
	if (!value || typeof value !== 'object') throw new Error('Invalid webhook record')
	const raw = value as Record<string, unknown>
	const scope = raw.scope
	if (!scope || typeof scope !== 'object') throw new Error('Invalid webhook record')
	const rawScope = scope as Record<string, unknown>
	if (!isNonEmptyBoundedString(rawScope.aturi as string, 2048) || !isNonEmptyBoundedString(raw.url as string, 2048)) {
		throw new Error('Invalid webhook record')
	}
	if (!isNonEmptyBoundedString(raw.createdAt as string, 256)) throw new Error('Invalid webhook record')
	if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('Invalid webhook record')
	if (rawScope.backlinks !== undefined && typeof rawScope.backlinks !== 'boolean')
		throw new Error('Invalid webhook record')
	if (
		raw.secret !== undefined &&
		(!isNonEmptyBoundedString(raw.secret as string, 256) || typeof raw.secret !== 'string')
	) {
		throw new Error('Invalid webhook record')
	}
	if (raw.secretId !== undefined && !isValidWebhookSecretId(raw.secretId)) {
		throw new Error('Invalid webhook record')
	}
	let events: WhRecord['events']
	if (raw.events !== undefined) {
		if (
			!Array.isArray(raw.events) ||
			raw.events.length > 3 ||
			!raw.events.every((event) => event === 'create' || event === 'update' || event === 'delete')
		) {
			throw new Error('Invalid webhook record')
		}
		events = [...raw.events] as WhRecord['events']
	}
	return {
		$type: raw.$type === 'place.wisp.v2.wh' ? raw.$type : 'place.wisp.v2.wh',
		scope: {
			...(rawScope.$type === 'place.wisp.v2.wh#atUri' ? { $type: rawScope.$type } : {}),
			aturi: rawScope.aturi as string,
			...(typeof rawScope.backlinks === 'boolean' ? { backlinks: rawScope.backlinks } : {}),
		},
		url: raw.url as string,
		...(events ? { events } : {}),
		...(typeof raw.secret === 'string' ? { secret: raw.secret } : {}),
		...(typeof raw.secretId === 'string' ? { secretId: raw.secretId } : {}),
		...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
		createdAt: raw.createdAt as string,
	}
}

/** Corrupt legacy JSON is quarantined by omission; it must not crash intake. */
function sanitizeStoredWebhookRecord(value: WhRecord): WhRecord | undefined {
	try {
		return sanitizeWebhookRecord(value)
	} catch {
		logger.warn('[DB] invalid stored webhook record ignored')
		return undefined
	}
}

function recordChanged(previous: WhRecord | undefined, next: WhRecord): boolean {
	if (!previous) return true
	return JSON.stringify(previous) !== JSON.stringify(next)
}

async function currentOwnerGeneration(tx: SQL, ownerDid: string): Promise<number> {
	const rows = await tx<Array<{ generation: number | string | bigint }>>`
    INSERT INTO webhook_owner_generations (owner_did, generation)
    VALUES (${ownerDid}, 0)
    ON CONFLICT (owner_did) DO UPDATE SET updated_at = NOW()
    RETURNING generation
  `
	return parseSafeSequence(rows[0]?.generation, 'Invalid webhook generation')
}

/** Every live mutation advances the fence, so a scan can never overwrite it. */
async function nextLiveGeneration(tx: SQL, ownerDid: string): Promise<number> {
	const rows = await tx<Array<{ generation: number | string | bigint }>>`
    INSERT INTO webhook_owner_generations (owner_did, generation, updated_at)
    VALUES (${ownerDid}, 1, NOW())
    ON CONFLICT (owner_did) DO UPDATE SET generation = webhook_owner_generations.generation + 1, updated_at = NOW()
    RETURNING generation
  `
	return parseSafeSequence(rows[0]?.generation, 'Invalid webhook generation')
}

/**
 * Find all webhook records whose scope AT-URI targets the given DID.
 * Matches exact DID scope (`at://did`) and collection/rkey sub-scopes (`at://did/...`).
 */
export async function findWebhooksForDid(scopeDid: string): Promise<WebhookEntry[]> {
	const exact = `at://${scopeDid}`
	const prefix = `at://${scopeDid}/`
	const rows = await db<Array<{ k: string; v: WhRecord }>>`
    SELECT k, v FROM webhook_records
    WHERE (v->'scope'->>'aturi' = ${exact}
       OR starts_with(v->'scope'->>'aturi', ${prefix}))
      AND NOT EXISTS (
        SELECT 1 FROM webhook_owner_reconciliations reconciliation
        WHERE reconciliation.owner_did = split_part(webhook_records.k, '/', 1)
          AND reconciliation.status IN ('failed', 'scanning')
      )
  `
	const result: WebhookEntry[] = []
	for (const row of rows) {
		const slash = row.k.indexOf('/')
		const record = sanitizeStoredWebhookRecord(row.v)
		if (slash <= 0 || !record) continue
		result.push({ ownerDid: row.k.slice(0, slash), rkey: row.k.slice(slash + 1), record })
	}
	return result
}

/** Find all webhook records that have backlinks enabled without unsafe JSON casts. */
export async function findBacklinkWebhooks(): Promise<WebhookEntry[]> {
	const rows = await db<Array<{ k: string; v: WhRecord }>>`
    SELECT k, v FROM webhook_records
    WHERE v->'scope'->>'backlinks' = 'true'
      AND NOT EXISTS (
        SELECT 1 FROM webhook_owner_reconciliations reconciliation
        WHERE reconciliation.owner_did = split_part(webhook_records.k, '/', 1)
          AND reconciliation.status IN ('failed', 'scanning')
      )
  `
	const result: WebhookEntry[] = []
	for (const row of rows) {
		const slash = row.k.indexOf('/')
		const record = sanitizeStoredWebhookRecord(row.v)
		if (slash <= 0 || !record) continue
		result.push({ ownerDid: row.k.slice(0, slash), rkey: row.k.slice(slash + 1), record })
	}
	return result
}

/** Load all webhook records. Used for diagnostics/admin views. */
export async function loadAllWebhooks(): Promise<Array<{ did: string; rkey: string; record: WhRecord }>> {
	const rows = await db<Array<{ k: string; v: WhRecord }>>`SELECT k, v FROM webhook_records`
	const result: Array<{ did: string; rkey: string; record: WhRecord }> = []
	for (const row of rows) {
		const slash = row.k.indexOf('/')
		const record = sanitizeStoredWebhookRecord(row.v)
		if (slash <= 0 || !record) continue
		result.push({ did: row.k.slice(0, slash), rkey: row.k.slice(slash + 1), record })
	}
	return result
}

/** O(1) primary-key lookup for registry mutations; never scan all webhook records. */
export async function getWebhookRecord(ownerDid: string, rkey: string): Promise<WebhookEntry | undefined> {
	assertWebhookKey(ownerDid, rkey)
	const rows = await db<Array<{ v: WhRecord }>>`
    SELECT v FROM webhook_records WHERE k = ${webhookKey(ownerDid, rkey)} LIMIT 1
  `
	const record = rows[0]?.v
	const sanitized = record ? sanitizeStoredWebhookRecord(record) : undefined
	return sanitized ? { ownerDid, rkey, record: sanitized } : undefined
}

/** Webhooks eligible for matching; owners with failed/in-progress PDS reconciliation are excluded. */
export interface ActiveWebhookLoadResult {
	rows: Array<{ did: string; rkey: string; record: WhRecord }>
	overflow: boolean
}

const MAX_ACTIVE_WEBHOOK_REGISTRY_BYTES = 8 * 1024 * 1024
const ACTIVE_WEBHOOK_REGISTRY_QUERY_TIMEOUT_MS = 5_000

function activeWebhookRowLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.registryActiveSubscriptionsMax) {
		throw new Error('Invalid active webhook registry limit')
	}
	return limit
}

/**
 * Read a deterministic, memory-bounded active registry snapshot. The SQL sees
 * at most limit+1 enabled candidates; JSON bytes returned to Node are capped.
 */
async function loadBoundedActiveWebhooks(limit: number, ownerDid?: string): Promise<ActiveWebhookLoadResult> {
	const activeLimit = activeWebhookRowLimit(limit)
	if (ownerDid !== undefined) assertWebhookKey(ownerDid, 'snapshot')
	const candidateLimit = activeLimit + 1
	const ownerPredicate: string | null = ownerDid ?? null
	return db.begin(async (tx) => {
		await tx`SELECT set_config('statement_timeout', ${`${ACTIVE_WEBHOOK_REGISTRY_QUERY_TIMEOUT_MS}ms`}, true)`
		const metadata = await tx<Array<{ candidate_count: number | string | bigint; over_bytes: boolean }>>`
      WITH candidates AS (
        SELECT records.k, octet_length(records.k) + octet_length(records.v::text) AS bytes
        FROM webhook_records records
        WHERE COALESCE(records.v->>'enabled', 'true') <> 'false'
          AND (${ownerPredicate}::text IS NULL OR split_part(records.k, '/', 1) = ${ownerPredicate})
          AND NOT EXISTS (
            SELECT 1 FROM webhook_owner_reconciliations reconciliation
            WHERE reconciliation.owner_did = split_part(records.k, '/', 1)
              AND reconciliation.status IN ('failed', 'scanning')
          )
        ORDER BY records.k ASC
        LIMIT ${candidateLimit}
      ), running AS (
        SELECT bytes, sum(bytes) OVER (ORDER BY k ASC) AS running_bytes FROM candidates
      )
      SELECT count(*) AS candidate_count,
             COALESCE(bool_or(running_bytes > ${MAX_ACTIVE_WEBHOOK_REGISTRY_BYTES}), false) AS over_bytes
      FROM running
    `
		const rows = await tx<Array<{ k: string; v: WhRecord }>>`
      WITH candidates AS (
        SELECT records.k, records.v, octet_length(records.k) + octet_length(records.v::text) AS bytes
        FROM webhook_records records
        WHERE COALESCE(records.v->>'enabled', 'true') <> 'false'
          AND (${ownerPredicate}::text IS NULL OR split_part(records.k, '/', 1) = ${ownerPredicate})
          AND NOT EXISTS (
            SELECT 1 FROM webhook_owner_reconciliations reconciliation
            WHERE reconciliation.owner_did = split_part(records.k, '/', 1)
              AND reconciliation.status IN ('failed', 'scanning')
          )
        ORDER BY records.k ASC
        LIMIT ${candidateLimit}
      ), running AS (
        SELECT k, v, sum(bytes) OVER (ORDER BY k ASC) AS running_bytes FROM candidates
      )
      SELECT k, v FROM running
      WHERE running_bytes <= ${MAX_ACTIVE_WEBHOOK_REGISTRY_BYTES}
      ORDER BY k ASC
    `
		const candidateCount = parseSafeSequence(metadata[0]?.candidate_count, 'Invalid active webhook registry count')
		const result: Array<{ did: string; rkey: string; record: WhRecord }> = []
		for (const row of rows) {
			const slash = row.k.indexOf('/')
			const record = sanitizeStoredWebhookRecord(row.v)
			if (slash <= 0 || !record) continue
			result.push({ did: row.k.slice(0, slash), rkey: row.k.slice(slash + 1), record })
		}
		return {
			rows: result,
			overflow: candidateCount > activeLimit || metadata[0]?.over_bytes === true,
		}
	})
}

/** Active globally admitted candidates, deterministic and bounded to cap+1. */
export async function loadActiveWebhooks(): Promise<ActiveWebhookLoadResult> {
	return loadBoundedActiveWebhooks(config.registryActiveSubscriptionsMax)
}

/** Bounded replacement snapshot for one reconciliation owner transition. */
export async function loadActiveWebhooksForOwner(ownerDid: string): Promise<ActiveWebhookLoadResult> {
	return loadBoundedActiveWebhooks(config.registryOwnerActiveRecordsMax, ownerDid)
}

export interface WebhookRecordSource {
	revision?: string
	cid?: string
	/** Relay event time used to reject retained/reordered live mutations. */
	timeUs?: number
	/** Snapshot reconciliation supplies its fence generation. Live writes omit it. */
	generation?: number
}

interface StoredWebhookMutationSource {
	source_time_us?: number | string | bigint | null
	source_revision?: string | null
	source_cid?: string | null
}

function sourceTime(value: number | string | bigint | null | undefined): number | undefined {
	if (value === null || value === undefined) return undefined
	return parseSafeSequence(value, 'Invalid webhook source time')
}

function compareSourceText(left: string, right: string): number {
	return left === right ? 0 : left < right ? -1 : 1
}

/**
 * Return whether an incoming live relay mutation is strictly newer than every
 * durable record/tombstone source. Legacy and snapshot rows have no relay time
 * and are intentionally ordered before a real relay event.
 */
function isNewerLiveSource(
	source: WebhookRecordSource | undefined,
	stored: readonly StoredWebhookMutationSource[],
): boolean {
	if (source?.timeUs === undefined) return true
	for (const candidate of stored) {
		const previousTime = sourceTime(candidate.source_time_us)
		if (previousTime === undefined) continue
		if (source.timeUs < previousTime) return false
		if (source.timeUs > previousTime) continue
		const revision = source.revision ?? ''
		const previousRevision = candidate.source_revision ?? ''
		const revisionOrder = compareSourceText(revision, previousRevision)
		if (revisionOrder < 0) return false
		if (revisionOrder > 0) continue
		if (compareSourceText(source.cid ?? '', candidate.source_cid ?? '') <= 0) return false
	}
	return true
}

function assertWebhookMutationSource(source: WebhookRecordSource | undefined): void {
	if (!source) return
	if (source.generation !== undefined && (!Number.isSafeInteger(source.generation) || source.generation < 0)) {
		throw new Error('Invalid webhook generation')
	}
	if (source.revision !== undefined && !isNonEmptyBoundedString(source.revision, 1024)) {
		throw new Error('Invalid webhook revision')
	}
	if (source.cid !== undefined && !isNonEmptyBoundedString(source.cid, 1024)) throw new Error('Invalid webhook CID')
	if (source.timeUs !== undefined) {
		if (!Number.isSafeInteger(source.timeUs) || source.timeUs < 0 || !source.revision) {
			throw new Error('Invalid webhook source time')
		}
	}
}

/** Stable non-secret identity used to revoke queued jobs after subscription changes. */
export function webhookSubscriptionFingerprint(record: WhRecord): string {
	const clean = sanitizeWebhookRecord(record)
	const value = JSON.stringify({
		url: clean.url,
		scope: { aturi: clean.scope.aturi, backlinks: clean.scope.backlinks === true },
		events: clean.events ?? [],
		enabled: clean.enabled !== false,
		secretId: clean.secretId ?? null,
		hasInlineSecret: typeof clean.secret === 'string',
	})
	return createHash('sha256').update(`wisp-webhook-subscription/v1\0${value}`).digest('hex')
}

export interface CurrentWebhookSubscription {
	url: string
	fingerprint: string
	secretId?: string
	signingMode: 'none' | 'secret_id' | 'record_secret'
}

/**
 * Read the current subscription before every send. Missing and disabled records
 * return null; DB failures intentionally throw so the worker retries instead of
 * accidentally delivering after a revocation.
 */
export async function getCurrentWebhookSubscription(
	ownerDid: string,
	rkey: string,
): Promise<CurrentWebhookSubscription | null> {
	assertWebhookKey(ownerDid, rkey)
	const rows = await db<Array<{ v: WhRecord }>>`
    SELECT v FROM webhook_records records
    WHERE k = ${webhookKey(ownerDid, rkey)}
      AND NOT EXISTS (
        SELECT 1 FROM webhook_owner_reconciliations reconciliation
        WHERE reconciliation.owner_did = ${ownerDid}
          AND reconciliation.status IN ('failed', 'scanning')
      )
    LIMIT 1
  `
	const stored = rows[0]?.v
	if (!stored) return null
	const record = sanitizeStoredWebhookRecord(stored)
	if (!record || record.enabled === false) return null
	return {
		url: record.url,
		fingerprint: webhookSubscriptionFingerprint(record),
		secretId: record.secretId,
		signingMode: record.secretId ? 'secret_id' : record.secret ? 'record_secret' : 'none',
	}
}

async function upsertWebhookRecordInTransaction(
	tx: SQL,
	did: string,
	rkey: string,
	record: WhRecord,
	source: WebhookRecordSource | undefined,
	liveWrite: boolean,
): Promise<boolean> {
	assertWebhookKey(did, rkey)
	assertWebhookMutationSource(source)
	const clean = sanitizeWebhookRecord(record)
	const k = webhookKey(did, rkey)
	const previousRows = await tx<Array<{ v: WhRecord } & StoredWebhookMutationSource>>`
    SELECT v, source_time_us, source_revision, source_cid
    FROM webhook_records WHERE k = ${k} FOR UPDATE
  `
	const tombstoneRows = await tx<Array<StoredWebhookMutationSource>>`
    SELECT source_time_us, source_revision, source_cid
    FROM webhook_record_tombstones WHERE k = ${k} FOR UPDATE
  `
	// Retained cursor-zero replay can arrive behind an already persisted live
	// update/delete. Do not let an older relay mutation resurrect it.
	if (liveWrite && !isNewerLiveSource(source, [...previousRows, ...tombstoneRows])) return false

	const previous = previousRows[0]
	const changed = recordChanged(previous?.v, clean)
	const currentGeneration = liveWrite ? await nextLiveGeneration(tx, did) : await currentOwnerGeneration(tx, did)
	const generation = liveWrite ? currentGeneration : (source?.generation ?? currentGeneration)
	if (liveWrite) {
		await tx`DELETE FROM webhook_record_tombstones WHERE k = ${k}`
	} else {
		await tx`DELETE FROM webhook_record_tombstones WHERE k = ${k} AND source_generation <= ${generation}`
	}

	await tx`
    INSERT INTO webhooks (did, rkey, url, scope_aturi, enabled, created_at, updated_at)
    VALUES (${did}, ${rkey}, ${clean.url}, ${clean.scope.aturi}, ${clean.enabled ?? true},
            EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
    ON CONFLICT (did, rkey) DO UPDATE SET
      url = EXCLUDED.url,
      scope_aturi = EXCLUDED.scope_aturi,
      enabled = EXCLUDED.enabled,
      updated_at = EXTRACT(EPOCH FROM NOW())
  `
	await tx`
    INSERT INTO webhook_records (k, v, updated_at, source_revision, source_cid, source_time_us, source_generation)
    VALUES (
      ${k}, ${clean}, EXTRACT(EPOCH FROM NOW()), ${source?.revision ?? null}, ${source?.cid ?? null},
      ${source?.timeUs ?? null}, ${generation}
    )
    ON CONFLICT (k) DO UPDATE SET
      v = EXCLUDED.v,
      updated_at = EXCLUDED.updated_at,
      source_revision = COALESCE(EXCLUDED.source_revision, webhook_records.source_revision),
      source_cid = COALESCE(EXCLUDED.source_cid, webhook_records.source_cid),
      source_time_us = COALESCE(EXCLUDED.source_time_us, webhook_records.source_time_us),
      source_generation = EXCLUDED.source_generation
  `
	return liveWrite || changed
}

/** Insert or update both materialized webhook tables atomically. */
export async function upsertWebhookRecord(
	did: string,
	rkey: string,
	record: WhRecord,
	source?: WebhookRecordSource,
): Promise<boolean> {
	try {
		return await db.begin((tx) =>
			upsertWebhookRecordInTransaction(tx, did, rkey, record, source, source?.generation === undefined),
		)
	} catch {
		// Do not pass an Error object here; database errors can contain a URL or SQL values.
		logger.error('[DB] webhook record upsert failed')
		throw new Error('Webhook record upsert failed')
	}
}

/** Remove both materialized webhook tables atomically. */
export async function deleteWebhookRecord(did: string, rkey: string, source?: WebhookRecordSource): Promise<boolean> {
	assertWebhookKey(did, rkey)
	assertWebhookMutationSource(source)
	const k = webhookKey(did, rkey)
	try {
		return await db.begin(async (tx) => {
			// Keep a hard cap without scanning an arbitrary tail. Deletes are uncommon, so the
			// short transaction lock is preferable to allowing unbounded tombstones.
			await tx`SET LOCAL lock_timeout = '1000ms'`
			await tx`SELECT pg_advisory_xact_lock(814732194)`
			const records = await tx<Array<StoredWebhookMutationSource>>`
        SELECT source_time_us, source_revision, source_cid
        FROM webhook_records WHERE k = ${k} FOR UPDATE
      `
			const tombstones = await tx<Array<StoredWebhookMutationSource>>`
        SELECT source_time_us, source_revision, source_cid
        FROM webhook_record_tombstones WHERE k = ${k} FOR UPDATE
      `
			if (!isNewerLiveSource(source, [...records, ...tombstones])) return false

			if (tombstones.length === 0) {
				const count = await tx<Array<{ count: number | string | bigint }>>`
          SELECT count(*) AS count FROM webhook_record_tombstones
        `
				if (parseSafeSequence(count[0]?.count, 'Invalid tombstone state') >= MAX_TOMBSTONE_ROWS) {
					const evicted = await tx<Array<{ k: string }>>`
            SELECT tombstone.k
            FROM webhook_record_tombstones tombstone
            WHERE NOT EXISTS (
              SELECT 1 FROM webhook_owner_reconciliations reconciliation
              WHERE reconciliation.owner_did = tombstone.owner_did AND reconciliation.status = 'scanning'
            )
            ORDER BY tombstone.deleted_at ASC
            LIMIT 1
            FOR UPDATE OF tombstone SKIP LOCKED
          `
					const evictedKey = evicted[0]?.k
					if (!evictedKey) throw new Error('Webhook tombstone capacity temporarily unavailable')
					await tx`DELETE FROM webhook_record_tombstones WHERE k = ${evictedKey}`
				}
			}
			const generation = await nextLiveGeneration(tx, did)
			await tx`
        INSERT INTO webhook_record_tombstones (
          k, owner_did, rkey, source_generation, source_revision, source_cid, source_time_us, deleted_at
        )
        VALUES (
          ${k}, ${did}, ${rkey}, ${generation}, ${source?.revision ?? null}, ${source?.cid ?? null},
          ${source?.timeUs ?? null}, NOW()
        )
        ON CONFLICT (k) DO UPDATE SET
          source_generation = EXCLUDED.source_generation,
          source_revision = COALESCE(EXCLUDED.source_revision, webhook_record_tombstones.source_revision),
          source_cid = COALESCE(EXCLUDED.source_cid, webhook_record_tombstones.source_cid),
          source_time_us = COALESCE(EXCLUDED.source_time_us, webhook_record_tombstones.source_time_us),
          deleted_at = NOW()
      `
			await tx`DELETE FROM webhooks WHERE did = ${did} AND rkey = ${rkey}`
			await tx`DELETE FROM webhook_records WHERE k = ${k}`
			return true
		})
	} catch {
		logger.error('[DB] webhook record delete failed')
		throw new Error('Webhook record delete failed')
	}
}

export interface WebhookSnapshotRecord {
	rkey: string
	record: WhRecord
	cid?: string
	revision?: string
}

export interface OwnerReconciliationToken {
	ownerDid: string
	generation: number
}

const MAX_RECONCILIATION_PAGES = 20
const MAX_RECONCILIATION_RECORDS = 1_000
const MAX_RECONCILIATION_BYTES = 10 * 1024 * 1024
const MAX_RECONCILIATION_PRUNE_BATCH = 100
const RECONCILIATION_STATEMENT_TIMEOUT_MS = 5_000
const MAX_CONCURRENT_RECONCILIATIONS = 8

function assertReconciliationToken(token: OwnerReconciliationToken): void {
	assertWebhookKey(token.ownerDid, 'snapshot')
	if (!Number.isSafeInteger(token.generation) || token.generation < 1)
		throw new Error('Invalid webhook reconciliation token')
}

function snapshotRecordBytes(record: WhRecord): number {
	try {
		return new TextEncoder().encode(JSON.stringify(record)).byteLength
	} catch {
		throw new Error('Invalid webhook snapshot')
	}
}

/**
 * Begin a fenced, page-at-a-time owner scan. A live event after this point is
 * written at generation+1 and therefore survives stale snapshot pages.
 */
export async function beginOwnerReconciliation(ownerDid: string): Promise<OwnerReconciliationToken> {
	assertWebhookKey(ownerDid, 'snapshot')
	return db.begin(async (tx) => {
		// Serialize the small global capacity decision without serializing scans.
		await tx`SELECT pg_advisory_xact_lock(814732191)`
		const active = await tx<Array<{ count: number | string | bigint }>>`
      SELECT count(*) AS count FROM webhook_owner_reconciliations
      WHERE status = 'scanning' AND owner_did <> ${ownerDid}
    `
		if (parseSafeSequence(active[0]?.count, 'Invalid reconciliation state') >= MAX_CONCURRENT_RECONCILIATIONS) {
			throw new Error('Webhook reconciliation capacity exceeded')
		}
		const rows = await tx<Array<{ generation: number | string | bigint }>>`
      INSERT INTO webhook_owner_generations (owner_did, generation, updated_at)
      VALUES (${ownerDid}, 1, NOW())
      ON CONFLICT (owner_did) DO UPDATE SET generation = webhook_owner_generations.generation + 1, updated_at = NOW()
      RETURNING generation
    `
		const generation = parseSafeSequence(rows[0]?.generation, 'Invalid webhook generation')
		await tx`
      INSERT INTO webhook_owner_reconciliations
        (owner_did, generation, status, pages, records, decoded_bytes, prune_batches, pruned_records, started_at, updated_at, last_failed_at)
      VALUES (${ownerDid}, ${generation}, 'scanning', 0, 0, 0, 0, 0, NOW(), NOW(), NULL)
      ON CONFLICT (owner_did) DO UPDATE SET
        generation = EXCLUDED.generation,
        status = 'scanning',
        pages = 0,
        records = 0,
        decoded_bytes = 0,
        prune_batches = 0,
        pruned_records = 0,
        started_at = NOW(),
        updated_at = NOW(),
        last_failed_at = NULL
    `
		return { ownerDid, generation }
	})
}

/** Compatibility alias retained for callers that only need a numeric fence. */
export async function beginWebhookSnapshot(ownerDid: string): Promise<number> {
	return (await beginOwnerReconciliation(ownerDid)).generation
}

/**
 * Apply one already-validated PDS page. Unknown lexicon fields are stripped
 * before persistence. A failed page leaves the owner in scanning state; callers
 * must call failOwnerReconciliation rather than finalizing deletion.
 */
export async function applyWebhookSnapshotPage(
	token: OwnerReconciliationToken,
	records: readonly WebhookSnapshotRecord[],
): Promise<{ applied: boolean; upserted: number }> {
	assertReconciliationToken(token)
	if (records.length > MAX_RECONCILIATION_RECORDS) throw new Error('Webhook snapshot page is too large')
	const prepared: Array<WebhookSnapshotRecord & { clean: WhRecord; bytes: number }> = []
	const seen = new Set<string>()
	for (const item of records) {
		assertWebhookKey(token.ownerDid, item.rkey)
		if (seen.has(item.rkey)) throw new Error('Invalid webhook snapshot')
		seen.add(item.rkey)
		const clean = sanitizeWebhookRecord(item.record)
		prepared.push({ ...item, clean, bytes: snapshotRecordBytes(clean) })
	}
	const pageBytes = prepared.reduce((total, item) => total + item.bytes, 0)

	return db.begin(async (tx) => {
		const state = await tx<
			Array<{
				generation: number | string | bigint
				status: string
				pages: number
				records: number
				decoded_bytes: number | string | bigint
			}>
		>`
      SELECT generation, status, pages, records, decoded_bytes
      FROM webhook_owner_reconciliations WHERE owner_did = ${token.ownerDid} FOR UPDATE
    `
		const current = state[0]
		if (!current) return { applied: false, upserted: 0 }
		if (
			current.status !== 'scanning' ||
			parseSafeSequence(current.generation, 'Invalid webhook generation') !== token.generation
		) {
			return { applied: false, upserted: 0 }
		}
		const pageCount = Number(current.pages) + 1
		const recordCount = Number(current.records) + prepared.length
		const byteCount = parseSafeSequence(current.decoded_bytes, 'Invalid reconciliation state') + pageBytes
		if (
			pageCount > MAX_RECONCILIATION_PAGES ||
			recordCount > MAX_RECONCILIATION_RECORDS ||
			byteCount > MAX_RECONCILIATION_BYTES
		) {
			throw new Error('Webhook reconciliation limit exceeded')
		}

		let upserted = 0
		for (const item of prepared) {
			const k = webhookKey(token.ownerDid, item.rkey)
			const existing = await tx<Array<{ source_generation: number | string | bigint }>>`
        SELECT source_generation FROM webhook_records WHERE k = ${k} FOR UPDATE
      `
			const tombstone = await tx<Array<{ source_generation: number | string | bigint }>>`
        SELECT source_generation FROM webhook_record_tombstones WHERE k = ${k} FOR UPDATE
      `
			if (
				(existing[0] &&
					parseSafeSequence(existing[0].source_generation, 'Invalid webhook generation') > token.generation) ||
				(tombstone[0] &&
					parseSafeSequence(tombstone[0].source_generation, 'Invalid webhook generation') > token.generation)
			) {
				continue
			}
			await upsertWebhookRecordInTransaction(
				tx,
				token.ownerDid,
				item.rkey,
				item.clean,
				{ generation: token.generation, cid: item.cid, revision: item.revision },
				false,
			)
			upserted++
		}
		await tx`
      UPDATE webhook_owner_reconciliations
      SET pages = ${pageCount}, records = ${recordCount}, decoded_bytes = ${byteCount}, updated_at = NOW()
      WHERE owner_did = ${token.ownerDid} AND generation = ${token.generation} AND status = 'scanning'
    `
		return { applied: true, upserted }
	})
}

/**
 * Finalize only a complete successful scan. Rows touched by a live event after
 * the fence, including delete tombstones, are excluded from deletion.
 */
export async function completeOwnerReconciliation(
	token: OwnerReconciliationToken,
): Promise<{ applied: boolean; deleted: number; complete: boolean }> {
	assertReconciliationToken(token)
	return db.begin(async (tx) => {
		// Each finalization pass owns only a small locked batch. Do not let a large
		// legacy owner turn completion into one long transaction or statement.
		await tx`SELECT set_config('statement_timeout', ${`${RECONCILIATION_STATEMENT_TIMEOUT_MS}ms`}, true)`
		await tx`SELECT set_config('lock_timeout', '1000ms', true)`
		const state = await tx<Array<{ generation: number | string | bigint; status: string }>>`
      SELECT generation, status FROM webhook_owner_reconciliations WHERE owner_did = ${token.ownerDid} FOR UPDATE
    `
		const current = state[0]
		if (!current) return { applied: false, deleted: 0, complete: false }
		if (
			current.status !== 'scanning' ||
			parseSafeSequence(current.generation, 'Invalid webhook generation') !== token.generation
		) {
			return { applied: false, deleted: 0, complete: false }
		}

		const deletedRecords = await tx<Array<{ k: string }>>`
      WITH victims AS (
        SELECT record.k, split_part(record.k, '/', 2) AS rkey
        FROM webhook_records record
        WHERE split_part(record.k, '/', 1) = ${token.ownerDid}
          AND record.source_generation < ${token.generation}
        ORDER BY record.k
        FOR UPDATE SKIP LOCKED
        LIMIT ${MAX_RECONCILIATION_PRUNE_BATCH}
      ), deleted_webhooks AS (
        DELETE FROM webhooks webhook
        USING victims
        WHERE webhook.did = ${token.ownerDid} AND webhook.rkey = victims.rkey
      ), deleted_records AS (
        DELETE FROM webhook_records record
        USING victims
        WHERE record.k = victims.k
        RETURNING record.k
      )
      SELECT k FROM deleted_records
    `
		if (deletedRecords.length > 0) {
			await tx`
        UPDATE webhook_owner_reconciliations
        SET prune_batches = prune_batches + 1,
            pruned_records = pruned_records + ${deletedRecords.length},
            updated_at = NOW()
        WHERE owner_did = ${token.ownerDid} AND generation = ${token.generation} AND status = 'scanning'
      `
			return { applied: true, deleted: deletedRecords.length, complete: false }
		}
		// SKIP LOCKED can transiently hide a concurrently live-updated stale row.
		// Confirm absence without a lock before declaring the owner complete.
		const staleRemaining = await tx<Array<{ remaining: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM webhook_records record
        WHERE split_part(record.k, '/', 1) = ${token.ownerDid}
          AND record.source_generation < ${token.generation}
      ) AS remaining
    `
		if (staleRemaining[0]?.remaining) return { applied: true, deleted: 0, complete: false }

		const deletedTombstones = await tx<Array<{ k: string }>>`
      WITH victims AS (
        SELECT tombstone.k
        FROM webhook_record_tombstones tombstone
        WHERE tombstone.owner_did = ${token.ownerDid}
          AND tombstone.source_generation <= ${token.generation}
        ORDER BY tombstone.k
        FOR UPDATE SKIP LOCKED
        LIMIT ${MAX_RECONCILIATION_PRUNE_BATCH}
      ), deleted_tombstones AS (
        DELETE FROM webhook_record_tombstones tombstone
        USING victims
        WHERE tombstone.k = victims.k
        RETURNING tombstone.k
      )
      SELECT k FROM deleted_tombstones
    `
		if (deletedTombstones.length > 0) {
			await tx`
        UPDATE webhook_owner_reconciliations
        SET prune_batches = prune_batches + 1, updated_at = NOW()
        WHERE owner_did = ${token.ownerDid} AND generation = ${token.generation} AND status = 'scanning'
      `
			return { applied: true, deleted: 0, complete: false }
		}
		const tombstonesRemaining = await tx<Array<{ remaining: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM webhook_record_tombstones tombstone
        WHERE tombstone.owner_did = ${token.ownerDid}
          AND tombstone.source_generation <= ${token.generation}
      ) AS remaining
    `
		if (tombstonesRemaining[0]?.remaining) return { applied: true, deleted: 0, complete: false }

		await tx`
      UPDATE webhook_owner_reconciliations
      SET status = 'complete', updated_at = NOW()
      WHERE owner_did = ${token.ownerDid} AND generation = ${token.generation} AND status = 'scanning'
    `
		return { applied: true, deleted: 0, complete: true }
	})
}

/** Mark an unsuccessful owner scan degraded. Matching queries exclude it until a future success. */
export async function failOwnerReconciliation(token: OwnerReconciliationToken): Promise<void> {
	assertReconciliationToken(token)
	await db`
    UPDATE webhook_owner_reconciliations
    SET status = 'failed', updated_at = NOW(), last_failed_at = NOW()
    WHERE owner_did = ${token.ownerDid} AND generation = ${token.generation} AND status = 'scanning'
  `
}

export async function getWebhookReconciliationHealth(): Promise<{ scanning: number; failed: number }> {
	const rows = await db<Array<{ status: string; count: number | string | bigint }>>`
    SELECT status, count(*) AS count FROM webhook_owner_reconciliations GROUP BY status
  `
	let scanning = 0
	let failed = 0
	for (const row of rows) {
		if (row.status === 'scanning') scanning = parseSafeSequence(row.count, 'Invalid reconciliation state')
		if (row.status === 'failed') failed = parseSafeSequence(row.count, 'Invalid reconciliation state')
	}
	return { scanning, failed }
}

/** Internal retry input; health APIs expose counts only, never owner identifiers. */
const STALE_RECONCILIATION_GRACE_MS = 15 * 60_000

/**
 * Internal retry input. In addition to explicit failures, a process-crashed
 * scan becomes recoverable only after a grace window, never while actively
 * scanning. Health APIs expose counts only, never owner identifiers.
 */
export async function listFailedWebhookReconciliationOwners(limit = 16): Promise<string[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid reconciliation retry limit')
	const rows = await db<Array<{ owner_did: string }>>`
    SELECT owner_did FROM webhook_owner_reconciliations
    WHERE status = 'failed'
       OR (status = 'scanning' AND updated_at < NOW() - (${STALE_RECONCILIATION_GRACE_MS} * INTERVAL '1 millisecond'))
    ORDER BY
      CASE WHEN status = 'failed' THEN 0 ELSE 1 END,
      last_failed_at ASC NULLS FIRST,
      updated_at ASC
    LIMIT ${limit}
  `
	return rows
		.map((row) => row.owner_did)
		.filter((ownerDid) => isNonEmptyBoundedString(ownerDid, 2048) && !ownerDid.includes('/'))
}

/** Explicit owner-status name for intake health/readiness checks. */
export const getWebhookOwnerReconciliationHealth = getWebhookReconciliationHealth

/**
 * Compatibility helper for an already buffered legacy caller. New backfill
 * code must use page APIs above so it never accumulates a whole owner snapshot.
 */
export async function reconcileWebhookSnapshot(
	ownerDid: string,
	generation: number,
	records: readonly WebhookSnapshotRecord[],
): Promise<{ applied: boolean; upserted: number; deleted: number }> {
	if (records.length > MAX_RECONCILIATION_RECORDS) throw new Error('Webhook snapshot is too large')
	const token: OwnerReconciliationToken = { ownerDid, generation }
	const page = await applyWebhookSnapshotPage(token, records)
	if (!page.applied) return { applied: false, upserted: 0, deleted: 0 }
	let deleted = 0
	for (;;) {
		const complete = await completeOwnerReconciliation(token)
		if (!complete.applied) return { applied: false, upserted: page.upserted, deleted }
		deleted += complete.deleted
		if (complete.complete) return { applied: true, upserted: page.upserted, deleted }
	}
}

const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_TOMBSTONE_ROWS = 100_000

/**
 * Periodic, bounded tombstone maintenance. A tombstone is never removed while
 * its owner has a scanning reconciliation, because an older snapshot page may
 * still need it to prevent resurrection.
 */
export async function pruneWebhookRecordTombstones(limit = 1_000): Promise<number> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('Invalid tombstone prune limit')
	const rows = await db<Array<{ k: string }>>`
    WITH candidates AS (
      SELECT tombstone.k
      FROM webhook_record_tombstones tombstone
      WHERE tombstone.deleted_at < NOW() - (${TOMBSTONE_RETENTION_MS} * INTERVAL '1 millisecond')
        AND NOT EXISTS (
          SELECT 1 FROM webhook_owner_reconciliations reconciliation
          WHERE reconciliation.owner_did = tombstone.owner_did AND reconciliation.status = 'scanning'
        )
      ORDER BY tombstone.deleted_at ASC
      LIMIT ${limit}
      FOR UPDATE OF tombstone SKIP LOCKED
    )
    DELETE FROM webhook_record_tombstones tombstone
    USING candidates
    WHERE tombstone.k = candidates.k
    RETURNING tombstone.k
  `
	return rows.length
}

export async function getWebhookRecordTombstoneHealth(): Promise<{ rows: number; maxRows: number }> {
	const rows = await db<Array<{ count: number | string | bigint }>>`
    SELECT count(*) AS count FROM webhook_record_tombstones
  `
	return { rows: parseSafeSequence(rows[0]?.count, 'Invalid tombstone state'), maxRows: MAX_TOMBSTONE_ROWS }
}

export interface EventLogEntry {
	ownerDid: string
	rkey: string
	/** Kept for compatibility; it is intentionally never persisted in audit logs. */
	url?: string
	eventKind: string
	eventDid: string
	eventCollection: string
	eventRkey: string
	cid?: string
	status: 'ok' | 'failed' | 'dead_letter'
	deliveredAt: string
}

/** Insert one audit entry. Pruning is periodic, never an O(n) operation per event. */
export async function insertEventLog(entry: EventLogEntry): Promise<void> {
	try {
		await db`
      INSERT INTO webhook_event_logs
        (owner_did, rkey, url, event_kind, event_did, event_collection, event_rkey, cid, status, delivered_at)
      VALUES
        (${entry.ownerDid}, ${entry.rkey}, ${'[redacted]'}, ${entry.eventKind},
         ${entry.eventDid}, ${entry.eventCollection}, ${entry.eventRkey},
         ${entry.cid ?? null}, ${entry.status}, ${entry.deliveredAt}::timestamptz)
    `
	} catch {
		logger.error('[DB] webhook audit insert failed')
	}
}

/** Keep audit rows bounded. Call this from a periodic worker maintenance pass. */
const EVENT_LOG_RETENTION_MS = 30 * 24 * 60 * 60_000
const MAX_EVENT_LOG_ROWS = 100_000

/** Delete one bounded oldest audit batch; never scan/delete an arbitrary backlog at once. */
export async function pruneEventLogs(batchSize = 1_000): Promise<number> {
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
		throw new Error('Invalid event log prune batch')
	}
	const rows = await db<Array<{ id: number }>>`
    WITH stats AS (
      SELECT count(*) AS total FROM webhook_event_logs
    ), victims AS (
      SELECT logs.id
      FROM webhook_event_logs logs CROSS JOIN stats
      WHERE logs.delivered_at < NOW() - (${EVENT_LOG_RETENTION_MS} * INTERVAL '1 millisecond')
         OR stats.total > ${MAX_EVENT_LOG_ROWS}
      ORDER BY logs.delivered_at ASC, logs.id ASC
      LIMIT ${batchSize}
      FOR UPDATE OF logs SKIP LOCKED
    )
    DELETE FROM webhook_event_logs logs
    USING victims
    WHERE logs.id = victims.id
    RETURNING logs.id
  `
	return rows.length
}

/** Return up to `limit` most-recent delivery events for an owner DID. */
export async function listEventLogs(ownerDid: string, limit = 100): Promise<EventLogEntry[]> {
	const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
	const rows = await db<
		Array<{
			rkey: string
			event_kind: string
			event_did: string
			event_collection: string
			event_rkey: string
			cid: string | null
			status: string
			delivered_at: string
		}>
	>`
    SELECT rkey, event_kind, event_did, event_collection, event_rkey, cid, status, delivered_at
    FROM webhook_event_logs
    WHERE owner_did = ${ownerDid}
    ORDER BY delivered_at DESC
    LIMIT ${boundedLimit}
  `
	return rows.map((row) => ({
		ownerDid,
		rkey: row.rkey,
		eventKind: row.event_kind,
		eventDid: row.event_did,
		eventCollection: row.event_collection,
		eventRkey: row.event_rkey,
		cid: row.cid ?? undefined,
		status: row.status as EventLogEntry['status'],
		deliveredAt: row.delivered_at,
	}))
}

/** Load the last successfully reconciled owner key for startup keyset resume. */
export async function loadWebhookBackfillContinuation(): Promise<string | undefined> {
	const rows = await db<Array<{ continuation: string | null }>>`
    SELECT continuation FROM webhook_backfill_state WHERE id = 'singleton' LIMIT 1
  `
	const continuation = rows[0]?.continuation
	if (continuation === null || continuation === undefined) return undefined
	if (!isNonEmptyBoundedString(continuation, 2048) || continuation.includes('/')) {
		throw new Error('Invalid webhook backfill continuation')
	}
	return continuation
}

/** Persist only after an owner page has completed; retry resumes from this exact key. */
export async function saveWebhookBackfillContinuation(continuation: string): Promise<void> {
	if (!isNonEmptyBoundedString(continuation, 2048) || continuation.includes('/')) {
		throw new Error('Invalid webhook backfill continuation')
	}
	await db`
    INSERT INTO webhook_backfill_state (id, continuation, updated_at)
    VALUES ('singleton', ${continuation}, NOW())
    ON CONFLICT (id) DO UPDATE SET continuation = EXCLUDED.continuation, updated_at = NOW()
  `
}

export async function clearWebhookBackfillContinuation(): Promise<void> {
	await db`DELETE FROM webhook_backfill_state WHERE id = 'singleton'`
}

export type WebhookIntakeQuarantineReason =
	| 'invalid_event'
	| 'invalid_subscription'
	| 'payload_invalid'
	| 'payload_too_large'
	| 'fanout_limit'

const INTAKE_QUARANTINE_REASONS = new Set<WebhookIntakeQuarantineReason>([
	'invalid_event',
	'invalid_subscription',
	'payload_invalid',
	'payload_too_large',
	'fanout_limit',
])
const INTAKE_QUARANTINE_RETENTION_MS = 30 * 24 * 60 * 60_000
const MAX_INTAKE_QUARANTINE_ROWS = 100_000

export interface WebhookIntakeQuarantineInput {
	relay: string
	timeUs: number
	rev: string
	did: string
	collection: string
	rkey: string
	reason: WebhookIntakeQuarantineReason
}

/**
 * Record only a hashed event identity and a finite reason. Rejected record
 * bytes, URLs, credentials, and payload text are deliberately never stored.
 */
export async function recordWebhookIntakeQuarantine(
	input: WebhookIntakeQuarantineInput,
	sql: SqlExecutor = db,
): Promise<void> {
	if (
		!Number.isSafeInteger(input.timeUs) ||
		input.timeUs < 0 ||
		!isNonEmptyBoundedString(input.did, 2048) ||
		input.did.includes('/') ||
		!isNonEmptyBoundedString(input.collection, 2048) ||
		input.collection.includes('/') ||
		!isNonEmptyBoundedString(input.rkey, 1024) ||
		!INTAKE_QUARANTINE_REASONS.has(input.reason)
	) {
		throw new Error('Invalid webhook intake quarantine')
	}
	assertAtprotoRevision(input.rev)
	const relay = relayId(input.relay)
	const eventAtUri = `at://${input.did}/${input.collection}/${input.rkey}`
	const eventAtUriHash = createHash('sha256').update(`wisp-webhook-event/v1\0${eventAtUri}`).digest('hex')
	const quarantineId = createHash('sha256')
		.update(`wisp-webhook-quarantine/v1\0${relay}\0${input.timeUs}\0${input.rev}\0${eventAtUri}`)
		.digest('hex')
	await sql`
    INSERT INTO webhook_intake_quarantines
      (quarantine_id, relay_id, source_time_us, source_revision, event_at_uri_hash, reason, created_at, last_seen_at)
    VALUES (${quarantineId}, ${relay}, ${input.timeUs}, ${input.rev}, ${eventAtUriHash}, ${input.reason}, NOW(), NOW())
    ON CONFLICT (quarantine_id) DO UPDATE SET
      reason = EXCLUDED.reason,
      last_seen_at = NOW()
  `
}

/** Delete one bounded oldest quarantine batch; maintenance owns scheduling. */
export async function pruneWebhookIntakeQuarantines(batchSize = 1_000): Promise<number> {
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
		throw new Error('Invalid webhook quarantine prune batch')
	}
	const rows = await db<Array<{ quarantine_id: string }>>`
    WITH stats AS (
      SELECT count(*) AS total FROM webhook_intake_quarantines
    ), victims AS (
      SELECT quarantine.quarantine_id
      FROM webhook_intake_quarantines quarantine CROSS JOIN stats
      WHERE quarantine.last_seen_at < NOW() - (${INTAKE_QUARANTINE_RETENTION_MS} * INTERVAL '1 millisecond')
         OR stats.total > ${MAX_INTAKE_QUARANTINE_ROWS}
      ORDER BY quarantine.last_seen_at ASC, quarantine.quarantine_id ASC
      LIMIT ${batchSize}
      FOR UPDATE OF quarantine SKIP LOCKED
    )
    DELETE FROM webhook_intake_quarantines quarantine
    USING victims
    WHERE quarantine.quarantine_id = victims.quarantine_id
    RETURNING quarantine.quarantine_id
  `
	return rows.length
}

function parseSafeSequence(value: number | string | bigint | undefined, errorMessage: string): number {
	if (value === undefined) throw new Error(errorMessage)
	const numberValue = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value
	if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw new Error(errorMessage)
	return numberValue
}

function relayId(relay: string): string {
	if (!isNonEmptyBoundedString(relay, 2048)) throw new Error('Invalid relay identity')
	let parsed: URL
	try {
		parsed = new URL(relay)
	} catch {
		throw new Error('Invalid relay identity')
	}
	if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') || !parsed.hostname) {
		throw new Error('Invalid relay identity')
	}
	parsed.username = ''
	parsed.password = ''
	parsed.search = ''
	parsed.hash = ''
	parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
	const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}`
	return createHash('sha256').update(`wisp-jetstream-relay/v1\0${canonical}`).digest('hex')
}

export type JetstreamConsumer = 'direct' | 'backlink' | 'registry'
const CURSOR_REWIND_US = 2_000_000 // two seconds in microseconds

function assertCursorInput(consumer: JetstreamConsumer, relay: string, sequence?: number): string {
	if (consumer !== 'direct' && consumer !== 'backlink' && consumer !== 'registry')
		throw new Error('Invalid Jetstream consumer')
	if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0))
		throw new Error('Invalid Jetstream cursor')
	return relayId(relay)
}

/**
 * Load a rewind-safe independent cursor. Legacy singleton state is migrated to
 * direct only when it represents the same normalized relay identity.
 */
export async function loadJetstreamCursor(consumer: JetstreamConsumer, relay: string): Promise<number | undefined> {
	const id = assertCursorInput(consumer, relay)
	const existing = await db<Array<{ seq: number | string | bigint }>>`
    SELECT seq FROM jetstream_cursors WHERE consumer_id = ${consumer} AND relay_id = ${id} LIMIT 1
  `
	if (existing[0]) return Math.max(0, parseSafeSequence(existing[0].seq, 'Invalid Jetstream cursor') - CURSOR_REWIND_US)
	if (consumer !== 'direct') return undefined

	const legacy = await db<Array<{ seq: number | string | bigint; jetstream_url: string | null }>>`
    SELECT seq, jetstream_url FROM jetstream_cursor WHERE id = 'singleton' LIMIT 1
  `
	const row = legacy[0]
	if (!row?.jetstream_url) return undefined
	let legacyId: string
	try {
		legacyId = relayId(row.jetstream_url)
	} catch {
		return undefined
	}
	if (legacyId !== id) return undefined
	const sequence = parseSafeSequence(row.seq, 'Invalid Jetstream cursor')
	await db`
    INSERT INTO jetstream_cursors (consumer_id, relay_id, seq, saved_at)
    VALUES (${consumer}, ${id}, ${sequence}, NOW())
    ON CONFLICT (consumer_id, relay_id) DO NOTHING
  `
	return Math.max(0, sequence - CURSOR_REWIND_US)
}

/** Persist a nondecreasing cursor for one consumer and one normalized relay. */
export async function saveJetstreamCursor(
	consumer: JetstreamConsumer,
	relay: string,
	sequence: number,
	sql: SqlExecutor = db,
): Promise<void> {
	const id = assertCursorInput(consumer, relay, sequence)
	await sql`
    INSERT INTO jetstream_cursors (consumer_id, relay_id, seq, saved_at)
    VALUES (${consumer}, ${id}, ${sequence}, NOW())
    ON CONFLICT (consumer_id, relay_id) DO UPDATE SET
      seq = GREATEST(jetstream_cursors.seq, EXCLUDED.seq),
      saved_at = NOW()
  `
}

/** Compatibility wrappers plus explicit independent-stream aliases for intake. */
export function saveCursor(seq: number, jetstreamUrl: string): Promise<void>
export function saveCursor(streamId: JetstreamConsumer, seq: number, relay: string): Promise<void>
export async function saveCursor(
	first: number | JetstreamConsumer,
	second: string | number,
	third?: string,
): Promise<void> {
	if (typeof first === 'number') {
		if (typeof second !== 'string') throw new Error('Invalid Jetstream cursor')
		await saveJetstreamCursor('direct', second, first)
		return
	}
	if (typeof second !== 'number' || typeof third !== 'string') throw new Error('Invalid Jetstream cursor')
	await saveJetstreamCursor(first, third, second)
}

export async function loadCursor(jetstreamUrl: string): Promise<number | undefined> {
	return loadJetstreamCursor('direct', jetstreamUrl)
}

/** Intake-facing explicit name; streamId is limited to independently durable consumers. */
export async function loadCursorForStream(streamId: string, relay: string): Promise<number | undefined> {
	if (streamId !== 'direct' && streamId !== 'backlink' && streamId !== 'registry')
		throw new Error('Invalid Jetstream consumer')
	return loadJetstreamCursor(streamId, relay)
}

/** Alias used by newer intake code. Pass the batch executor to commit it with the batch. */
export async function saveCursorForStream(
	streamId: string,
	cursor: number,
	relay: string,
	sql: SqlExecutor = db,
): Promise<void> {
	if (streamId !== 'direct' && streamId !== 'backlink' && streamId !== 'registry')
		throw new Error('Invalid Jetstream consumer')
	await saveJetstreamCursor(streamId, relay, cursor, sql)
}

export const MAX_BACKLINK_REFERENCE_ROWS = 100_000
export const MAX_BACKLINK_REFERENCES_PER_EVENT = 100
const MAX_BACKLINK_REFERENCE_BYTES = 32 * 1024
const BACKLINK_REFERENCE_TTL_MS = 7 * 24 * 60 * 60_000

function normalizeAtUri(value: string): string {
	if (!isNonEmptyBoundedString(value, 2048) || !value.startsWith('at://') || /[\s?#\\]/.test(value)) {
		throw new Error('Invalid AT-URI')
	}
	const parts = value.slice(5).split('/')
	const did = parts.shift()
	if (
		!did ||
		!/^did:[a-z0-9:%._-]+$/i.test(did) ||
		parts.length > 2 ||
		parts.some((part) => part.length === 0 || part.length > 1024)
	) {
		throw new Error('Invalid AT-URI')
	}
	// DIDs are case-insensitive at this matching boundary. Preserve collection
	// and rkey spelling, which may be meaningful to an application.
	return `at://${did.toLowerCase()}${parts.length > 0 ? `/${parts.join('/')}` : ''}`
}

function assertAtprotoRevision(rev: string): void {
	assertValidAtprotoRevision(rev)
}

export interface PriorReferenceIndexEntry {
	eventAtUri: string
	references: string[]
	timeUs: number
	rev: string
}

/**
 * Decode a stored reference list. Rows written before the jsonb binding fix
 * hold the encoded array as a jsonb *string*, so both shapes are accepted;
 * anything else is absent state rather than trusted state.
 */
function decodeReferences(value: unknown): string[] | undefined {
	let decoded = value
	if (typeof decoded === 'string') {
		try {
			decoded = JSON.parse(decoded)
		} catch {
			return undefined
		}
	}
	if (!Array.isArray(decoded) || !decoded.every((reference) => typeof reference === 'string')) return undefined
	return decoded
}

/** Load bounded prior relevant backlink references after restart. */
export async function loadPriorReferenceIndex(
	eventAtUri: string,
	sql: SqlExecutor = db,
): Promise<PriorReferenceIndexEntry | undefined> {
	const key = normalizeAtUri(eventAtUri)
	const rows = await sql<Array<{ refs: unknown; last_seq: number | string | bigint; last_rev: string }>>`
    SELECT refs, last_seq, last_rev
    FROM webhook_backlink_references
    WHERE event_at_uri = ${key} AND expires_at > NOW()
    LIMIT 1
  `
	const row = rows[0]
	const references = row ? decodeReferences(row.refs) : undefined
	if (!row || !references) return undefined
	return {
		eventAtUri: key,
		references: references.map((reference) => normalizeAtUri(reference)),
		timeUs: parseSafeSequence(row.last_seq, 'Invalid backlink reference'),
		rev: row.last_rev,
	}
}

/**
 * The durable outcome of one prior-reference write. Intake keeps an in-memory
 * index of the keys that own durable state, so a write reports what the row
 * now holds rather than only that a statement ran.
 */
export type PriorReferenceWrite =
	/** References are durable for this key at this event version. */
	| 'stored'
	/** The row survives as an empty tombstone; no reference remains. */
	| 'cleared'
	/** A newer event already owns this key, or no row exists to clear. */
	| 'stale'
	/** Global capacity refused a new key. Existing keys are never refused. */
	| 'rejected'

const CAPACITY_WARN_INTERVAL_MS = 60_000
let lastCapacityWarnAt = 0

/**
 * Persist refs only after filtering them to active backlink scopes. Event order
 * is monotonic: a replayed older create/update cannot replace newer references.
 *
 * One statement, no advisory lock. The backlink consumer sees every record in
 * the network, so a per-event transaction round trip is the intake throughput
 * ceiling. An empty set is a tombstone over known state and never creates a
 * row, which keeps this bounded table holding references rather than the relay.
 * Capacity is admitted per statement and converged by prunePriorReferenceIndex,
 * so concurrent writers may overshoot the bound by their own concurrency.
 */
export async function savePriorReferenceIndex(
	eventAtUri: string,
	references: readonly string[],
	timeUs: number,
	rev: string,
	sql: SqlExecutor = db,
): Promise<PriorReferenceWrite> {
	const key = normalizeAtUri(eventAtUri)
	if (!Number.isSafeInteger(timeUs) || timeUs < 0) throw new Error('Invalid backlink reference')
	assertAtprotoRevision(rev)
	if (references.length > MAX_BACKLINK_REFERENCES_PER_EVENT) throw new Error('Too many backlink references')
	const normalized = [...new Set(references.map(normalizeAtUri))]
	if (normalized.length > MAX_BACKLINK_REFERENCES_PER_EVENT) throw new Error('Too many backlink references')
	if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_BACKLINK_REFERENCE_BYTES)
		throw new Error('Backlink references are too large')

	if (normalized.length === 0) {
		const cleared = await sql<Array<{ event_at_uri: string }>>`
      UPDATE webhook_backlink_references SET
        refs = '[]'::jsonb,
        last_seq = ${timeUs}::bigint,
        last_rev = ${rev}::text,
        expires_at = NOW() + (${BACKLINK_REFERENCE_TTL_MS} * INTERVAL '1 millisecond'),
        updated_at = NOW()
      WHERE event_at_uri = ${key}
        AND (last_seq < ${timeUs}::bigint OR (last_seq = ${timeUs}::bigint AND last_rev <= ${rev}::text))
      RETURNING event_at_uri
    `
		return cleared.length > 0 ? 'cleared' : 'stale'
	}

	const rows = await sql<Array<{ admitted: boolean; written: boolean }>>`
    WITH admission AS (
      SELECT
        EXISTS (SELECT 1 FROM webhook_backlink_references WHERE event_at_uri = ${key})
          OR (SELECT count(*) FROM webhook_backlink_references) < ${MAX_BACKLINK_REFERENCE_ROWS} AS admitted
    ), written AS (
      INSERT INTO webhook_backlink_references (event_at_uri, refs, last_seq, last_rev, expires_at, updated_at)
      SELECT
        ${key}::text,
        -- The array binds as jsonb. A pre-encoded string would bind as a jsonb
        -- *string*, which no reader can distinguish from a one-element list.
        ${normalized}::jsonb,
        ${timeUs}::bigint,
        ${rev}::text,
        NOW() + (${BACKLINK_REFERENCE_TTL_MS} * INTERVAL '1 millisecond'),
        NOW()
      FROM admission WHERE admission.admitted
      ON CONFLICT (event_at_uri) DO UPDATE SET
        refs = EXCLUDED.refs,
        last_seq = EXCLUDED.last_seq,
        last_rev = EXCLUDED.last_rev,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
      WHERE webhook_backlink_references.last_seq < EXCLUDED.last_seq
         OR (webhook_backlink_references.last_seq = EXCLUDED.last_seq AND webhook_backlink_references.last_rev <= EXCLUDED.last_rev)
      RETURNING event_at_uri
    )
    SELECT admission.admitted, EXISTS (SELECT 1 FROM written) AS written FROM admission
  `
	const outcome = rows[0]
	if (outcome?.written === true) return 'stored'
	if (outcome?.admitted === false) {
		// The event still completes direct matching and delivery; it simply has no
		// durable backlink prior state until maintenance frees capacity. One
		// warning per interval: this path is reached once per relay event.
		const now = Date.now()
		if (now - lastCapacityWarnAt >= CAPACITY_WARN_INTERVAL_MS) {
			lastCapacityWarnAt = now
			logger.warn('[DB] backlink reference capacity reached')
		}
		return 'rejected'
	}
	return 'stale'
}

/** Bounded hydration of the keys that own durable references after a restart. */
export async function loadPriorReferenceKeys(
	limit = MAX_BACKLINK_REFERENCE_ROWS,
): Promise<{ keys: string[]; complete: boolean }> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BACKLINK_REFERENCE_ROWS) {
		throw new Error('Invalid backlink reference key limit')
	}
	const rows = await db<Array<{ event_at_uri: string }>>`
    SELECT event_at_uri FROM webhook_backlink_references
    -- '"[]"' is the legacy double-encoded empty list. Both spellings mean the
    -- key owns no reference and therefore needs no in-memory entry.
    WHERE expires_at > NOW() AND refs::text NOT IN ('[]', '"[]"')
    ORDER BY expires_at DESC
    LIMIT ${limit + 1}
  `
	// An incomplete index makes intake load every key instead of trusting it.
	return { keys: rows.slice(0, limit).map((row) => row.event_at_uri), complete: rows.length <= limit }
}

/** Delete only if a later event has not already repopulated the same record. */
export async function deletePriorReferenceIndex(
	eventAtUri: string,
	timeUs: number,
	rev: string,
	sql: SqlExecutor = db,
): Promise<boolean> {
	const key = normalizeAtUri(eventAtUri)
	if (!Number.isSafeInteger(timeUs) || timeUs < 0) throw new Error('Invalid backlink reference')
	assertAtprotoRevision(rev)
	const rows = await sql<Array<{ event_at_uri: string }>>`
    DELETE FROM webhook_backlink_references
    WHERE event_at_uri = ${key}
      AND (last_seq < ${timeUs} OR (last_seq = ${timeUs} AND last_rev <= ${rev}))
    RETURNING event_at_uri
  `
	return rows.length > 0
}

/** Periodic bounded maintenance for TTL and global capacity. */
export async function prunePriorReferenceIndex(batchSize = 1_000): Promise<number> {
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
		throw new Error('Invalid backlink reference prune batch')
	}
	const rows = await db<Array<{ event_at_uri: string }>>`
    WITH stats AS (
      SELECT count(*) AS total FROM webhook_backlink_references
    ), victims AS (
      SELECT refs.event_at_uri
      FROM webhook_backlink_references refs CROSS JOIN stats
      -- Admission refuses a new key at the bound, so eviction must start there
      -- too. A strictly greater test deadlocks the table at exactly capacity.
      WHERE refs.expires_at <= NOW() OR stats.total >= ${MAX_BACKLINK_REFERENCE_ROWS}
      ORDER BY refs.expires_at ASC, refs.updated_at ASC
      LIMIT ${batchSize}
      FOR UPDATE OF refs SKIP LOCKED
    )
    DELETE FROM webhook_backlink_references refs
    USING victims
    WHERE refs.event_at_uri = victims.event_at_uri
    RETURNING refs.event_at_uri
  `
	return rows.length
}

export async function getPriorReferenceIndexHealth(): Promise<{ rows: number; maxRows: number }> {
	const rows = await db<Array<{ count: number | string | bigint }>>`
    SELECT count(*) AS count FROM webhook_backlink_references WHERE expires_at > NOW()
  `
	return {
		rows: parseSafeSequence(rows[0]?.count, 'Invalid backlink reference state'),
		maxRows: MAX_BACKLINK_REFERENCE_ROWS,
	}
}

/**
 * A prepared queue row. It deliberately contains IDs and JSON only; signing
 * secrets must be looked up at delivery time.
 */
export interface NewWebhookDeliveryEventRow {
	eventId: string
	payloadJson: string
	sourceRelayId: string
	sourceTimeUs: number
	sourceRevision: string
	sourceOperation: string
}

/** A prepared subscription-specific row. The large event body lives exactly once in webhook_delivery_events. */
export interface NewWebhookDeliveryOutboxRow {
	deliveryId: string
	eventId: string
	ownerDid: string
	webhookRkey: string
	targetUrl: string
	secretId?: string
	signingMode: 'none' | 'secret_id' | 'record_secret'
	subscriptionFingerprint: string
}

function assertOutboxEventRow(row: NewWebhookDeliveryEventRow): void {
	if (
		!isNonEmptyBoundedString(row.eventId, 256) ||
		!isNonEmptyBoundedString(row.sourceRelayId, 128) ||
		!isNonEmptyBoundedString(row.sourceRevision, 1024) ||
		!isNonEmptyBoundedString(row.sourceOperation, 32) ||
		!Number.isSafeInteger(row.sourceTimeUs) ||
		row.sourceTimeUs < 0 ||
		row.payloadJson.length > 512 * 1024
	) {
		throw new Error('Invalid webhook delivery event')
	}
	try {
		const payload = JSON.parse(row.payloadJson) as { collection?: unknown; record?: unknown }
		if (
			payload.collection === 'place.wisp.v2.wh' &&
			payload.record &&
			typeof payload.record === 'object' &&
			!Array.isArray(payload.record) &&
			'secret' in payload.record
		) {
			throw new Error('signing secret')
		}
	} catch {
		throw new Error('Invalid webhook delivery event')
	}
}

function assertOutboxRow(row: NewWebhookDeliveryOutboxRow, eventId: string): void {
	assertWebhookKey(row.ownerDid, row.webhookRkey)
	if (
		row.eventId !== eventId ||
		!isNonEmptyBoundedString(row.deliveryId, 256) ||
		!isNonEmptyBoundedString(row.eventId, 256) ||
		!isNonEmptyBoundedString(row.targetUrl, 2048) ||
		!isNonEmptyBoundedString(row.subscriptionFingerprint, 128) ||
		(row.secretId !== undefined && !isValidWebhookSecretId(row.secretId))
	) {
		throw new Error('Invalid webhook delivery')
	}
}

/**
 * Insert one immutable event and a bounded subscription chunk atomically.
 * Duplicate identities are harmless; only small subscription fields travel in
 * the bulk UNNEST, so a large payload is never multiplied by fanout.
 */
export async function enqueueWebhookDeliveryOutbox(
	event: NewWebhookDeliveryEventRow,
	rows: readonly NewWebhookDeliveryOutboxRow[],
	ensureEvent = true,
	/** When intake supplies its batch executor, these rows commit with the cursor. */
	sql?: SqlExecutor,
): Promise<{ enqueued: number; deduplicated: number }> {
	if (rows.length > 1_000 || typeof ensureEvent !== 'boolean') throw new Error('Webhook delivery batch is too large')
	assertOutboxEventRow(event)
	for (const row of rows) assertOutboxRow(row, event.eventId)
	if (rows.length === 0) return { enqueued: 0, deduplicated: 0 }

	// An intake batch already owns a transaction; joining it keeps these rows and
	// the stream cursor in one commit. Standalone callers still get their own.
	const write = async (tx: SqlExecutor): Promise<{ enqueued: number; deduplicated: number }> => {
		// A collision or mismatched replay must not silently attach rows to a
		// different immutable body. The deterministic event ID normally makes this
		// impossible, but the check also detects corruption.
		if (ensureEvent) {
			const insertedEvent = await tx<Array<{ event_id: string }>>`
	      INSERT INTO webhook_delivery_events (
	        event_id, payload, payload_body, source_relay_id, source_time_us, source_revision, source_operation
	      ) VALUES (
	        ${event.eventId}, ${event.payloadJson}::jsonb, ${event.payloadJson}, ${event.sourceRelayId},
	        ${event.sourceTimeUs}, ${event.sourceRevision}, ${event.sourceOperation}
	      )
	      ON CONFLICT (event_id) DO NOTHING
	      RETURNING event_id
	    `
			if (insertedEvent.length === 0) {
				const matchingEvent = await tx<Array<{ event_id: string }>>`
	        SELECT event_id FROM webhook_delivery_events
	        WHERE event_id = ${event.eventId}
	          AND payload_body = ${event.payloadJson}
	          AND source_relay_id = ${event.sourceRelayId}
	          AND source_time_us = ${event.sourceTimeUs}
	          AND source_revision = ${event.sourceRevision}
	          AND source_operation = ${event.sourceOperation}
	        LIMIT 1
	      `
				if (matchingEvent.length !== 1) throw new Error('Webhook delivery event identity conflict')
			}
		}

		const inserted = await tx<Array<{ delivery_id: string }>>`
      WITH input AS (
        SELECT * FROM UNNEST(
          ${tx.array(
						rows.map((row) => row.deliveryId),
						'TEXT',
					)},
          ${tx.array(
						rows.map((row) => row.eventId),
						'TEXT',
					)},
          ${tx.array(
						rows.map((row) => row.ownerDid),
						'TEXT',
					)},
          ${tx.array(
						rows.map((row) => row.webhookRkey),
						'TEXT',
					)},
          ${tx.array(
						rows.map((row) => row.targetUrl),
						'TEXT',
					)},
          ${tx.array(
						rows.map((row) => row.secretId ?? null),
						'TEXT',
					)},
          ${tx.array(
						rows.map((row) => row.signingMode),
						'TEXT',
					)},
          ${tx.array(
						rows.map((row) => row.subscriptionFingerprint),
						'TEXT',
					)}
        ) AS values_row(
          delivery_id, event_id, owner_did, webhook_rkey, target_url, secret_id,
          signing_mode, subscription_fingerprint
        )
      )
      INSERT INTO webhook_delivery_outbox (
        delivery_id, event_id, owner_did, webhook_rkey, target_url, secret_id,
        signing_mode, subscription_fingerprint, status, next_attempt_at
      )
      SELECT
        delivery_id, event_id, owner_did, webhook_rkey, target_url, secret_id,
        signing_mode, subscription_fingerprint, 'pending', NOW()
      FROM input
      ON CONFLICT (delivery_id) DO NOTHING
      RETURNING delivery_id
    `
		return { enqueued: inserted.length, deduplicated: rows.length - inserted.length }
	}

	return sql ? write(sql) : db.begin(async (tx) => write(tx as unknown as SqlExecutor))
}

export interface ClaimedWebhookDelivery {
	deliveryId: string
	ownerDid: string
	webhookRkey: string
	targetUrl: string
	secretId?: string
	signingMode: 'none' | 'secret_id' | 'record_secret'
	subscriptionFingerprint: string
	payloadBody: string
	attemptCount: number
	leaseToken: string
	sourceOperation: string
	sourceTimeUs: number
}

/** Claim ready or abandoned rows under a lease. Multiple processes cooperate via SKIP LOCKED. */
export async function claimWebhookDeliveryOutbox(
	leaseToken: string,
	limit: number,
	leaseMs: number,
): Promise<ClaimedWebhookDelivery[]> {
	if (!isNonEmptyBoundedString(leaseToken, 256) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
		throw new Error('Invalid webhook delivery claim')
	}
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
		throw new Error('Invalid webhook delivery lease')
	}
	return db.begin(async (tx) => {
		// Keep queue SQL bounded below the lease so an abandoned query cannot hold ownership.
		await tx`SELECT set_config('statement_timeout', ${String(Math.max(1_000, leaseMs - 1_000))}, true)`
		const rows = await tx<
			Array<{
				delivery_id: string
				owner_did: string
				webhook_rkey: string
				target_url: string
				secret_id: string | null
				signing_mode: ClaimedWebhookDelivery['signingMode']
				subscription_fingerprint: string
				payload_body: string | null
				attempt_count: number
				source_operation: string | null
				source_time_us: number | string | bigint | null
			}>
		>`
      WITH candidates AS (
        SELECT delivery_id
        FROM webhook_delivery_outbox
        WHERE (status = 'pending' AND next_attempt_at <= NOW())
           OR (status = 'leased' AND leased_until <= NOW())
        ORDER BY next_attempt_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      ), claimed AS (
        UPDATE webhook_delivery_outbox queue
        SET status = 'leased',
            lease_token = ${leaseToken},
            leased_until = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
            updated_at = NOW()
        FROM candidates
        WHERE queue.delivery_id = candidates.delivery_id
        RETURNING queue.delivery_id, queue.event_id, queue.owner_did, queue.webhook_rkey, queue.target_url,
                  queue.secret_id, queue.signing_mode, queue.subscription_fingerprint, queue.payload_body,
                  queue.attempt_count, queue.source_operation, queue.source_time_us
      )
      SELECT claimed.delivery_id, claimed.owner_did, claimed.webhook_rkey, claimed.target_url,
             claimed.secret_id, claimed.signing_mode, claimed.subscription_fingerprint,
             COALESCE(event.payload_body, claimed.payload_body) AS payload_body,
             claimed.attempt_count,
             COALESCE(event.source_operation, claimed.source_operation) AS source_operation,
             COALESCE(event.source_time_us, claimed.source_time_us) AS source_time_us
      FROM claimed
      LEFT JOIN webhook_delivery_events event ON event.event_id = claimed.event_id
    `
		return rows.map((row) => {
			if (!row.payload_body || !row.source_operation || row.source_time_us === null) {
				throw new Error('Invalid webhook delivery event reference')
			}
			return {
				deliveryId: row.delivery_id,
				ownerDid: row.owner_did,
				webhookRkey: row.webhook_rkey,
				targetUrl: row.target_url,
				secretId: row.secret_id ?? undefined,
				signingMode: row.signing_mode,
				subscriptionFingerprint: row.subscription_fingerprint,
				payloadBody: row.payload_body,
				attemptCount: Number(row.attempt_count),
				leaseToken,
				sourceOperation: row.source_operation,
				sourceTimeUs: parseSafeSequence(row.source_time_us, 'Invalid webhook delivery'),
			}
		})
	})
}

/** Renew an active lease. A false result means another worker may now own the row. */
export async function renewWebhookDeliveryLease(
	deliveryId: string,
	leaseToken: string,
	leaseMs: number,
): Promise<boolean> {
	if (!isNonEmptyBoundedString(deliveryId, 256) || !isNonEmptyBoundedString(leaseToken, 256)) {
		throw new Error('Invalid webhook delivery lease')
	}
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 10 * 60_000) {
		throw new Error('Invalid webhook delivery lease')
	}
	const rows = await db<Array<{ delivery_id: string }>>`
    UPDATE webhook_delivery_outbox
    SET leased_until = NOW() + (${leaseMs} * INTERVAL '1 millisecond'), updated_at = NOW()
    WHERE delivery_id = ${deliveryId}
      AND status = 'leased'
      AND lease_token = ${leaseToken}
      AND leased_until > NOW()
    RETURNING delivery_id
  `
	return rows.length === 1
}

/** Mark a leased delivery successful. A stale worker cannot overwrite a newer lease. */
export async function markWebhookDeliverySucceeded(
	deliveryId: string,
	leaseToken: string,
	httpStatus: number,
): Promise<boolean> {
	if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) throw new Error('Invalid webhook status')
	const rows = await db<Array<{ delivery_id: string }>>`
    UPDATE webhook_delivery_outbox
    SET status = 'delivered', lease_token = NULL, leased_until = NULL,
        delivered_at = NOW(), last_error_kind = NULL, last_http_status = ${httpStatus}, updated_at = NOW()
    WHERE delivery_id = ${deliveryId} AND status = 'leased' AND lease_token = ${leaseToken}
    RETURNING delivery_id
  `
	return rows.length === 1
}

/** Cancel a lease when the current subscription has been removed, disabled, or changed. */
export async function cancelWebhookDeliveryForSubscriptionChange(
	deliveryId: string,
	leaseToken: string,
): Promise<boolean> {
	const rows = await db<Array<{ delivery_id: string }>>`
    UPDATE webhook_delivery_outbox
    SET status = 'cancelled_subscription_changed', lease_token = NULL, leased_until = NULL,
        cancelled_at = NOW(), last_error_kind = 'subscription_changed', updated_at = NOW()
    WHERE delivery_id = ${deliveryId} AND status = 'leased' AND lease_token = ${leaseToken}
    RETURNING delivery_id
  `
	return rows.length === 1
}

export interface WebhookDeliveryRetryUpdate {
	nextAttemptAt: string
	errorKind: string
	httpStatus?: number
	deadLetter: boolean
}

/** Return a leased row to retry state or retain it as a bounded dead letter. */
export async function rescheduleWebhookDelivery(
	deliveryId: string,
	leaseToken: string,
	update: WebhookDeliveryRetryUpdate,
): Promise<boolean> {
	if (!isNonEmptyBoundedString(update.errorKind, 64) || Number.isNaN(Date.parse(update.nextAttemptAt))) {
		throw new Error('Invalid webhook retry')
	}
	const rows = await db<Array<{ delivery_id: string }>>`
    UPDATE webhook_delivery_outbox
    SET attempt_count = attempt_count + 1,
        status = ${update.deadLetter ? 'dead_letter' : 'pending'},
        lease_token = NULL,
        leased_until = NULL,
        next_attempt_at = ${update.nextAttemptAt}::timestamptz,
        last_error_kind = ${update.errorKind},
        last_http_status = ${update.httpStatus ?? null},
        dead_lettered_at = CASE WHEN ${update.deadLetter} THEN NOW() ELSE NULL END,
        updated_at = NOW()
    WHERE delivery_id = ${deliveryId} AND status = 'leased' AND lease_token = ${leaseToken}
    RETURNING delivery_id
  `
	return rows.length === 1
}

/** Remove old terminal state. Pending and leased events are never pruned. */
export async function pruneWebhookDeliveryOutbox(
	deliveredRetentionMs: number,
	deadLetterRetentionMs: number,
	batchSize = 1_000,
): Promise<number> {
	for (const value of [deliveredRetentionMs, deadLetterRetentionMs]) {
		if (!Number.isSafeInteger(value) || value < 60_000 || value > 365 * 24 * 60 * 60_000) {
			throw new Error('Invalid webhook retention')
		}
	}
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000)
		throw new Error('Invalid webhook prune batch')
	const rows = await db<Array<{ delivery_id: string }>>`
    WITH victims AS (
      SELECT delivery_id
      FROM webhook_delivery_outbox
      WHERE (status = 'delivered' AND delivered_at < NOW() - (${deliveredRetentionMs} * INTERVAL '1 millisecond'))
         OR (status = 'dead_letter' AND dead_lettered_at < NOW() - (${deadLetterRetentionMs} * INTERVAL '1 millisecond'))
         OR (status = 'cancelled_subscription_changed' AND cancelled_at < NOW() - (${deliveredRetentionMs} * INTERVAL '1 millisecond'))
      ORDER BY COALESCE(delivered_at, dead_lettered_at, cancelled_at, created_at) ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM webhook_delivery_outbox queue
    USING victims
    WHERE queue.delivery_id = victims.delivery_id
    RETURNING queue.delivery_id
  `
	return rows.length
}

/** Look up an inline PDS record secret at attempt time; never copy it into the outbox. */
/** Delete one bounded batch of old event bodies only after every outbox reference is gone. */
export async function pruneWebhookDeliveryEvents(retentionMs: number, batchSize = 1_000): Promise<number> {
	if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000 || retentionMs > 365 * 24 * 60 * 60_000) {
		throw new Error('Invalid webhook event retention')
	}
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
		throw new Error('Invalid webhook event prune batch')
	}
	const rows = await db<Array<{ event_id: string }>>`
    WITH victims AS (
      SELECT event.event_id
      FROM webhook_delivery_events event
      WHERE event.created_at < NOW() - (${retentionMs} * INTERVAL '1 millisecond')
        AND NOT EXISTS (
          SELECT 1 FROM webhook_delivery_outbox queue WHERE queue.event_id = event.event_id
        )
      ORDER BY event.created_at ASC, event.event_id ASC
      LIMIT ${batchSize}
      FOR UPDATE OF event SKIP LOCKED
    )
    DELETE FROM webhook_delivery_events event
    USING victims
    WHERE event.event_id = victims.event_id
    RETURNING event.event_id
  `
	return rows.length
}

export async function getWebhookInlineSecret(ownerDid: string, rkey: string): Promise<string | null> {
	const k = webhookKey(ownerDid, rkey)
	const rows = await db<Array<{ secret: string | null }>>`
    SELECT v->>'secret' AS secret FROM webhook_records WHERE k = ${k} LIMIT 1
  `
	return rows[0]?.secret ?? null
}

/**
 * Look up a server-managed signing secret at attempt time. Encryption is wired
 * in below by the shared atproto-utils primitive; callers treat an exception as
 * retryable and must not log it.
 */
export async function getWebhookSecretToken(ownerDid: string, name: string): Promise<string | null> {
	assertWebhookKey(ownerDid, name)
	if (!isValidWebhookSecretId(name)) throw new Error('Invalid webhook secret identifier')
	const rows = await db<Array<{ token: string }>>`
    SELECT token FROM webhook_secrets WHERE did = ${ownerDid} AND name = ${name} LIMIT 1
  `
	const envelope = rows[0]?.token
	if (!envelope) return null
	// Missing keys, tampered envelopes, and legacy plaintext all throw the same
	// safe error. The delivery worker treats it as retryable and never logs it.
	return decryptWebhookSecret(
		envelope,
		parseWebhookSecretEncryptionKeyring({
			WEBHOOK_SECRET_ENCRYPTION_KEY: process.env.WEBHOOK_SECRET_ENCRYPTION_KEY,
			WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS: process.env.WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS,
		}),
	)
}

/** Collect all DIDs known to the service for startup backfill. */
/**
 * Return one keyset page of known owners. Each source query is independently
 * bounded before a small in-memory merge, so startup never materializes all
 * DIDs just to begin reconciliation.
 */
export async function listKnownWebhookOwnerDidsPage(after?: string, limit = 100): Promise<string[]> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Invalid known owner page limit')
	if (after !== undefined && (!isNonEmptyBoundedString(after, 2048) || after.includes('/'))) {
		throw new Error('Invalid known owner page cursor')
	}
	const cursor = after ?? ''
	const [sites, webhooks, sessions] = await Promise.all([
		db<Array<{ did: string }>>`
      SELECT did FROM site_cache
      WHERE did IS NOT NULL AND did <> '' AND did > ${cursor}
      GROUP BY did
      ORDER BY did ASC
      LIMIT ${limit}
    `,
		db<Array<{ did: string }>>`
      SELECT did FROM webhooks
      WHERE did IS NOT NULL AND did <> '' AND did > ${cursor}
      GROUP BY did
      ORDER BY did ASC
      LIMIT ${limit}
    `,
		(async (): Promise<Array<{ did: string }>> => {
			try {
				return await db<Array<{ did: string }>>`
          SELECT sub AS did FROM oauth_sessions
          WHERE sub IS NOT NULL AND sub <> '' AND sub > ${cursor}
          GROUP BY sub
          ORDER BY sub ASC
          LIMIT ${limit}
        `
			} catch {
				// oauth_sessions is optional for standalone webhook-service installs.
				return []
			}
		})(),
	])
	const owners = new Set<string>()
	for (const row of [...sites, ...webhooks, ...sessions]) {
		if (isNonEmptyBoundedString(row.did, 2048) && !row.did.includes('/')) owners.add(row.did)
	}
	return [...owners].sort().slice(0, limit)
}

export interface WebhookMaintenanceOptions {
	deliveredRetentionMs: number
	deadLetterRetentionMs: number
	batchSize?: number
}

/**
 * One service process performs a bounded maintenance batch at a time. A
 * session advisory lock avoids every worker replica repeatedly scanning the
 * same queue; helpers remain separately exported for explicit admin jobs.
 */
export async function runWebhookMaintenance(options: WebhookMaintenanceOptions): Promise<{
	ran: boolean
	outbox: number
	eventLogs: number
	tombstones: number
	backlinkReferences: number
	intakeQuarantines: number
	deliveryEvents: number
}> {
	const reserved = await db.reserve()
	try {
		const lockRows = await reserved<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(814732192) AS locked
    `
		if (!lockRows[0]?.locked)
			return {
				ran: false,
				outbox: 0,
				eventLogs: 0,
				tombstones: 0,
				backlinkReferences: 0,
				intakeQuarantines: 0,
				deliveryEvents: 0,
			}
		try {
			const batchSize = options.batchSize ?? 1_000
			const outbox = await pruneWebhookDeliveryOutbox(
				options.deliveredRetentionMs,
				options.deadLetterRetentionMs,
				batchSize,
			)
			const eventLogs = await pruneEventLogs(batchSize)
			const tombstones = await pruneWebhookRecordTombstones(batchSize)
			const backlinkReferences = await prunePriorReferenceIndex(batchSize)
			const intakeQuarantines = await pruneWebhookIntakeQuarantines(batchSize)
			const deliveryEvents = await pruneWebhookDeliveryEvents(options.deliveredRetentionMs, batchSize)
			return { ran: true, outbox, eventLogs, tombstones, backlinkReferences, intakeQuarantines, deliveryEvents }
		} finally {
			await reserved`SELECT pg_advisory_unlock(814732192)`
		}
	} finally {
		reserved.release()
	}
}

/** Close all database connections gracefully. */
export async function closeDatabase(): Promise<void> {
	await db.close()
	logger.info('[DB] Database connections closed')
}
