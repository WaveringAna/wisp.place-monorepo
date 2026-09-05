import type { SQL } from 'bun'
import {
	createRecordedMigrationRunner,
	type MigrationLedgerStore,
	type MigrationLockCleanupFailure,
	type RecordedMigrationRunner,
	sanitizeMigrationStartupError,
	withReservedMigrationAdvisoryLock,
} from './migration-runner'

// Stable 64-bit namespace: "WISPMIGR". This serializes migrations across all
// main-app instances that share the primary database.
const MIGRATION_ADVISORY_LOCK_KEY = 0x574953504d494752n
const reportMigrationLockCleanupFailure = (kind: MigrationLockCleanupFailure): void => {
	// Keep this intentionally static: driver errors can contain a database URL.
	console.error(`[DB Migration] Advisory lock cleanup failed: ${kind}`)
}

type LocalMigrationRun = (name: string, fn: () => Promise<unknown>) => Promise<void>

interface SchemaMigrationExecutor {
	run(name: string, fn: (transaction: SQL) => Promise<unknown>): Promise<void>
}

/**
 * The ledger is the only DDL intentionally revisited on startup. Every other
 * schema/data-transition step is claimed, applied, and recorded in one primary
 * transaction, so a restart skips recorded work and retries interrupted work.
 */
