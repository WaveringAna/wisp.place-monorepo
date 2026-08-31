import { randomBytes } from 'node:crypto'
import { MAX_PRIVATE_SITE_FILE_COUNT, MAX_PRIVATE_SITE_SIZE } from '@wispplace/constants'
import { normalizeSitePath } from '@wispplace/fs-utils'
import {
	generateHandoffSecret,
	generateRecordId,
	generateShareToken,
	generateSiteId,
	hashSecret,
	OWNER_HANDOFF_TTL_SECONDS,
	type PrivateSite,
	type PrivateSiteShare,
	type PrivateSiteState,
} from '@wispplace/private-sites'
import { db } from './db'
import { PRIVATE_SITE_STAGING_LEASE_MS } from './private-site-lifecycle'

interface PrivateSiteRow {
	site_id: string
	owner_did: string
	name: string
	file_count: number
	total_bytes: string | number
	state: PrivateSiteState
	staging_lease_token_hash?: string | null
	staging_lease_expires_at?: string | Date | null
	expires_at: string | Date | null
	created_at: string | Date
	updated_at: string | Date
}

interface PrivateShareRow {
	share_id: string
	site_id: string
	token_hash: string
	token_prefix: string
	label: string | null
	audience_did?: string | null
	expires_at: string | Date | null
	revoked_at: string | Date | null
	created_at: string | Date
	last_used_at: string | Date | null
}

const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value))
const toDateOrNull = (value: string | Date | null): Date | null => (value === null ? null : toDate(value))

const mapSite = (row: PrivateSiteRow): PrivateSite => ({
	state: row.state,
	siteId: row.site_id,
	ownerDid: row.owner_did,
	name: row.name,
	fileCount: Number(row.file_count),
	totalBytes: Number(row.total_bytes),
	expiresAt: toDateOrNull(row.expires_at),
	createdAt: toDate(row.created_at),
	updatedAt: toDate(row.updated_at),
})

const mapShare = (row: PrivateShareRow): PrivateSiteShare => ({
	shareId: row.share_id,
	siteId: row.site_id,
	tokenHash: row.token_hash,
	tokenPrefix: row.token_prefix,
	label: row.label,
	audienceDid: row.audience_did ?? null,
	expiresAt: toDateOrNull(row.expires_at),
	revokedAt: toDateOrNull(row.revoked_at),
	createdAt: toDate(row.created_at),
	lastUsedAt: toDateOrNull(row.last_used_at),
})

export interface CreatePrivateSiteInput {
	ownerDid: string
	name: string
	expiresAt: Date | null
	files: Array<{ path: string; size: number; mimeType: string | null; sha256: string }>
}

/** The opaque lease is held only by the uploader, never exposed to readers. */
export interface StagedPrivateSite {
	site: PrivateSite
	leaseToken: string
}

const SITE_ID_ATTEMPTS = 5
const MAX_REAPER_BATCH_SIZE = 1_000

/** A write raced a lifecycle transition, so callers must not expose a partial site. */
export class PrivateSiteUnavailableError extends Error {
	constructor() {
		super('private site is not available')
		this.name = 'PrivateSiteUnavailableError'
	}
}

interface BulkPrivateFileColumns {
	paths: string[]
	sizes: number[]
	mimeTypes: string[]
	mimeIsNull: boolean[]
	sha256s: string[]
}

interface ValidatedPrivateSiteInput {
	totalBytes: number
	files: BulkPrivateFileColumns
}

const createStagingLease = (): { token: string; tokenHash: string } => {
	const token = randomBytes(32).toString('base64url')
	return { token, tokenHash: hashSecret(token) }
}

const isSafeMimeType = (value: string): boolean =>
	value.length > 0 && value.length <= 255 && /^[\x20-\x7E]+$/.test(value)

/**
 * Build equally sized, explicitly typed arrays for one UNNEST statement.
 * Bun serializes null array members as the literal string `null`, so null MIME
 * values travel in a separate boolean array and are restored in SQL.
 */
