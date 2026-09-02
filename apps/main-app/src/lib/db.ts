import {
	decryptWebhookSecret,
	encryptWebhookSecret,
	isValidWebhookSecretId,
	parseWebhookSecretEncryptionKeyring,
	type WebhookSecretEncryptionKeyring,
} from '@wispplace/atproto-utils'
import { DELETED_SITE_RECORD_CID } from '@wispplace/constants'
import { SQL } from 'bun'
import { probeConnectionWithRetry, resolveConnectionWarmingIntervalMs } from './connection-warming'
import { resolveDatabaseConfiguration } from './database-config'
import { createDatabaseReadCircuit, type DatabaseReadProbeResult } from './database-read-circuit'
import { assessDatabaseReadReplication } from './database-read-replication'
import { isValidHandle, toDomain } from './domain-utils'
import { runDatabaseMigrations } from './migrations'
import { withReservedOAuthLock } from './oauth-lock'
import { createPresentationReadQueries } from './presentation-reads'
import { waitForSiteCacheProjection } from './site-cache-wait'
import { migrateWebhookSecretEnvelopes } from './webhook-secret-encryption'

export { isValidHandle, toDomain } from './domain-utils'

/**
 * The primary database client. This remains the backward-compatible strong-
 * consistency client for every write and any read that affects security,
 * authorization, or a mutation decision.
 */
export const databaseConfiguration = resolveDatabaseConfiguration(process.env)

const createPoolOptions = (pool: typeof databaseConfiguration.primaryPool) => ({
	max: pool.max,
	idleTimeout: pool.idleTimeoutSeconds,
	connectionTimeout: pool.connectionTimeoutSeconds,
	maxLifetime: 300,
})

export const db = new SQL(databaseConfiguration.primaryUrl, createPoolOptions(databaseConfiguration.primaryPool))

/**
 * How many primary connections are held open between requests.
 *
 * Two, because the widest fan-out on the primary in one request is the pair of
 * lookups at the end of the OAuth callback. A third concurrent query still
 * connects on demand; it just is not on the common path.
 * See {@link probeConnectionWithRetry} for why this is worth doing at all.
 */
const WARM_PRIMARY_CONNECTIONS = 2

/**
 * Hold connections open so a request never pays for establishing one.
 *
 * The probes run concurrently on purpose: one at a time would keep re-using a
 * single pooled connection and leave the rest to lapse.
 */
export const warmPrimaryConnections = async (): Promise<void> => {
	await Promise.all(
		Array.from({ length: WARM_PRIMARY_CONNECTIONS }, () => probeConnectionWithRetry(() => db`SELECT 1`)),
	)
}

export const connectionWarmingIntervalMs = resolveConnectionWarmingIntervalMs(
	databaseConfiguration.primaryPool.idleTimeoutSeconds,
)

// Do not create another pool unless the operator explicitly configured a
// different endpoint. The raw replica client stays private so call sites must
// opt into the named eventualRead repository below.
const replicaReadDb = databaseConfiguration.hasSeparateReadPool
	? new SQL(databaseConfiguration.readUrl, {
			...createPoolOptions(databaseConfiguration.readPool),
			connection: {
				statement_timeout: databaseConfiguration.readQueryTimeoutMs,
			},
		})
	: undefined

/** True when presentation-only reads have a separately configured pool. */
export const hasSeparateDatabaseReadPool = databaseConfiguration.hasSeparateReadPool

type ReadEndpointProbeRow = {
	transaction_read_only: boolean | string
	sensitive_data_restricted: boolean | string
	write_privileges_restricted: boolean | string
	in_recovery: boolean | string
	received_lsn: string | null
	replayed_lsn: string | null
	last_replay_at_ms: number | string | null
	receiver_streaming: boolean | string | null
	receiver_last_message_receipt_at_ms: number | string | null
	observed_at_ms: number | string
}

const asBoolean = (value: boolean | string): boolean => value === true || value === 'true' || value === 't'
const asFiniteNumberOrNull = (value: number | string | null): number | null => {
	if (value === null) return null
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : null
}

