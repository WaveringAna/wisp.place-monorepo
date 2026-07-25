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

import {
	generateHandoffSecret,
	generateRecordId,
	generateShareToken,
	generateSiteId,
	OWNER_HANDOFF_TTL_SECONDS,
	type PrivateSite,
	type PrivateSiteShare,
} from '@wispplace/private-sites'
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
	audience_did?: string | null
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

/** How many readable ids to try before giving up on a collision. */
const SITE_ID_ATTEMPTS = 5

/**
 * Insert a private site and its file metadata. Returns the generated site id.
 *
 * Readable ids come from a smaller space than random ones, so a taken name is retried
 * rather than surfacing as a primary-key error. `ON CONFLICT DO NOTHING` makes the
 * database the arbiter, which is race-free where a pre-check would not be.
 */
export const createPrivateSite = async (input: CreatePrivateSiteInput): Promise<PrivateSite> => {
	const totalBytes = input.files.reduce((sum, f) => sum + f.size, 0)

	let rows: PrivateSiteRow[] = []
	let siteId = ''
	for (let attempt = 0; attempt < SITE_ID_ATTEMPTS && rows.length === 0; attempt += 1) {
		siteId = generateSiteId()
		rows = await db<PrivateSiteRow[]>`
            INSERT INTO private_sites (site_id, owner_did, name, file_count, total_bytes, expires_at)
            VALUES (${siteId}, ${input.ownerDid}, ${input.name}, ${input.files.length}, ${totalBytes}, ${input.expiresAt})
            ON CONFLICT (site_id) DO NOTHING
            RETURNING *
        `
	}
	if (rows.length === 0) {
		throw new Error('could not allocate a private site id')
	}

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

/**
 * Resolve a share token to the site it belongs to, for the `/p/<token>` short link.
 *
 * Looks up by token hash across all sites, since the short link carries only the token.
 * Returns the site id without making an access decision — the private origin re-evaluates
 * the token on arrival and answers with its uniform 404 if it no longer grants anything.
 */
export const findSiteIdByShareTokenHash = async (tokenHash: string): Promise<string | null> => {
	const rows = await db<Array<{ site_id: string }>>`
        SELECT site_id FROM private_site_shares WHERE token_hash = ${tokenHash} LIMIT 1
    `
	return rows[0]?.site_id ?? null
}

export interface CreateShareResult {
	share: PrivateSiteShare
	/** Plaintext token. Surface to the creator once; never store or log it. */
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
        VALUES (${shareId}, ${siteId}, ${tokenHash}, ${tokenPrefix}, ${options.label ?? null}, ${options.expiresAt}, ${options.audienceDid ?? null})
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

/**
 * Mint a single-use, short-lived token that hands an authenticated owner over to their
 * site's own origin.
 *
 * The owner's account session lives on main-app's host and is deliberately not readable by
 * the private site origins, so ownership is proven once here and exchanged there for a
 * site-scoped session.
 */
export const createOwnerHandoff = async (siteId: string, ownerDid: string): Promise<string> => {
	const secret = generateHandoffSecret()
	const expiresAt = new Date(Date.now() + OWNER_HANDOFF_TTL_SECONDS * 1000)

	await db`
        INSERT INTO private_site_handoffs (handoff_id, secret_hash, site_id, owner_did, expires_at)
        VALUES (${generateRecordId()}, ${secret.hash}, ${siteId}, ${ownerDid}, ${expiresAt})
    `

	return secret.value
}

/**
 * Mint a single-use handoff that carries a *share* grant over to the site's own origin.
 *
 * Used by the identity bounce: a DID-scoped share needs to know who the viewer is, but the
 * private origins deliberately cannot read the account cookie. The visitor is sent to
 * main-app, proves their identity there, and returns with this single-use credential
 * instead of the long-lived share token — so that token never enters a browser history
 * entry, a referrer, or a server log.
 */
export const createShareHandoff = async (siteId: string, shareId: string): Promise<string> => {
	const secret = generateHandoffSecret()
	const expiresAt = new Date(Date.now() + OWNER_HANDOFF_TTL_SECONDS * 1000)

	await db`
        INSERT INTO private_site_handoffs (handoff_id, secret_hash, site_id, share_id, expires_at)
        VALUES (${generateRecordId()}, ${secret.hash}, ${siteId}, ${shareId}, ${expiresAt})
    `

	return secret.value
}

/** Remove consumed and expired handoff tokens. */
export const pruneHandoffs = async (): Promise<void> => {
	await db`DELETE FROM private_site_handoffs WHERE expires_at < NOW() OR consumed_at IS NOT NULL`
}