const validateCreateInput = (input: CreatePrivateSiteInput): ValidatedPrivateSiteInput => {
	if (input.files.length === 0 || input.files.length > MAX_PRIVATE_SITE_FILE_COUNT) {
		throw new Error('invalid private site file count')
	}

	const files: BulkPrivateFileColumns = {
		paths: [],
		sizes: [],
		mimeTypes: [],
		mimeIsNull: [],
		sha256s: [],
	}
	const paths = new Set<string>()
	let totalBytes = 0
	for (const file of input.files) {
		if (
			typeof file.path !== 'string' ||
			!file.path ||
			normalizeSitePath(file.path) !== file.path ||
			paths.has(file.path) ||
			!Number.isSafeInteger(file.size) ||
			file.size < 0 ||
			(typeof file.mimeType !== 'string' && file.mimeType !== null) ||
			(file.mimeType !== null && !isSafeMimeType(file.mimeType)) ||
			typeof file.sha256 !== 'string' ||
			!/^[a-f0-9]{64}$/i.test(file.sha256)
		) {
			throw new Error('invalid private site file metadata')
		}
		paths.add(file.path)
		totalBytes += file.size
		if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PRIVATE_SITE_SIZE) {
			throw new Error('invalid private site total size')
		}

		files.paths.push(file.path)
		files.sizes.push(file.size)
		files.mimeTypes.push(file.mimeType ?? '')
		files.mimeIsNull.push(file.mimeType === null)
		files.sha256s.push(file.sha256)
	}

	if (
		files.paths.length !== input.files.length ||
		files.sizes.length !== input.files.length ||
		files.mimeTypes.length !== input.files.length ||
		files.mimeIsNull.length !== input.files.length ||
		files.sha256s.length !== input.files.length
	) {
		throw new Error('invalid private site file metadata')
	}

	return { totalBytes, files }
}

/**
 * Creates the metadata in one transaction, but deliberately leaves it hidden.
 * Storage is written only after this transaction commits; callers must call
 * markPrivateSiteReady once every object is durable.
 */
export const createPrivateSite = async (input: CreatePrivateSiteInput): Promise<StagedPrivateSite> => {
	const { totalBytes, files } = validateCreateInput(input)
	const lease = createStagingLease()

	for (let attempt = 0; attempt < SITE_ID_ATTEMPTS; attempt += 1) {
		const siteId = generateSiteId()
		const row = await db.begin(async (tx) => {
			const rows = await tx<PrivateSiteRow[]>`
				INSERT INTO private_sites (
					site_id, owner_did, name, file_count, total_bytes, state,
					staging_lease_token_hash, staging_lease_expires_at, expires_at
				)
				VALUES (
					${siteId}, ${input.ownerDid}, ${input.name}, ${input.files.length}, ${totalBytes}, 'staging',
					${lease.tokenHash}, NOW() + (${PRIVATE_SITE_STAGING_LEASE_MS} * INTERVAL '1 millisecond'), ${input.expiresAt}
				)
				ON CONFLICT (site_id) DO NOTHING
				RETURNING *
			`
			if (!rows[0]) return null

			await tx`
				INSERT INTO private_site_files (site_id, path, size, mime_type, sha256)
				SELECT
					${siteId}::TEXT,
					file_row.path::TEXT,
					file_row.size::BIGINT,
					CASE WHEN file_row.mime_is_null::BOOLEAN THEN NULL ELSE file_row.mime_type::TEXT END,
					file_row.sha256::TEXT
				FROM UNNEST(
					${tx.array(files.paths, 'TEXT')}::TEXT[],
					${tx.array(files.sizes, 'BIGINT')}::BIGINT[],
					${tx.array(files.mimeTypes, 'TEXT')}::TEXT[],
					${tx.array(files.mimeIsNull, 'BOOL')}::BOOLEAN[],
					${tx.array(files.sha256s, 'TEXT')}::TEXT[]
				) AS file_row(path, size, mime_type, mime_is_null, sha256)
			`
			return rows[0]
		})

		if (row) return { site: mapSite(row), leaseToken: lease.token }
	}

	throw new Error('could not allocate a private site id')
}

/** Renew before every bounded object write. An expired or reaped lease cannot revive staging. */
export const renewPrivateSiteStagingLease = async (siteId: string, leaseToken: string): Promise<boolean> => {
	const rows = await db`
		UPDATE private_sites
		SET
			staging_lease_expires_at = NOW() + (${PRIVATE_SITE_STAGING_LEASE_MS} * INTERVAL '1 millisecond'),
			updated_at = NOW()
		WHERE site_id = ${siteId}
		  AND state = 'staging'
		  AND staging_lease_token_hash = ${hashSecret(leaseToken)}
		  AND staging_lease_expires_at > NOW()
		RETURNING site_id
	`
	return rows.length > 0
}