const probeReadEndpoint = async (): Promise<DatabaseReadProbeResult> => {
	if (!replicaReadDb) throw new Error('No configured database read endpoint')

	const query = replicaReadDb<ReadEndpointProbeRow[]>`
		SELECT
			(current_setting('transaction_read_only', true) = 'on') AS transaction_read_only,
			NOT EXISTS (
				SELECT 1
				FROM pg_catalog.pg_class relation
				JOIN pg_catalog.pg_namespace schema ON schema.oid = relation.relnamespace
				WHERE schema.nspname = 'public'
					AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
					AND relation.relname NOT IN ('domains', 'custom_domains', 'site_cache', 'supporter')
					AND (
						has_table_privilege(current_user, relation.oid, 'SELECT')
						OR has_any_column_privilege(current_user, relation.oid, 'SELECT')
					)
			) AS sensitive_data_restricted,
			NOT EXISTS (
				SELECT 1
				FROM pg_catalog.pg_class relation
				JOIN pg_catalog.pg_namespace schema ON schema.oid = relation.relnamespace
				WHERE schema.nspname = 'public'
					AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
					AND (
						has_table_privilege(current_user, relation.oid, 'INSERT')
						OR has_table_privilege(current_user, relation.oid, 'UPDATE')
						OR has_table_privilege(current_user, relation.oid, 'DELETE')
						OR has_table_privilege(current_user, relation.oid, 'TRUNCATE')
						OR has_table_privilege(current_user, relation.oid, 'REFERENCES')
						OR has_table_privilege(current_user, relation.oid, 'TRIGGER')
						OR has_any_column_privilege(current_user, relation.oid, 'INSERT')
						OR has_any_column_privilege(current_user, relation.oid, 'UPDATE')
					)
			) AS write_privileges_restricted,
			pg_is_in_recovery() AS in_recovery,
			pg_last_wal_receive_lsn()::TEXT AS received_lsn,
			pg_last_wal_replay_lsn()::TEXT AS replayed_lsn,
			EXTRACT(EPOCH FROM pg_last_xact_replay_timestamp()) * 1000 AS last_replay_at_ms,
			receiver.receiver_streaming AS receiver_streaming,
			EXTRACT(EPOCH FROM receiver.last_message_receipt_at) * 1000 AS receiver_last_message_receipt_at_ms,
			EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS observed_at_ms
		FROM (SELECT 1) AS probe
		LEFT JOIN LATERAL public.wisp_replica_receiver_status() AS receiver ON true
	`
	let timeout: ReturnType<typeof setTimeout> | undefined
	const timeoutResult = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			try {
				query.cancel()
			} catch {
				// The circuit only needs the bounded timeout; never expose a driver error.
			}
			reject(new Error('Database read endpoint probe timed out'))
		}, databaseConfiguration.readProbeTimeoutMs)
	})

	try {
		const rows = await Promise.race([query, timeoutResult])
		const row = rows[0]
		if (!row) throw new Error('Database read endpoint probe returned no rows')

		const inRecovery = asBoolean(row.in_recovery)
		const replication = assessDatabaseReadReplication(
			{
				inRecovery,
				receivedLsn: row.received_lsn,
				replayedLsn: row.replayed_lsn,
				lastReplayAtMs: asFiniteNumberOrNull(row.last_replay_at_ms),
				receiverStreaming: row.receiver_streaming === null ? false : asBoolean(row.receiver_streaming),
				receiverLastMessageReceiptAtMs: asFiniteNumberOrNull(row.receiver_last_message_receipt_at_ms),
			},
			asFiniteNumberOrNull(row.observed_at_ms) ?? Date.now(),
			databaseConfiguration.readReceiverFreshnessMs,
		)
		return {
			transactionReadOnly: asBoolean(row.transaction_read_only),
			sensitiveDataRestricted: asBoolean(row.sensitive_data_restricted),
			writePrivilegesRestricted: asBoolean(row.write_privileges_restricted),
			inRecovery,
			replicationReceiverHealthy: replication.replicationReceiverHealthy,
			replayLagMs: replication.replayLagMs,
		}
	} finally {
		if (timeout) clearTimeout(timeout)
	}
}

const databaseReadCircuit = createDatabaseReadCircuit({
	configured: hasSeparateDatabaseReadPool,
	maxReplayLagMs: databaseConfiguration.readMaxReplayLagMs,
	probeIntervalMs: databaseConfiguration.readProbeIntervalMs,
	cooldownMs: databaseConfiguration.readCircuitCooldownMs,
	probe: probeReadEndpoint,
})

