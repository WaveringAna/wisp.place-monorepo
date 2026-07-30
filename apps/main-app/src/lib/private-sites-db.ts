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
const SITE_ID_ATTEMPTS = 5
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

export const deletePrivateSite = async (siteId: string): Promise<boolean> => {
	const rows = await db`DELETE FROM private_sites WHERE site_id = ${siteId} RETURNING site_id`
	return rows.length > 0
}
export const listShares = async (siteId: string): Promise<PrivateSiteShare[]> => {
	const rows = await db<PrivateShareRow[]>`
        SELECT * FROM private_site_shares WHERE site_id = ${siteId} ORDER BY created_at DESC
    `
	return rows.map(mapShare)
}
export const findSharesByTokenHash = async (siteId: string, tokenHash: string): Promise<PrivateSiteShare[]> => {
	const rows = await db<PrivateShareRow[]>`
        SELECT * FROM private_site_shares WHERE site_id = ${siteId} AND token_hash = ${tokenHash}
    `
	return rows.map(mapShare)
}
export const findLiveShareForAudience = async (
	siteId: string,
	audienceDid: string,
): Promise<PrivateSiteShare | null> => {
	const rows = await db<PrivateShareRow[]>`
        SELECT * FROM private_site_shares
        WHERE site_id = ${siteId}
          AND audience_did = ${audienceDid}
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY created_at DESC
        LIMIT 1
    `
	return rows[0] ? mapShare(rows[0]) : null
}
export const findSiteIdByShareTokenHash = async (tokenHash: string): Promise<string | null> => {
	const rows = await db<Array<{ site_id: string }>>`
        SELECT site_id FROM private_site_shares WHERE token_hash = ${tokenHash} LIMIT 1
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
        VALUES (${shareId}, ${siteId}, ${tokenHash}, ${tokenPrefix}, ${options.label ?? null}, ${options.expiresAt}, ${options.audienceDid ?? null})
        RETURNING *
    `

	return { share: mapShare(rows[0]!), token }
}
export const revokeShare = async (siteId: string, shareId: string): Promise<boolean> => {
	const rows = await db`
        UPDATE private_site_shares
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE site_id = ${siteId} AND share_id = ${shareId}
        RETURNING share_id
    `
	return rows.length > 0
}
export const touchShare = async (shareId: string): Promise<void> => {
	try {
		await db`UPDATE private_site_shares SET last_used_at = NOW() WHERE share_id = ${shareId}`
	} catch {}
}
export const listExpiredPrivateSites = async (limit = 100): Promise<PrivateSite[]> => {
	const rows = await db<PrivateSiteRow[]>`
        SELECT * FROM private_sites
        WHERE expires_at IS NOT NULL AND expires_at <= NOW()
        ORDER BY expires_at ASC
        LIMIT ${limit}
    `
	return rows.map(mapSite)
}
export const createOwnerHandoff = async (siteId: string, ownerDid: string): Promise<string> => {
	const secret = generateHandoffSecret()
	const expiresAt = new Date(Date.now() + OWNER_HANDOFF_TTL_SECONDS * 1000)

	await db`
        INSERT INTO private_site_handoffs (handoff_id, secret_hash, site_id, owner_did, expires_at)
        VALUES (${generateRecordId()}, ${secret.hash}, ${siteId}, ${ownerDid}, ${expiresAt})
    `

	return secret.value
}
export const createShareHandoff = async (siteId: string, shareId: string): Promise<string> => {
	const secret = generateHandoffSecret()
	const expiresAt = new Date(Date.now() + OWNER_HANDOFF_TTL_SECONDS * 1000)

	await db`
        INSERT INTO private_site_handoffs (handoff_id, secret_hash, site_id, share_id, expires_at)
        VALUES (${generateRecordId()}, ${secret.hash}, ${siteId}, ${shareId}, ${expiresAt})
    `

	return secret.value
}
export const pruneHandoffs = async (): Promise<void> => {
	await db`DELETE FROM private_site_handoffs WHERE expires_at < NOW() OR consumed_at IS NOT NULL`
}
export const pruneSessions = async (): Promise<void> => {
	await db`DELETE FROM private_site_sessions WHERE expires_at < NOW()`
}