/** Publish a fully written site. An expired or reaped staging site can never be revived. */
export const markPrivateSiteReady = async (siteId: string, leaseToken: string): Promise<PrivateSite | null> => {
	const rows = await db<PrivateSiteRow[]>`
		UPDATE private_sites
		SET
			state = 'ready',
			staging_lease_token_hash = NULL,
			staging_lease_expires_at = NULL,
			updated_at = NOW()
		WHERE site_id = ${siteId}
		  AND state = 'staging'
		  AND staging_lease_token_hash = ${hashSecret(leaseToken)}
		  AND staging_lease_expires_at > NOW()
		  AND (expires_at IS NULL OR expires_at > NOW())
		RETURNING *
	`
	return rows[0] ? mapSite(rows[0]) : null
}

/**
 * Hide a failed upload before touching storage. Returning false means another
 * actor already owns cleanup (or a successful ready transition is ambiguous),
 * so the caller must leave storage alone.
 */
export const abandonStagedPrivateSite = async (siteId: string, leaseToken: string): Promise<boolean> => {
	const rows = await db`
		UPDATE private_sites
		SET
			state = 'deleting',
			staging_lease_token_hash = NULL,
			staging_lease_expires_at = NULL,
			updated_at = NOW()
		WHERE site_id = ${siteId}
		  AND state = 'staging'
		  AND staging_lease_token_hash = ${hashSecret(leaseToken)}
		RETURNING site_id
	`
	return rows.length > 0
}

/** Ready sites are owner-visible; staging and deleting rows are deliberately hidden. */
export const getPrivateSite = async (siteId: string): Promise<PrivateSite | null> => {
	const rows = await db<PrivateSiteRow[]>`
		SELECT * FROM private_sites WHERE site_id = ${siteId} AND state = 'ready'
	`
	return rows[0] ? mapSite(rows[0]) : null
}

/** Strong, security-sensitive lookup used when minting a credential. */
export const getLivePrivateSite = async (siteId: string): Promise<PrivateSite | null> => {
	const rows = await db<PrivateSiteRow[]>`
		SELECT *
		FROM private_sites
		WHERE site_id = ${siteId}
		  AND state = 'ready'
		  AND (expires_at IS NULL OR expires_at > NOW())
		LIMIT 1
	`
	return rows[0] ? mapSite(rows[0]) : null
}

/**
 * Primary-only TLS/domain predicate. Do not route this through an eventual
 * read pool: a lifecycle transition or expiry must take effect immediately.
 */
export const hasLivePrivateSite = async (siteId: string): Promise<boolean> => {
	const rows = await db`
		SELECT 1
		FROM private_sites
		WHERE site_id = ${siteId}
		  AND state = 'ready'
		  AND (expires_at IS NULL OR expires_at > NOW())
		LIMIT 1
	`
	return rows.length > 0
}

export const listPrivateSitesByOwner = async (ownerDid: string): Promise<PrivateSite[]> => {
	const rows = await db<PrivateSiteRow[]>`
		SELECT *
		FROM private_sites
		WHERE owner_did = ${ownerDid} AND state = 'ready'
		ORDER BY created_at DESC
	`
	return rows.map(mapSite)
}

export interface PrivateSiteDeletionClaim {
	site: PrivateSite
	/** True only for the request which changed ready -> deleting and owns cleanup. */
	claimed: boolean
}

/**
 * The durable deletion barrier. Storage must not be removed until this update
 * commits, otherwise a crash can leave an apparently live site with no files.
 */
export const claimPrivateSiteDeletionForOwner = async (
	siteId: string,
	ownerDid: string,
): Promise<PrivateSiteDeletionClaim | null> => {
	const claimed = await db<PrivateSiteRow[]>`
		UPDATE private_sites
		SET
			state = 'deleting',
			staging_lease_token_hash = NULL,
			staging_lease_expires_at = NULL,
			updated_at = NOW()
		WHERE site_id = ${siteId} AND owner_did = ${ownerDid} AND state = 'ready'
		RETURNING *
	`
	if (claimed[0]) return { site: mapSite(claimed[0]), claimed: true }

	// A lost response or a retry after a storage failure must not start a second
	// cleanup worker. The reaper owns retries once the durable state is deleting.
	const deleting = await db<PrivateSiteRow[]>`
		SELECT *
		FROM private_sites
		WHERE site_id = ${siteId} AND owner_did = ${ownerDid} AND state = 'deleting'
		LIMIT 1
	`
	return deleting[0] ? { site: mapSite(deleting[0]), claimed: false } : null
}