// Bootstrap DDL and every following migration run under the primary advisory lock.
await runDatabaseMigrations(db)

export interface WebhookSecretEncryptionHealth {
	readonly status: 'ready' | 'degraded'
	readonly encryptionAvailable: boolean
	readonly legacySecretsRemaining: number | null
}

const getConfiguredWebhookSecretKeyring = (): WebhookSecretEncryptionKeyring =>
	parseWebhookSecretEncryptionKeyring({
		WEBHOOK_SECRET_ENCRYPTION_KEY: process.env.WEBHOOK_SECRET_ENCRYPTION_KEY,
		WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS: process.env.WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS,
	})

// There is intentionally no development plaintext fallback. Developers who use
// server-managed signing secrets must configure the same encryption key setup.
let webhookSecretEncryptionHealth: WebhookSecretEncryptionHealth = {
	status: 'degraded',
	encryptionAvailable: false,
	legacySecretsRemaining: null,
}
const startupWebhookSecretKeyring = (() => {
	try {
		return getConfiguredWebhookSecretKeyring()
	} catch {
		return null
	}
})()

try {
	const migration = await migrateWebhookSecretEnvelopes(db, startupWebhookSecretKeyring)
	webhookSecretEncryptionHealth = {
		status: migration.legacyRemaining === 0 ? 'ready' : 'degraded',
		encryptionAvailable: migration.encryptionAvailable,
		legacySecretsRemaining: migration.legacyRemaining,
	}
} catch {
	// Do not log the error. Driver errors and bad configuration can include values
	// which must not reach process logs. The health endpoint exposes only this state.
	webhookSecretEncryptionHealth = {
		status: 'degraded',
		encryptionAvailable: startupWebhookSecretKeyring !== null,
		legacySecretsRemaining: null,
	}
}

export const getWebhookSecretEncryptionHealth = (): WebhookSecretEncryptionHealth => ({
	...webhookSecretEncryptionHealth,
})

const startupReadHealth = await databaseReadCircuit.probeNow()
if (
	databaseConfiguration.requiresProductionSafety &&
	hasSeparateDatabaseReadPool &&
	(startupReadHealth.mode === 'writable' || startupReadHealth.mode === 'unsafe')
) {
	throw new Error(
		'DATABASE_READ_URL must use a restricted role with default_transaction_read_only=on outside development and test',
	)
}

const primaryPresentationRead = createPresentationReadQueries(db)
const replicaPresentationRead = replicaReadDb ? createPresentationReadQueries(replicaReadDb) : undefined

const withEventualPresentationRead = async <T>(
	operation: (queries: typeof primaryPresentationRead) => Promise<T>,
): Promise<T> => {
	const replicaQueries = replicaPresentationRead
	if (!replicaQueries) return await operation(primaryPresentationRead)
	return await databaseReadCircuit.withRead(
		async () => await operation(replicaQueries),
		async () => await operation(primaryPresentationRead),
	)
}

/**
 * Explicitly eventual, presentation-only reads. A healthy separate read pool is
 * used only after its probe confirms a read-only session and acceptable replay
 * lag. The circuit falls back to primary on probe or query failures. Never use
 * this facade for authentication, authorization, ownership, tokens, cache waits,
 * private data, or mutations.
 */
export const eventualRead = {
	getUserStatus: async (did: string) => await withEventualPresentationRead((queries) => queries.getUserStatus(did)),
	getSupporterStatus: async (did: string) => await withEventualPresentationRead((queries) => queries.isSupporter(did)),
	getSitesForDid: async (did: string) => await withEventualPresentationRead((queries) => queries.getSitesByDid(did)),
	getSitesWithDomainsForDid: async (did: string) =>
		await withEventualPresentationRead((queries) => queries.getSitesWithDomainsByDid(did)),
	getDomainsForDid: async (did: string) =>
		await withEventualPresentationRead((queries) => queries.getDomainsForDid(did)),
	getDomainsForSite: async (did: string, rkey: string) =>
		await withEventualPresentationRead((queries) => queries.getDomainsBySite(did, rkey)),
	getDomainStatus: async (domain: string) =>
		await withEventualPresentationRead((queries) => queries.getDomainStatus(domain)),
	getAdminSites: async (limit: number, offset: number) =>
		await withEventualPresentationRead((queries) => queries.getAdminSites(limit, offset)),
	getAdminSupporters: async () => await withEventualPresentationRead((queries) => queries.getAllSupporters()),
}

