/**
 * Database access for private sites.
 *
 * Kept in its own module rather than added to `db.ts` so the private-site tables have a
 * clear ownership boundary, and so a v2 migration to permissioned data can replace this
 * layer without touching public-site queries.
 *
 * Authorization is NOT performed here. These functions load state; the decision is made by
 * `evaluateAccess` in `@wispplace/private-sites`.
 */

import { generateShareToken, generateSiteId, type PrivateSite, type PrivateSiteShare } from '@wispplace/private-sites'
import { db } from './db'

interface PrivateSiteRow {
	site_id: string
	owner_did: string
	name: string
	file_count: number
	total_bytes: string | number
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
	expires_at: string | Date | null
	revoked_at: string | Date | null
	created_at: string | Date
	last_used_at: string | Date | null
}

const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value))
const toDateOrNull = (value: string | Date | null): Date | null => (value === null ? null : toDate(value))

const mapSite = (row: PrivateSiteRow): PrivateSite => ({
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

/** Insert a private site and its file metadata. Returns the generated site id. */
export const createPrivateSite = async (input: CreatePrivateSiteInput): Promise<PrivateSite> => {
	const siteId = generateSiteId()
	const totalBytes = input.files.reduce((sum, f) => sum + f.size, 0)

	const rows = await db<PrivateSiteRow[]>`
        INSERT INTO private_sites (site_id, owner_did, name, file_count, total_bytes, expires_at)
        VALUES (${siteId}, ${input.ownerDid}, ${input.name}, ${input.files.length}, ${totalBytes}, ${input.expiresAt})
        RETURNING *
    `

	for (const file of input.files) {
		await db`
            INSERT INTO private_site_files (site_id, path, size, mime_type, sha256)
            VALUES (${siteId}, ${file.path}, ${file.size}, ${file.mimeType}, ${file.sha256})
            ON CONFLICT (site_id, path) DO UPDATE
            SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type, sha256 = EXCLUDED.sha256
        `
	}

	return mapSite(rows[0]!)
}

export const getPrivateSite = async (siteId: string): Promise<PrivateSite | null> => {
	const rows = await db<PrivateSiteRow[]>`SELECT * FROM private_sites WHERE site_id = ${siteId}`
	return rows[0] ? mapSite(rows[0]) : null
}

export const listPrivateSitesByOwner = async (ownerDid: string): Promise<PrivateSite[]> => {
	const rows = await db<PrivateSiteRow[]>`
        SELECT * FROM private_sites WHERE owner_did = ${ownerDid} ORDER BY created_at DESC
    `
	return rows.map(mapSite)
}

export const listPrivateSiteFiles = async (
	siteId: string,
): Promise<Array<{ path: string; size: number; mimeType: string | null; sha256: string }>> => {
	const rows = await db<Array<{ path: string; size: string | number; mime_type: string | null; sha256: string }>>`
        SELECT path, size, mime_type, sha256 FROM private_site_files WHERE site_id = ${siteId} ORDER BY path ASC
    `
	return rows.map((r) => ({ path: r.path, size: Number(r.size), mimeType: r.mime_type, sha256: r.sha256 }))
}

/** Delete a private site. Files and shares cascade. Returns true when a row was removed. */
export const deletePrivateSite = async (siteId: string): Promise<boolean> => {
	const rows = await db`DELETE FROM private_sites WHERE site_id = ${siteId} RETURNING site_id`
	return rows.length > 0
}

/** All shares for a site, including revoked and expired ones. */
export const listShares = async (siteId: string): Promise<PrivateSiteShare[]> => {
	const rows = await db<PrivateShareRow[]>`
        SELECT * FROM private_site_shares WHERE site_id = ${siteId} ORDER BY created_at DESC
    `
	return rows.map(mapShare)
}

/**
 * Look up candidate shares for a presented token hash.
 *
 * Filtering by hash in SQL keeps the working set small; the authoritative comparison still
 * happens in `evaluateAccess` using a timing-safe check.
 */
export const findSharesByTokenHash = async (siteId: string, tokenHash: string): Promise<PrivateSiteShare[]> => {
	const rows = await db<PrivateShareRow[]>`
        SELECT * FROM private_site_shares WHERE site_id = ${siteId} AND token_hash = ${tokenHash}
    `
	return rows.map(mapShare)
}

export interface CreateShareResult {
	share: PrivateSiteShare
	/** Plaintext token. Surface to the creator once; never store or log it. */
	token: string
}

export const createShare = async (
	siteId: string,
	options: { label?: string | null; expiresAt: Date | null },
): Promise<CreateShareResult> => {
	const { token, tokenHash, tokenPrefix } = generateShareToken()
	const shareId = generateSiteId()

	const rows = await db<PrivateShareRow[]>`
        INSERT INTO private_site_shares (share_id, site_id, token_hash, token_prefix, label, expires_at)
        VALUES (${shareId}, ${siteId}, ${tokenHash}, ${tokenPrefix}, ${options.label ?? null}, ${options.expiresAt})
        RETURNING *
    `

	return { share: mapShare(rows[0]!), token }
}

/** Mark a share revoked. Idempotent: an already-revoked share keeps its original timestamp. */
export const revokeShare = async (siteId: string, shareId: string): Promise<boolean> => {
	const rows = await db`
        UPDATE private_site_shares
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE site_id = ${siteId} AND share_id = ${shareId}
        RETURNING share_id
    `
	return rows.length > 0
}

/** Best-effort last-used timestamp for share auditing. Never records the token itself. */
export const touchShare = async (shareId: string): Promise<void> => {
	try {
		await db`UPDATE private_site_shares SET last_used_at = NOW() WHERE share_id = ${shareId}`
	} catch {
		// Auditing must never fail a request that has already been authorized.
	}
}

/** Private sites whose expiry has passed, for cleanup. */
export const listExpiredPrivateSites = async (limit = 100): Promise<PrivateSite[]> => {
	const rows = await db<PrivateSiteRow[]>`
        SELECT * FROM private_sites
        WHERE expires_at IS NOT NULL AND expires_at <= NOW()
        ORDER BY expires_at ASC
        LIMIT ${limit}
    `
	return rows.map(mapSite)
}