/** Final deletion is intentionally impossible until a row is hidden first. */
export const finalizePrivateSiteDeletion = async (siteId: string): Promise<boolean> => {
	const rows = await db`
		DELETE FROM private_sites WHERE site_id = ${siteId} AND state = 'deleting' RETURNING site_id
	`
	return rows.length > 0
}

/** @deprecated Use finalizePrivateSiteDeletion after claiming the deletion barrier. */
export const deletePrivateSite = finalizePrivateSiteDeletion

const reaperLimit = (limit: number): number => {
	if (!Number.isFinite(limit)) return 1
	return Math.max(1, Math.min(MAX_REAPER_BATCH_SIZE, Math.floor(limit)))
}

const reaperAge = (value: number): number => {
	if (!Number.isFinite(value)) return 0
	return Math.max(0, Math.floor(value))
}

/**
 * Atomically claims expired ready sites and stale hidden work. SKIP LOCKED
 * makes independent main regions cooperate without a global process lock.
 * `updated_at` is a short lease for deleting work; a crashed worker is retried
 * only after `staleAfterMs`.
 */
export const claimPrivateSitesForReaping = async (
	limit = 100,
	staleAfterMs = 15 * 60 * 1_000,
): Promise<PrivateSite[]> => {
	const boundedLimit = reaperLimit(limit)
	const boundedAge = reaperAge(staleAfterMs)
	const rows = await db<PrivateSiteRow[]>`
		WITH candidates AS (
			SELECT site_id
			FROM private_sites
			WHERE
				(state = 'ready' AND expires_at IS NOT NULL AND expires_at <= NOW())
				OR (
					state = 'staging'
					AND (staging_lease_expires_at IS NULL OR staging_lease_expires_at <= NOW())
				)
				OR (
					state = 'deleting'
					AND updated_at <= NOW() - (${boundedAge} * INTERVAL '1 millisecond')
				)
			ORDER BY CASE state WHEN 'ready' THEN 0 ELSE 1 END, updated_at ASC
			FOR UPDATE SKIP LOCKED
			LIMIT ${boundedLimit}
		)
		UPDATE private_sites AS site
		SET
			state = 'deleting',
			staging_lease_token_hash = NULL,
			staging_lease_expires_at = NULL,
			updated_at = NOW()
		FROM candidates
		WHERE site.site_id = candidates.site_id
		RETURNING site.*
	`
	return rows.map(mapSite)
}

/** Retained for callers that only need a ready/expired listing; reapers must claim instead. */
export const listExpiredPrivateSites = async (limit = 100): Promise<PrivateSite[]> => {
	const rows = await db<PrivateSiteRow[]>`
		SELECT *
		FROM private_sites
		WHERE state = 'ready' AND expires_at IS NOT NULL AND expires_at <= NOW()
		ORDER BY expires_at ASC
		LIMIT ${reaperLimit(limit)}
	`
	return rows.map(mapSite)
}

export const listShares = async (siteId: string): Promise<PrivateSiteShare[]> => {
	const rows = await db<PrivateShareRow[]>`
		SELECT share.*
		FROM private_site_shares AS share
		JOIN private_sites AS site ON site.site_id = share.site_id
		WHERE share.site_id = ${siteId} AND site.state = 'ready'
		ORDER BY share.created_at DESC
	`
	return rows.map(mapShare)
}

/** Only returns shares that can be used to mint a grant right now. */
export const findSharesByTokenHash = async (siteId: string, tokenHash: string): Promise<PrivateSiteShare[]> => {
	const rows = await db<PrivateShareRow[]>`
		SELECT share.*
		FROM private_site_shares AS share
		JOIN private_sites AS site ON site.site_id = share.site_id
		WHERE share.site_id = ${siteId}
		  AND share.token_hash = ${tokenHash}
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		  AND share.revoked_at IS NULL
		  AND (share.expires_at IS NULL OR share.expires_at > NOW())
	`
	return rows.map(mapShare)
}

export const findLiveShareForAudience = async (
	siteId: string,
	audienceDid: string,
): Promise<PrivateSiteShare | null> => {
	const rows = await db<PrivateShareRow[]>`
		SELECT share.*
		FROM private_site_shares AS share
		JOIN private_sites AS site ON site.site_id = share.site_id
		WHERE share.site_id = ${siteId}
		  AND share.audience_did = ${audienceDid}
		  AND share.revoked_at IS NULL
		  AND (share.expires_at IS NULL OR share.expires_at > NOW())
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		ORDER BY share.created_at DESC
		LIMIT 1
	`
	return rows[0] ? mapShare(rows[0]) : null
}