/** Sanitized read-endpoint health; this never includes a connection URL. */
export const getDatabaseReadHealth = async () => await databaseReadCircuit.health()

export const pruneAnalyticsData = async (): Promise<void> => {
	await Promise.all([
		db`DELETE FROM site_analytics_hourly WHERE bucket_start < NOW() - INTERVAL '90 days'`,
		db`DELETE FROM analytics_ingest_batches WHERE received_at < NOW() - INTERVAL '7 days'`,
	])
}

// These shared helpers intentionally keep their historic strong/primary semantics.
export const getDomainByDid = primaryPresentationRead.getDomainByDid
// Includes cache/configuration metadata that the replica role cannot access.
export const getAdminDatabaseReport = primaryPresentationRead.getAdminDatabaseReport
// Delivery history can contain operator-controlled URLs; keep it on primary.
export const getWebhookEventHistory = primaryPresentationRead.getWebhookEventHistory

export const getAllWispDomains = primaryPresentationRead.getAllWispDomains
export const countWispDomains = primaryPresentationRead.countWispDomains

export const isDomainAvailable = async (handle: string): Promise<boolean> => {
	const h = handle.trim().toLowerCase()
	if (!isValidHandle(h)) return false
	const domain = toDomain(h)
	const rows = await db`SELECT 1 FROM domains WHERE domain = ${domain} LIMIT 1`
	return rows.length === 0
}

export const isDomainRegistered = primaryPresentationRead.isDomainRegistered

export const claimDomain = async (did: string, handle: string): Promise<string> => {
	const h = handle.trim().toLowerCase()
	if (!isValidHandle(h)) throw new Error('invalid_handle')

	// Check if user already has 3 domains (unless they're a supporter)
	const supporter = await isSupporter(did)
	if (!supporter) {
		const existingCount = await countWispDomains(did)
		if (existingCount >= 3) {
			throw new Error('domain_limit_reached')
		}
	}

	const domain = toDomain(h)
	try {
		await db`
            INSERT INTO domains (domain, did)
            VALUES (${domain}, ${did})
        `
	} catch (_err) {
		// Unique constraint violations -> already taken
		throw new Error('conflict')
	}
	return domain
}

export const updateDomain = async (did: string, handle: string): Promise<string> => {
	const h = handle.trim().toLowerCase()
	if (!isValidHandle(h)) throw new Error('invalid_handle')
	const domain = toDomain(h)
	try {
		const rows = await db`
            UPDATE domains SET domain = ${domain}
            WHERE did = ${did}
            RETURNING domain
        `
		if (rows.length > 0) return rows[0].domain as string
		// No existing row, behave like claim
		return await claimDomain(did, handle)
	} catch (_err) {
		// Unique constraint violations -> already taken by someone else
		throw new Error('conflict')
	}
}

export const updateWispDomainSite = async (domain: string, siteRkey: string | null): Promise<void> => {
	await db`
        UPDATE domains
        SET rkey = ${siteRkey}
        WHERE domain = ${domain}
    `
}

export const deleteWispDomain = async (domain: string): Promise<void> => {
	await db`DELETE FROM domains WHERE domain = ${domain}`
}

export const getCustomDomainsByDid = primaryPresentationRead.getCustomDomainsByDid

export const getCustomDomainInfo = primaryPresentationRead.getCustomDomainInfo

export const getCustomDomainByHash = async (hash: string) => {
	const rows = await db`SELECT * FROM custom_domains WHERE id = ${hash}`
	return rows[0] ?? null
}

export const getCustomDomainById = async (id: string) => {
	const rows = await db`SELECT * FROM custom_domains WHERE id = ${id}`
	return rows[0] ?? null
}