const createSchemaMigrationExecutor = async (primaryDb: SQL): Promise<SchemaMigrationExecutor> => {
	await primaryDb`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`

	const store: MigrationLedgerStore<SQL> = {
		async loadAppliedNames(): Promise<ReadonlySet<string>> {
			const rows = await primaryDb<Array<{ name: string }>>`SELECT name FROM schema_migrations`
			return new Set(rows.map((row) => row.name))
		},
		async transaction(operation): Promise<void> {
			await primaryDb.begin(async (transaction) => {
				await operation({
					connection: transaction,
					async isMigrationApplied(name: string): Promise<boolean> {
						const rows = await transaction<Array<{ exists: boolean }>>`
							SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name = ${name}) AS exists
						`
						return rows[0]?.exists === true
					},
					async recordMigration(name: string): Promise<void> {
						await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`
					},
				})
			})
		},
	}

	const runner: RecordedMigrationRunner<SQL> = await createRecordedMigrationRunner(store)
	return {
		async run(name, fn): Promise<void> {
			await runner.run({ name, run: fn })
		},
	}
}

const bootstrapSchema = async (runMigration: LocalMigrationRun, getDb: () => SQL): Promise<void> => {
	await runMigration('create oauth_states', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS oauth_states (
				key TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
			)
		`
	})

	await runMigration('create oauth_sessions', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS oauth_sessions (
				sub TEXT PRIMARY KEY,
				data TEXT NOT NULL,
				updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
				expires_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) + 2592000
			)
		`
	})

	await runMigration('create oauth_keys', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS oauth_keys (
				kid TEXT PRIMARY KEY,
				jwk TEXT NOT NULL,
				created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
			)
		`
	})

	await runMigration('create cookie_secrets', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS cookie_secrets (
				id TEXT PRIMARY KEY DEFAULT 'default',
				secret TEXT NOT NULL,
				created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
			)
		`
	})

	await runMigration('create service_identity_keys', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS service_identity_keys (
				id TEXT PRIMARY KEY DEFAULT 'default',
				public_key_multibase TEXT NOT NULL,
				private_key_multibase TEXT,
				created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
				updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
			)
		`
	})

	await runMigration('create domains', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS domains (
				domain TEXT PRIMARY KEY,
				did TEXT NOT NULL,
				rkey TEXT,
				created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
			)
		`
	})

	await runMigration('create custom_domains', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS custom_domains (
				id TEXT PRIMARY KEY,
				domain TEXT UNIQUE NOT NULL,
				did TEXT NOT NULL,
				rkey TEXT,
				verified BOOLEAN DEFAULT false,
				last_verified_at BIGINT,
				created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
			)
		`
	})

	await runMigration('create site_cache', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS site_cache (
				did TEXT NOT NULL,
				rkey TEXT NOT NULL,
				record_cid TEXT NOT NULL,
				file_cids JSONB NOT NULL DEFAULT '{}',
				cached_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
				updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
				cold_synced BOOLEAN NOT NULL DEFAULT true,
				PRIMARY KEY (did, rkey)
			)
		`
	})

	await runMigration('create site_settings_cache', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS site_settings_cache (
				did TEXT NOT NULL,
				rkey TEXT NOT NULL,
				record_cid TEXT NOT NULL,
				directory_listing BOOLEAN NOT NULL DEFAULT false,
				spa_mode TEXT,
				custom_404 TEXT,
				index_files JSONB,
				clean_urls BOOLEAN NOT NULL DEFAULT true,
				headers JSONB,
				cached_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
				updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
				PRIMARY KEY (did, rkey)
			)
		`
	})

	await runMigration('create supporter', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS supporter (
				did TEXT PRIMARY KEY,
				created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
			)
		`
	})

	await runMigration('create webhook_secrets', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS webhook_secrets (
				did TEXT NOT NULL,
				name TEXT NOT NULL,
				token TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				last_rotated_at TIMESTAMPTZ,
				PRIMARY KEY (did, name)
			)
		`
	})

	await runMigration('create webhook_mutation_rate_limits', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS webhook_mutation_rate_limits (
				did TEXT NOT NULL,
				action TEXT NOT NULL CHECK (action IN ('create', 'delete')),
				window_started_at BIGINT NOT NULL,
				mutation_count INTEGER NOT NULL CHECK (mutation_count >= 0),
				PRIMARY KEY (did, action)
			)
		`
	})

	await runMigration('create private_sites', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS private_sites (
				site_id TEXT PRIMARY KEY,
				owner_did TEXT NOT NULL,
				name TEXT NOT NULL,
				file_count INTEGER NOT NULL DEFAULT 0 CONSTRAINT private_sites_file_count_nonnegative_check CHECK (file_count >= 0) CONSTRAINT private_sites_file_count_limit_check CHECK (file_count <= 500),
				total_bytes BIGINT NOT NULL DEFAULT 0 CONSTRAINT private_sites_total_bytes_nonnegative_check CHECK (total_bytes >= 0) CONSTRAINT private_sites_total_bytes_limit_check CHECK (total_bytes <= 104857600),
				state TEXT NOT NULL DEFAULT 'ready' CONSTRAINT private_sites_state_check CHECK (state IN ('staging', 'ready', 'deleting')),
				staging_lease_token_hash TEXT,
				staging_lease_expires_at TIMESTAMPTZ,
				expires_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				CONSTRAINT private_sites_staging_lease_check CHECK (
					(state = 'staging' AND staging_lease_token_hash IS NOT NULL AND staging_lease_expires_at IS NOT NULL)
					OR (state <> 'staging' AND staging_lease_token_hash IS NULL AND staging_lease_expires_at IS NULL)
				)
			)
		`
	})

	await runMigration('create private_site_files', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS private_site_files (
				site_id TEXT NOT NULL REFERENCES private_sites(site_id) ON DELETE CASCADE,
				path TEXT NOT NULL,
				size BIGINT NOT NULL CONSTRAINT private_site_files_size_nonnegative_check CHECK (size >= 0) CONSTRAINT private_site_files_size_limit_check CHECK (size <= 104857600),
				mime_type TEXT,
				sha256 TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				PRIMARY KEY (site_id, path)
			)
		`
	})

	await runMigration('create private_site_shares', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS private_site_shares (
				share_id TEXT PRIMARY KEY,
				site_id TEXT NOT NULL REFERENCES private_sites(site_id) ON DELETE CASCADE,
				token_hash TEXT NOT NULL,
				token_prefix TEXT NOT NULL,
				label TEXT,
				expires_at TIMESTAMPTZ,
				revoked_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				last_used_at TIMESTAMPTZ,
				audience_did TEXT
			)
		`
	})

	await runMigration('create private_site_sessions', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS private_site_sessions (
				session_id TEXT PRIMARY KEY,
				secret_hash TEXT NOT NULL,
				site_id TEXT NOT NULL REFERENCES private_sites(site_id) ON DELETE CASCADE,
				kind TEXT NOT NULL,
				owner_did TEXT,
				share_id TEXT REFERENCES private_site_shares(share_id) ON DELETE CASCADE,
				expires_at TIMESTAMPTZ NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`
	})

	await runMigration('create private_site_handoffs', async () => {
		await getDb()`
			CREATE TABLE IF NOT EXISTS private_site_handoffs (
				handoff_id TEXT PRIMARY KEY,
				secret_hash TEXT NOT NULL,
				site_id TEXT NOT NULL REFERENCES private_sites(site_id) ON DELETE CASCADE,
				owner_did TEXT,
				share_id TEXT REFERENCES private_site_shares(share_id) ON DELETE CASCADE,
				expires_at TIMESTAMPTZ NOT NULL,
				consumed_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`
	})
}

const runWithPrimaryMigrationLock = async <T>(primaryDb: SQL, fn: (reservedDb: SQL) => Promise<T>): Promise<T> => {
	try {
		const reserved = await primaryDb.reserve()
		return await withReservedMigrationAdvisoryLock(
			{
				async setLockTimeout(): Promise<void> {
					await reserved`SET lock_timeout = '30s'`
				},
				async acquireLock(): Promise<void> {
					await reserved`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`
				},
				async resetLockTimeout(): Promise<void> {
					await reserved`SET lock_timeout = DEFAULT`
				},
				async unlock(): Promise<void> {
					const rows = await reserved<Array<{ unlocked: boolean }>>`
						SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY}) AS unlocked
					`
					if (!rows[0]?.unlocked) {
						throw new Error('Migration advisory lock was not held')
					}
				},
				release(): void {
					reserved.release()
				},
				close(): Promise<void> {
					return reserved.close({ timeout: 0 })
				},
			},
			async () => await fn(reserved),
			reportMigrationLockCleanupFailure,
		)
	} catch (error) {
		throw sanitizeMigrationStartupError('primary connection or advisory lock', error)
	}
}

export const runDatabaseMigrations = async (primaryDb: SQL): Promise<void> => {
	await runWithPrimaryMigrationLock(primaryDb, async (reservedDb) => {
		// The immutable migration bodies below are serial. Bind each existing tagged
		// SQL closure to its transaction while that one body is executing.
		let db = reservedDb
		const executor = await createSchemaMigrationExecutor(reservedDb)
		const runMigration: LocalMigrationRun = async (name, fn) =>
			await executor.run(name, async (transaction) => {
				const previousDb = db
				db = transaction
				try {
					return await fn()
				} finally {
					db = previousDb
				}
			})

		await bootstrapSchema(runMigration, () => db)

		// The restricted replica role cannot inspect pg_stat_wal_receiver directly.
		// This narrow definer function exposes only the non-sensitive fields the
		// health probe needs. Operations grants pg_read_all_stats to this trusted
		// migration-role owner and execute to the dedicated reader role after rollout.
		await runMigration('create replica receiver probe function', async () => {
			await db`
				CREATE OR REPLACE FUNCTION public.wisp_replica_receiver_status()
				RETURNS TABLE(receiver_streaming BOOLEAN, last_message_receipt_at TIMESTAMPTZ)
				LANGUAGE sql
				SECURITY DEFINER
				SET search_path = pg_catalog
				AS $function$
					SELECT status = 'streaming', last_msg_receipt_time
					FROM pg_catalog.pg_stat_wal_receiver
					LIMIT 1
				$function$
			`
			await db`REVOKE ALL ON FUNCTION public.wisp_replica_receiver_status() FROM PUBLIC`
		})

		// Add columns if they don't exist (for existing databases)
		await runMigration('add domains.rkey', async () => {
			await db`ALTER TABLE domains ADD COLUMN IF NOT EXISTS rkey TEXT`
		})

		await runMigration('add oauth_sessions.expires_at', async () => {
			await db`ALTER TABLE oauth_sessions ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) + 2592000`
		})

		await runMigration('add oauth_keys.created_at', async () => {
			await db`ALTER TABLE oauth_keys ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())`
		})

		await runMigration('add oauth_states.expires_at', async () => {
			await db`ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS expires_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) + 3600`
		})

		await runMigration('add service_identity_keys.updated_at', async () => {
			await db`ALTER TABLE service_identity_keys ADD COLUMN IF NOT EXISTS updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())`
		})

		await runMigration('add service_identity_keys.private_key_multibase', async () => {
			await db`ALTER TABLE service_identity_keys ADD COLUMN IF NOT EXISTS private_key_multibase TEXT`
		})

		// Existing rows are assumed already synced to S3 (firehose wrote them), so the
		// column defaults to true to avoid a thundering-herd re-download on rollout.
		// The on-demand path explicitly inserts cold_synced=false going forward.
		await runMigration('add site_cache.cold_synced', async () => {
			await db`ALTER TABLE site_cache ADD COLUMN IF NOT EXISTS cold_synced BOOLEAN NOT NULL DEFAULT true`
		})

		// Remove the unique constraint on domains.did to allow multiple domains per user
		await runMigration('drop legacy domains_did_key', async () => {
			await db`ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_did_key`
		})

		// Make custom_domains.rkey nullable and remove default
		await runMigration('custom_domains.rkey drop not null', async () => {
			await db`ALTER TABLE custom_domains ALTER COLUMN rkey DROP NOT NULL`
		})

		await runMigration('custom_domains.rkey drop default', async () => {
			await db`ALTER TABLE custom_domains ALTER COLUMN rkey DROP DEFAULT`
		})

		// Ensure existing domain mappings only point to owned cached sites before adding FK constraints.
		await runMigration('normalize invalid domains.rkey mappings', async () => {
			await db`
		            UPDATE domains d
		            SET rkey = NULL
		            WHERE rkey IS NOT NULL
		              AND NOT EXISTS (
		                  SELECT 1
		                  FROM site_cache s
		                  WHERE s.did = d.did
		                    AND s.rkey = d.rkey
		              )
		        `
		})

		await runMigration('normalize invalid custom_domains.rkey mappings', async () => {
			await db`
		            UPDATE custom_domains d
		            SET rkey = NULL
		            WHERE rkey IS NOT NULL
		              AND NOT EXISTS (
		                  SELECT 1
		                  FROM site_cache s
		                  WHERE s.did = d.did
		                    AND s.rkey = d.rkey
		              )
		        `
		})

		await runMigration('ensure unique custom_domains.domain', async () => {
			await db`CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_domains_domain_unique ON custom_domains(domain)`
		})

		// Mapped site rkeys must refer to an existing cached site owned by the same DID.
		await runMigration('drop legacy fk_domains_site_owner', async () => {
			await db`ALTER TABLE domains DROP CONSTRAINT IF EXISTS fk_domains_site_owner`
		})

		await runMigration('drop legacy fk_custom_domains_site_owner', async () => {
			await db`ALTER TABLE custom_domains DROP CONSTRAINT IF EXISTS fk_custom_domains_site_owner`
		})

		await runMigration('add fk_domains_site_owner', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'fk_domains_site_owner' AND conrelid = 'domains'::regclass
					) THEN
						ALTER TABLE domains
							ADD CONSTRAINT fk_domains_site_owner
							FOREIGN KEY (did, rkey)
							REFERENCES site_cache(did, rkey)
							ON UPDATE CASCADE
							ON DELETE SET NULL;
					END IF;
				END $$;
			`
		})

		await runMigration('add fk_custom_domains_site_owner', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'fk_custom_domains_site_owner' AND conrelid = 'custom_domains'::regclass
					) THEN
						ALTER TABLE custom_domains
							ADD CONSTRAINT fk_custom_domains_site_owner
							FOREIGN KEY (did, rkey)
							REFERENCES site_cache(did, rkey)
							ON UPDATE CASCADE
							ON DELETE SET NULL;
					END IF;
				END $$;
			`
		})

		// Owner-visible analytics are stored as aggregate counters only. The site
		// cache foreign key makes site deletion the lifecycle boundary for all rows.
		await runMigration('create site_analytics_hourly', async () => {
			await db`
					CREATE TABLE IF NOT EXISTS site_analytics_hourly (
						owner_did TEXT NOT NULL,
						site_rkey TEXT NOT NULL,
						bucket_start TIMESTAMPTZ NOT NULL,
						requests BIGINT NOT NULL DEFAULT 0 CHECK (requests >= 0),
						html_responses BIGINT NOT NULL DEFAULT 0 CHECK (html_responses >= 0),
						status_2xx BIGINT NOT NULL DEFAULT 0 CHECK (status_2xx >= 0),
						status_3xx BIGINT NOT NULL DEFAULT 0 CHECK (status_3xx >= 0),
						status_4xx BIGINT NOT NULL DEFAULT 0 CHECK (status_4xx >= 0),
						status_5xx BIGINT NOT NULL DEFAULT 0 CHECK (status_5xx >= 0),
						updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
						PRIMARY KEY (owner_did, site_rkey, bucket_start),
						CONSTRAINT fk_site_analytics_owner
							FOREIGN KEY (owner_did, site_rkey)
							REFERENCES site_cache(did, rkey)
							ON UPDATE CASCADE
							ON DELETE CASCADE
					)
				`
		})

		await runMigration('create analytics_ingest_batches', async () => {
			await db`
					CREATE TABLE IF NOT EXISTS analytics_ingest_batches (
						batch_id UUID PRIMARY KEY,
						instance_id TEXT NOT NULL,
						received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
					)
				`
		})

		// Private-site lifecycle rows from older deployments become ready before
		// the state constraint is introduced. These steps are ordered so every
		// existing row satisfies the final NOT NULL/CHECK invariants.
		await runMigration('add private_sites.state', async () => {
			await db`ALTER TABLE private_sites ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'ready'`
		})

		await runMigration('normalize private_sites.state', async () => {
			await db`
					UPDATE private_sites
					SET state = 'ready'
					WHERE state IS NULL OR state NOT IN ('staging', 'ready', 'deleting')
				`
		})

		await runMigration('set private_sites.state default', async () => {
			await db`ALTER TABLE private_sites ALTER COLUMN state SET DEFAULT 'ready'`
		})

		await runMigration('set private_sites.state not null', async () => {
			await db`ALTER TABLE private_sites ALTER COLUMN state SET NOT NULL`
		})

		await runMigration('add private_sites staging lease columns', async () => {
			await db`ALTER TABLE private_sites ADD COLUMN IF NOT EXISTS staging_lease_token_hash TEXT`
			await db`ALTER TABLE private_sites ADD COLUMN IF NOT EXISTS staging_lease_expires_at TIMESTAMPTZ`
		})

		// An older binary cannot renew these leases. Hide any such in-flight upload
		// before enforcing the invariant; the reaper will clean it safely.
		await runMigration('retire unleased private_sites staging rows', async () => {
			await db`
				UPDATE private_sites
				SET
					state = 'deleting',
					staging_lease_token_hash = NULL,
					staging_lease_expires_at = NULL,
					updated_at = NOW()
				WHERE state = 'staging'
			`
		})

		await runMigration('add private_sites_staging_lease_check', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'private_sites_staging_lease_check' AND conrelid = 'private_sites'::regclass
					) THEN
						ALTER TABLE private_sites
							ADD CONSTRAINT private_sites_staging_lease_check CHECK (
								(state = 'staging' AND staging_lease_token_hash IS NOT NULL AND staging_lease_expires_at IS NOT NULL)
								OR (state <> 'staging' AND staging_lease_token_hash IS NULL AND staging_lease_expires_at IS NULL)
							) NOT VALID;
					END IF;
				END $$;
			`
		})

		await runMigration('add private_sites_state_check', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'private_sites_state_check' AND conrelid = 'private_sites'::regclass
					) THEN
						ALTER TABLE private_sites
							ADD CONSTRAINT private_sites_state_check CHECK (state IN ('staging', 'ready', 'deleting'));
					END IF;
				END $$;
			`
		})

		await runMigration('normalize private_sites nonnegative counters', async () => {
			await db`
				UPDATE private_sites
				SET
					file_count = GREATEST(file_count, 0),
					total_bytes = GREATEST(total_bytes, 0)
				WHERE file_count < 0 OR total_bytes < 0
			`
		})

		await runMigration('normalize private_site_files.size', async () => {
			await db`UPDATE private_site_files SET size = 0 WHERE size < 0`
		})

		await runMigration('add private_sites_file_count_nonnegative_check', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'private_sites_file_count_nonnegative_check' AND conrelid = 'private_sites'::regclass
					) THEN
						ALTER TABLE private_sites
							ADD CONSTRAINT private_sites_file_count_nonnegative_check CHECK (file_count >= 0);
					END IF;
				END $$;
			`
		})

		await runMigration('add private_sites_total_bytes_nonnegative_check', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'private_sites_total_bytes_nonnegative_check' AND conrelid = 'private_sites'::regclass
					) THEN
						ALTER TABLE private_sites
							ADD CONSTRAINT private_sites_total_bytes_nonnegative_check CHECK (total_bytes >= 0);
					END IF;
				END $$;
			`
		})

		await runMigration('add private_site_files_size_nonnegative_check', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'private_site_files_size_nonnegative_check' AND conrelid = 'private_site_files'::regclass
					) THEN
						ALTER TABLE private_site_files
							ADD CONSTRAINT private_site_files_size_nonnegative_check CHECK (size >= 0);
					END IF;
				END $$;
			`
		})

		// Existing oversized rows remain readable. PostgreSQL enforces NOT VALID
		// checks for every new or changed row without scanning legacy data.
		await runMigration('add private_sites_file_count_limit_check', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'private_sites_file_count_limit_check' AND conrelid = 'private_sites'::regclass
					) THEN
						ALTER TABLE private_sites
							ADD CONSTRAINT private_sites_file_count_limit_check CHECK (file_count <= 500) NOT VALID;
					END IF;
				END $$;
			`
		})

		await runMigration('add private_sites_total_bytes_limit_check', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'private_sites_total_bytes_limit_check' AND conrelid = 'private_sites'::regclass
					) THEN
						ALTER TABLE private_sites
							ADD CONSTRAINT private_sites_total_bytes_limit_check CHECK (total_bytes <= 104857600) NOT VALID;
					END IF;
				END $$;
			`
		})

		await runMigration('add private_site_files_size_limit_check', async () => {
			await db`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_constraint
						WHERE conname = 'private_site_files_size_limit_check' AND conrelid = 'private_site_files'::regclass
					) THEN
						ALTER TABLE private_site_files
							ADD CONSTRAINT private_site_files_size_limit_check CHECK (size <= 104857600) NOT VALID;
					END IF;
				END $$;
			`
		})

		// Seed initial supporter DID
		await runMigration('seed initial supporter', async () => {
			await db`
		            INSERT INTO supporter (did)
		            VALUES ('did:plc:ttdrpj45ibqunmfhdsb4zdwq')
		            ON CONFLICT (did) DO NOTHING
		        `
		})

		const migrations: Array<[string, () => Promise<unknown>]> = [
			[
				'idx_oauth_states_expires_at',
				async () => db`CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at)`,
			],
			[
				'idx_oauth_sessions_expires_at',
				async () => db`CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires_at ON oauth_sessions(expires_at)`,
			],
			[
				'idx_oauth_keys_created_at',
				async () => db`CREATE INDEX IF NOT EXISTS idx_oauth_keys_created_at ON oauth_keys(created_at)`,
			],
			['idx_domains_did_rkey', async () => db`CREATE INDEX IF NOT EXISTS idx_domains_did_rkey ON domains(did, rkey)`],
			[
				'idx_custom_domains_did',
				async () => db`CREATE INDEX IF NOT EXISTS idx_custom_domains_did ON custom_domains(did)`,
			],
			[
				'idx_custom_domains_did_rkey',
				async () => db`CREATE INDEX IF NOT EXISTS idx_custom_domains_did_rkey ON custom_domains(did, rkey)`,
			],
			[
				'idx_custom_domains_verified',
				async () => db`CREATE INDEX IF NOT EXISTS idx_custom_domains_verified ON custom_domains(verified)`,
			],
			['idx_site_cache_did', async () => db`CREATE INDEX IF NOT EXISTS idx_site_cache_did ON site_cache(did)`],
			[
				'idx_site_cache_updated',
				async () => db`CREATE INDEX IF NOT EXISTS idx_site_cache_updated ON site_cache(updated_at)`,
			],
			[
				'idx_site_analytics_hourly_bucket_start',
				async () =>
					db`CREATE INDEX IF NOT EXISTS idx_site_analytics_hourly_bucket_start ON site_analytics_hourly(bucket_start)`,
			],
			[
				'idx_analytics_ingest_batches_received_at',
				async () =>
					db`CREATE INDEX IF NOT EXISTS idx_analytics_ingest_batches_received_at ON analytics_ingest_batches(received_at)`,
			],
			[
				'idx_private_sites_owner',
				async () => db`CREATE INDEX IF NOT EXISTS idx_private_sites_owner ON private_sites(owner_did)`,
			],
			[
				'idx_private_sites_expires_at',
				async () => db`CREATE INDEX IF NOT EXISTS idx_private_sites_expires_at ON private_sites(expires_at)`,
			],
			[
				'idx_private_sites_state_updated_at',
				async () =>
					db`CREATE INDEX IF NOT EXISTS idx_private_sites_state_updated_at ON private_sites(state, updated_at)`,
			],
			[
				'idx_private_sites_staging_lease_expires_at',
				async () =>
					db`CREATE INDEX IF NOT EXISTS idx_private_sites_staging_lease_expires_at ON private_sites(staging_lease_expires_at) WHERE state = 'staging'`,
			],
			[
				'private_site_shares.audience_did',
				async () => db`ALTER TABLE private_site_shares ADD COLUMN IF NOT EXISTS audience_did TEXT`,
			],
			[
				'idx_private_site_shares_site',
				async () => db`CREATE INDEX IF NOT EXISTS idx_private_site_shares_site ON private_site_shares(site_id)`,
			],
			[
				'idx_private_site_shares_token_hash',
				async () =>
					db`CREATE INDEX IF NOT EXISTS idx_private_site_shares_token_hash ON private_site_shares(token_hash)`,
			],
			[
				'idx_private_site_shares_token_hash_unique',
				async () =>
					db`CREATE UNIQUE INDEX IF NOT EXISTS idx_private_site_shares_token_hash_unique ON private_site_shares(token_hash)`,
			],
			[
				'idx_private_sessions_secret',
				async () => db`CREATE INDEX IF NOT EXISTS idx_private_sessions_secret ON private_site_sessions(secret_hash)`,
			],
			[
				'idx_private_sessions_expires',
				async () => db`CREATE INDEX IF NOT EXISTS idx_private_sessions_expires ON private_site_sessions(expires_at)`,
			],
			[
				'private_site_handoffs.owner_did nullable',
				async () => db`ALTER TABLE private_site_handoffs ALTER COLUMN owner_did DROP NOT NULL`,
			],
			[
				'private_site_handoffs.share_id',
				async () =>
					db`ALTER TABLE private_site_handoffs ADD COLUMN IF NOT EXISTS share_id TEXT REFERENCES private_site_shares(share_id) ON DELETE CASCADE`,
			],
			[
				'idx_private_handoffs_secret',
				async () => db`CREATE INDEX IF NOT EXISTS idx_private_handoffs_secret ON private_site_handoffs(secret_hash)`,
			],
		]
		for (const [name, run] of migrations) {
			await runMigration(name, run)
		}
	})
}
