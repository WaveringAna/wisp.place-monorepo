import type { SQL } from 'bun'

const hasAlreadyExists = (err: unknown): boolean => {
	const message = err instanceof Error ? err.message : String(err)
	return message.includes('already exists')
}

const runMigration = async (
	name: string,
	fn: () => Promise<unknown>,
	options?: { ignoreAlreadyExists?: boolean; silent?: boolean },
) => {
	try {
		await fn()
	} catch (err) {
		if (options?.ignoreAlreadyExists && hasAlreadyExists(err)) {
			return
		}
		if (!options?.silent) {
			console.error(`[DB Migration] ${name} failed:`, err)
		}
	}
}

export const runDatabaseMigrations = async (db: SQL): Promise<void> => {
	// Add columns if they don't exist (for existing databases)
	await runMigration(
		'add domains.rkey',
		async () => {
			await db`ALTER TABLE domains ADD COLUMN IF NOT EXISTS rkey TEXT`
		},
		{ silent: true },
	)

	await runMigration(
		'add oauth_sessions.expires_at',
		async () => {
			await db`ALTER TABLE oauth_sessions ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) + 2592000`
		},
		{ silent: true },
	)

	await runMigration(
		'add oauth_keys.created_at',
		async () => {
			await db`ALTER TABLE oauth_keys ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())`
		},
		{ silent: true },
	)

	await runMigration(
		'add oauth_states.expires_at',
		async () => {
			await db`ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS expires_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) + 3600`
		},
		{ silent: true },
	)

	await runMigration(
		'add service_identity_keys.updated_at',
		async () => {
			await db`ALTER TABLE service_identity_keys ADD COLUMN IF NOT EXISTS updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())`
		},
		{ silent: true },
	)

	await runMigration(
		'add service_identity_keys.private_key_multibase',
		async () => {
			await db`ALTER TABLE service_identity_keys ADD COLUMN IF NOT EXISTS private_key_multibase TEXT`
		},
		{ silent: true },
	)

	// Existing rows are assumed already synced to S3 (firehose wrote them), so the
	// column defaults to true to avoid a thundering-herd re-download on rollout.
	// The on-demand path explicitly inserts cold_synced=false going forward.
	await runMigration(
		'add site_cache.cold_synced',
		async () => {
			await db`ALTER TABLE site_cache ADD COLUMN IF NOT EXISTS cold_synced BOOLEAN NOT NULL DEFAULT true`
		},
		{ silent: true },
	)

	// Remove the unique constraint on domains.did to allow multiple domains per user
	await runMigration(
		'drop legacy domains_did_key',
		async () => {
			await db`ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_did_key`
		},
		{ silent: true },
	)

	// Make custom_domains.rkey nullable and remove default
	await runMigration(
		'custom_domains.rkey drop not null',
		async () => {
			await db`ALTER TABLE custom_domains ALTER COLUMN rkey DROP NOT NULL`
		},
		{ silent: true },
	)

	await runMigration(
		'custom_domains.rkey drop default',
		async () => {
			await db`ALTER TABLE custom_domains ALTER COLUMN rkey DROP DEFAULT`
		},
		{ silent: true },
	)

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

	await runMigration(
		'ensure unique custom_domains.domain',
		async () => {
			await db`CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_domains_domain_unique ON custom_domains(domain)`
		},
		{ silent: true },
	)

	// Mapped site rkeys must refer to an existing cached site owned by the same DID.
	await runMigration(
		'drop legacy fk_domains_site_owner',
		async () => {
			await db`ALTER TABLE domains DROP CONSTRAINT IF EXISTS fk_domains_site_owner`
		},
		{ silent: true },
	)

	await runMigration(
		'drop legacy fk_custom_domains_site_owner',
		async () => {
			await db`ALTER TABLE custom_domains DROP CONSTRAINT IF EXISTS fk_custom_domains_site_owner`
		},
		{ silent: true },
	)

	await runMigration(
		'add fk_domains_site_owner',
		async () => {
			await db`
            ALTER TABLE domains
            ADD CONSTRAINT fk_domains_site_owner
            FOREIGN KEY (did, rkey)
            REFERENCES site_cache(did, rkey)
            ON UPDATE CASCADE
            ON DELETE SET NULL
        `
		},
		{ ignoreAlreadyExists: true },
	)

	await runMigration(
		'add fk_custom_domains_site_owner',
		async () => {
			await db`
            ALTER TABLE custom_domains
            ADD CONSTRAINT fk_custom_domains_site_owner
            FOREIGN KEY (did, rkey)
            REFERENCES site_cache(did, rkey)
            ON UPDATE CASCADE
            ON DELETE SET NULL
        `
		},
		{ ignoreAlreadyExists: true },
	)

	// Seed initial supporter DID
	await runMigration('seed initial supporter', async () => {
		await db`
            INSERT INTO supporter (did)
            VALUES ('did:plc:ttdrpj45ibqunmfhdsb4zdwq')
            ON CONFLICT (did) DO NOTHING
        `
	})

	// Create indexes for common query patterns
	await Promise.all([
		db`CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_oauth_states_expires_at:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires_at ON oauth_sessions(expires_at)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_oauth_sessions_expires_at:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_oauth_keys_created_at ON oauth_keys(created_at)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_oauth_keys_created_at:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_domains_did_rkey ON domains(did, rkey)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_domains_did_rkey:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_custom_domains_did ON custom_domains(did)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_custom_domains_did:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_custom_domains_did_rkey ON custom_domains(did, rkey)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_custom_domains_did_rkey:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_custom_domains_verified ON custom_domains(verified)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_custom_domains_verified:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_site_cache_did ON site_cache(did)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_site_cache_did:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_site_cache_updated ON site_cache(updated_at)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_site_cache_updated:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_private_sites_owner ON private_sites(owner_did)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_private_sites_owner:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_private_sites_expires_at ON private_sites(expires_at)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_private_sites_expires_at:', err)
			}
		}),
		db`CREATE INDEX IF NOT EXISTS idx_private_site_shares_site ON private_site_shares(site_id)`.catch((err) => {
			if (!hasAlreadyExists(err)) {
				console.error('Failed to create idx_private_site_shares_site:', err)
			}
		}),
		// Share lookup is by token hash on every request to a shared private site.
		db`CREATE INDEX IF NOT EXISTS idx_private_site_shares_token_hash ON private_site_shares(token_hash)`.catch(
			(err) => {
				if (!hasAlreadyExists(err)) {
					console.error('Failed to create idx_private_site_shares_token_hash:', err)
				}
			},
		),
	])
}