export const claimCustomDomain = async (did: string, domain: string, hash: string, rkey: string | null = null) => {
	const domainLower = domain.toLowerCase()
	try {
		const result = await db`
            INSERT INTO custom_domains (id, domain, did, rkey, verified, created_at)
            VALUES (${hash}, ${domainLower}, ${did}, ${rkey}, false, EXTRACT(EPOCH FROM NOW()))
            ON CONFLICT (domain) DO UPDATE SET
                id = EXCLUDED.id,
                did = EXCLUDED.did,
                rkey = EXCLUDED.rkey,
                verified = EXCLUDED.verified,
                created_at = EXCLUDED.created_at
            WHERE custom_domains.verified = false
            RETURNING *
        `

		if (result.length === 0) {
			console.log('Failed to claim custom domain - already verified by another user')
			throw new Error('conflict')
		}

		return { success: true, hash }
	} catch (err) {
		console.error('Failed to claim custom domain', err)
		throw new Error('conflict')
	}
}

export const updateCustomDomainRkey = async (id: string, rkey: string | null) => {
	const rows = await db`
        UPDATE custom_domains
        SET rkey = ${rkey}
        WHERE id = ${id}
        RETURNING *
    `
	return rows[0] ?? null
}

export const updateCustomDomainVerification = async (id: string, verified: boolean) => {
	const rows = await db`
        UPDATE custom_domains
        SET verified = ${verified}, last_verified_at = EXTRACT(EPOCH FROM NOW())
        WHERE id = ${id}
        RETURNING *
    `
	return rows[0] ?? null
}

export const deleteCustomDomain = async (id: string) => {
	await db`DELETE FROM custom_domains WHERE id = ${id}`
}

export const getSitesByDid = primaryPresentationRead.getSitesByDid

export const waitForSiteCache = async (did: string, rkey: string): Promise<boolean> =>
	waitForSiteCacheProjection(async () => {
		const rows = await db`
			SELECT 1 FROM site_cache
			WHERE did = ${did} AND rkey = ${rkey} AND record_cid <> ${DELETED_SITE_RECORD_CID}
			LIMIT 1
		`
		return rows.length > 0
	})

// Get all domains (wisp + custom) mapped to a specific site
export const getDomainsBySite = primaryPresentationRead.getDomainsBySite

// Get count of domains mapped to a specific site
export const getDomainCountBySite = primaryPresentationRead.getDomainCountBySite

// Cookie secret management - ensure we have a secret for signing cookies
export const getCookieSecret = async (): Promise<string> => {
	// Check if secret already exists
	const rows = await db`SELECT secret FROM cookie_secrets WHERE id = 'default' LIMIT 1`

	if (rows.length > 0) {
		return rows[0].secret as string
	}

	// Generate new secret if none exists
	const secret = crypto.randomUUID() + crypto.randomUUID() // 72 character random string
	await db`
        INSERT INTO cookie_secrets (id, secret, created_at)
        VALUES ('default', ${secret}, EXTRACT(EPOCH FROM NOW()))
    `

	console.log('[CookieSecret] Generated new cookie signing secret')
	return secret
}

export const getServiceIdentityKeypair = async (): Promise<{
	publicKeyMultibase: string
	privateKeyMultibase: string | null
} | null> => {
	const rows = await db`
        SELECT public_key_multibase, private_key_multibase
        FROM service_identity_keys
        WHERE id = 'default'
        LIMIT 1
    `

	if (rows.length === 0) {
		return null
	}

	return {
		publicKeyMultibase: rows[0].public_key_multibase as string,
		privateKeyMultibase: (rows[0].private_key_multibase as string | undefined) ?? null,
	}
}

export const setServiceIdentityKeypair = async (
	publicKeyMultibase: string,
	privateKeyMultibase: string | null,
): Promise<void> => {
	await db`
        INSERT INTO service_identity_keys (id, public_key_multibase, private_key_multibase, created_at, updated_at)
        VALUES ('default', ${publicKeyMultibase}, ${privateKeyMultibase}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
        ON CONFLICT (id)
        DO UPDATE SET
            public_key_multibase = EXCLUDED.public_key_multibase,
            private_key_multibase = EXCLUDED.private_key_multibase,
            updated_at = EXTRACT(EPOCH FROM NOW())
    `
}

// Supporter management functions
export const isSupporter = primaryPresentationRead.isSupporter