export const findSiteIdByShareTokenHash = async (tokenHash: string): Promise<string | null> => {
	const rows = await db<Array<{ site_id: string }>>`
		SELECT share.site_id
		FROM private_site_shares AS share
		JOIN private_sites AS site ON site.site_id = share.site_id
		WHERE share.token_hash = ${tokenHash}
		  AND share.revoked_at IS NULL
		  AND (share.expires_at IS NULL OR share.expires_at > NOW())
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		LIMIT 1
	`
	return rows[0]?.site_id ?? null
}

export interface CreateShareResult {
	share: PrivateSiteShare
	token: string
}

export const createShare = async (
	siteId: string,
	options: { label?: string | null; expiresAt: Date | null; audienceDid?: string | null },
): Promise<CreateShareResult> => {
	const { token, tokenHash, tokenPrefix } = generateShareToken()
	const shareId = generateRecordId()

	const rows = await db<PrivateShareRow[]>`
		INSERT INTO private_site_shares (share_id, site_id, token_hash, token_prefix, label, expires_at, audience_did)
		SELECT ${shareId}, site.site_id, ${tokenHash}, ${tokenPrefix}, ${options.label ?? null}, ${options.expiresAt}, ${options.audienceDid ?? null}
		FROM private_sites AS site
		WHERE site.site_id = ${siteId}
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		RETURNING *
	`
	if (!rows[0]) throw new PrivateSiteUnavailableError()
	return { share: mapShare(rows[0]), token }
}

export const revokeShare = async (siteId: string, shareId: string): Promise<boolean> => {
	const rows = await db`
		UPDATE private_site_shares AS share
		SET revoked_at = COALESCE(share.revoked_at, NOW())
		FROM private_sites AS site
		WHERE share.site_id = ${siteId}
		  AND share.share_id = ${shareId}
		  AND site.site_id = share.site_id
		  AND site.state = 'ready'
		RETURNING share.share_id
	`
	return rows.length > 0
}

export const touchShare = async (shareId: string): Promise<void> => {
	try {
		await db`UPDATE private_site_shares SET last_used_at = NOW() WHERE share_id = ${shareId}`
	} catch {}
}

export const createOwnerHandoff = async (siteId: string, ownerDid: string): Promise<string | null> => {
	const secret = generateHandoffSecret()
	const expiresAt = new Date(Date.now() + OWNER_HANDOFF_TTL_SECONDS * 1000)
	const rows = await db`
		INSERT INTO private_site_handoffs (handoff_id, secret_hash, site_id, owner_did, expires_at)
		SELECT ${generateRecordId()}, ${secret.hash}, site.site_id, ${ownerDid}, ${expiresAt}
		FROM private_sites AS site
		WHERE site.site_id = ${siteId}
		  AND site.owner_did = ${ownerDid}
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		RETURNING handoff_id
	`
	return rows.length > 0 ? secret.value : null
}

export const createShareHandoff = async (siteId: string, shareId: string): Promise<string | null> => {
	const secret = generateHandoffSecret()
	const expiresAt = new Date(Date.now() + OWNER_HANDOFF_TTL_SECONDS * 1000)
	const rows = await db`
		INSERT INTO private_site_handoffs (handoff_id, secret_hash, site_id, share_id, expires_at)
		SELECT ${generateRecordId()}, ${secret.hash}, site.site_id, share.share_id, ${expiresAt}
		FROM private_sites AS site
		JOIN private_site_shares AS share ON share.site_id = site.site_id
		WHERE site.site_id = ${siteId}
		  AND share.share_id = ${shareId}
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		  AND share.revoked_at IS NULL
		  AND (share.expires_at IS NULL OR share.expires_at > NOW())
		RETURNING handoff_id
	`
	return rows.length > 0 ? secret.value : null
}

export const pruneHandoffs = async (): Promise<void> => {
	await db`DELETE FROM private_site_handoffs WHERE expires_at < NOW() OR consumed_at IS NOT NULL`
}

export const pruneSessions = async (): Promise<void> => {
	await db`DELETE FROM private_site_sessions WHERE expires_at < NOW()`
}