export const addSupporter = async (did: string): Promise<void> => {
	await db`
        INSERT INTO supporter (did)
        VALUES (${did})
        ON CONFLICT (did) DO NOTHING
    `
}

export const removeSupporter = async (did: string): Promise<void> => {
	await db`DELETE FROM supporter WHERE did = ${did}`
}

export const getAllSupporters = primaryPresentationRead.getAllSupporters

function generateSecretToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24))
	return `wsk_${Buffer.from(bytes).toString('base64url')}`
}

/**
 * Parse on every secret operation so a controlled process restart/env reload
 * never leaves a stale active key in memory. This throws only the stable,
 * non-secret encryption-unavailable error on missing or malformed config.
 */
const requireWebhookSecretKeyring = (): WebhookSecretEncryptionKeyring => getConfiguredWebhookSecretKeyring()

const WEBHOOK_SECRET_STORAGE_ERROR = 'webhook_secret_storage_unavailable'
const WEBHOOK_SECRET_ID_ERROR = 'invalid_webhook_secret_id'
const assertValidWebhookSecretId = (name: string): void => {
	if (!isValidWebhookSecretId(name)) throw new Error(WEBHOOK_SECRET_ID_ERROR)
}
const isUniqueConstraintViolation = (error: unknown): boolean =>
	typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505'

export const createWebhookSecret = async (did: string, name: string): Promise<{ token: string; createdAt: string }> => {
	assertValidWebhookSecretId(name)
	const keyring = requireWebhookSecretKeyring()
	const token = generateSecretToken()
	const envelope = encryptWebhookSecret(token, keyring)

	try {
		const rows = await db`
            INSERT INTO webhook_secrets (did, name, token, created_at)
            VALUES (${did}, ${name}, ${envelope}, NOW())
            RETURNING created_at
        `
		return { token, createdAt: new Date(rows[0].created_at).toISOString() }
	} catch (error) {
		// Do not attach the driver error: it can contain query parameter values.
		if (isUniqueConstraintViolation(error)) throw new Error('already_exists')
		throw new Error(WEBHOOK_SECRET_STORAGE_ERROR)
	}
}

export const listWebhookSecrets = async (
	did: string,
): Promise<Array<{ name: string; createdAt: string; lastRotatedAt?: string }>> => {
	const rows = await db<Array<{ name: string; created_at: string; last_rotated_at: string | null }>>`
        SELECT name, created_at, last_rotated_at
        FROM webhook_secrets
        WHERE did = ${did}
        ORDER BY created_at ASC
    `
	return rows.map((r) => ({
		name: r.name,
		createdAt: new Date(r.created_at).toISOString(),
		lastRotatedAt: r.last_rotated_at ? new Date(r.last_rotated_at).toISOString() : undefined,
	}))
}

export const deleteWebhookSecret = async (did: string, name: string): Promise<boolean> => {
	assertValidWebhookSecretId(name)
	const rows = await db`
        DELETE FROM webhook_secrets WHERE did = ${did} AND name = ${name} RETURNING name
    `
	return rows.length > 0
}

export const rotateWebhookSecret = async (
	did: string,
	name: string,
): Promise<{ token: string; rotatedAt: string } | null> => {
	assertValidWebhookSecretId(name)
	const keyring = requireWebhookSecretKeyring()
	const token = generateSecretToken()
	const envelope = encryptWebhookSecret(token, keyring)
	const rows = await db`
        UPDATE webhook_secrets
        SET token = ${envelope}, last_rotated_at = NOW()
        WHERE did = ${did} AND name = ${name}
        RETURNING last_rotated_at
    `
	if (rows.length === 0) return null
	return { token, rotatedAt: new Date(rows[0].last_rotated_at).toISOString() }
}

/**
 * Internal delivery-only lookup. A found value must be a valid encrypted
 * envelope. Plaintext legacy values, malformed records, and unavailable keys
 * all fail closed with the same retryable generic error.
 */
export const getWebhookSecretToken = async (did: string, name: string): Promise<string | null> => {
	assertValidWebhookSecretId(name)
	const rows = await db<Array<{ token: string }>>`
        SELECT token FROM webhook_secrets WHERE did = ${did} AND name = ${name} LIMIT 1
    `
	const envelope = rows[0]?.token
	if (envelope === undefined) return null
	return decryptWebhookSecret(envelope, requireWebhookSecretKeyring())
}

type WebhookMutationAction = 'create' | 'delete'

const WEBHOOK_MUTATION_WINDOW_MS = 60_000
const WEBHOOK_MUTATION_MAX_PER_WINDOW = 10

/**
 * Atomically consume one per-DID mutation slot. The backing table is created by
 * the normal primary migration; failure to reach it is handled as a generic
 * route failure, never a permissive rate-limit bypass.
 */
export const consumeWebhookMutationRateLimit = async (
	did: string,
	action: WebhookMutationAction,
	now = Date.now(),
): Promise<boolean> => {
	const windowStart = now - WEBHOOK_MUTATION_WINDOW_MS
	const rows = await db<Array<{ mutation_count: number }>>`
		INSERT INTO webhook_mutation_rate_limits (did, action, window_started_at, mutation_count)
		VALUES (${did}, ${action}, ${now}, 1)
		ON CONFLICT (did, action) DO UPDATE
		SET
			window_started_at = CASE
				WHEN webhook_mutation_rate_limits.window_started_at <= ${windowStart} THEN ${now}
				ELSE webhook_mutation_rate_limits.window_started_at
			END,
			mutation_count = CASE
				WHEN webhook_mutation_rate_limits.window_started_at <= ${windowStart} THEN 1
				ELSE webhook_mutation_rate_limits.mutation_count + 1
			END
		WHERE webhook_mutation_rate_limits.window_started_at <= ${windowStart}
			OR webhook_mutation_rate_limits.mutation_count < ${WEBHOOK_MUTATION_MAX_PER_WINDOW}
		RETURNING mutation_count
	`
	return rows.length === 1
}

/**
 * Serialize main-app PDS webhook mutations per owner across regions. The PDS
 * has no multi-record transaction, so this is best-effort only for writes
 * through this API; firehose intake remains the final enforcement point.
 */
export const withWebhookOwnerMutationLock = async <T>(did: string, operation: () => Promise<T>): Promise<T> => {
	let reserved: Awaited<ReturnType<typeof db.reserve>>
	try {
		reserved = await db.reserve()
	} catch {
		throw new Error('webhook_mutation_unavailable')
	}

	const lockName = `wisp-webhook-owner:${did}`
	return await withReservedOAuthLock(
		{
			async acquire(): Promise<void> {
				// Do not alter a pooled session setting around a long PDS request.
				// A busy owner fails closed and the authenticated caller can retry.
				const rows = await reserved<Array<{ locked: boolean }>>`
					SELECT pg_try_advisory_lock(hashtextextended(${lockName}, 0)) AS locked
				`
				if (!rows[0]?.locked) throw new Error('webhook_mutation_unavailable')
			},
			async unlock(): Promise<void> {
				const rows = await reserved<Array<{ unlocked: boolean }>>`
					SELECT pg_advisory_unlock(hashtextextended(${lockName}, 0)) AS unlocked
				`
				if (!rows[0]?.unlocked) throw new Error('webhook_mutation_unavailable')
			},
			release(): void {
				reserved.release()
			},
			async close(): Promise<void> {
				await reserved.close({ timeout: 0 })
			},
		},
		operation,
		() => {
			// Static only: a cleanup failure must not expose a DID, endpoint, or secret.
			console.error('[Webhook] Owner mutation lock cleanup failed')
		},
	)
}

const closeDatabasePool = async (name: 'primary' | 'read', pool: typeof db): Promise<void> => {
	try {
		await pool.end()
		console.log(`[DB] ${name} database connection closed`)
	} catch {
		// Do not include driver errors here; they can include a connection URL.
		console.error(`[DB] Error closing ${name} database connection`)
	}
}

let databaseClosePromise: Promise<void> | undefined

/**
 * Close the primary pool and, when configured, the separate eventual-read pool.
 * Repeated shutdown signals share this promise so a pool is never ended twice.
 */
export const closeDatabase = (): Promise<void> => {
	databaseClosePromise ??= Promise.all([
		closeDatabasePool('primary', db),
		...(replicaReadDb ? [closeDatabasePool('read', replicaReadDb)] : []),
	]).then(() => undefined)

	return databaseClosePromise
}
