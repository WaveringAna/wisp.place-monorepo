import type { GrantKind, PrivateSessionRecord, PrivateSite, PrivateSiteShare } from '@wispplace/private-sites'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp', {
	max: 5,
	idle_timeout: 20,
})

interface PrivateSiteRow {
	site_id: string
	owner_did: string
	name: string
	file_count: number
	total_bytes: string | number
	expires_at: Date | null
	created_at: Date
	updated_at: Date
}

interface PrivateShareRow {
	share_id: string
	site_id: string
	token_hash: string
	token_prefix: string
	label: string | null
	audience_did: string | null
	expires_at: Date | null
	revoked_at: Date | null
	created_at: Date
	last_used_at: Date | null
}

const mapSite = (row: PrivateSiteRow): PrivateSite => ({
	siteId: row.site_id,
	ownerDid: row.owner_did,
	name: row.name,
	fileCount: Number(row.file_count),
	totalBytes: Number(row.total_bytes),
	expiresAt: row.expires_at,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
})

const mapShare = (row: PrivateShareRow): PrivateSiteShare => ({
	shareId: row.share_id,
	siteId: row.site_id,
	tokenHash: row.token_hash,
	tokenPrefix: row.token_prefix,
	label: row.label,
	audienceDid: row.audience_did,
	expiresAt: row.expires_at,
	revokedAt: row.revoked_at,
	createdAt: row.created_at,
	lastUsedAt: row.last_used_at,
})
export async function getPrivateSite(siteId: string): Promise<PrivateSite | null> {
	const rows = await sql<PrivateSiteRow[]>`
    SELECT site_id, owner_did, name, file_count, total_bytes, expires_at, created_at, updated_at
    FROM private_sites WHERE site_id = ${siteId} LIMIT 1
  `
	return rows[0] ? mapSite(rows[0]) : null
}
export async function findSharesByTokenHash(siteId: string, tokenHash: string): Promise<PrivateSiteShare[]> {
	const rows = await sql<PrivateShareRow[]>`
    SELECT share_id, site_id, token_hash, token_prefix, label, audience_did, expires_at, revoked_at, created_at, last_used_at
    FROM private_site_shares WHERE site_id = ${siteId} AND token_hash = ${tokenHash}
  `
	return rows.map(mapShare)
}
export async function listPrivateSiteFiles(
	siteId: string,
): Promise<Array<{ path: string; size: number; mimeType: string | null }>> {
	const rows = await sql<Array<{ path: string; size: string | number; mime_type: string | null }>>`
    SELECT path, size, mime_type FROM private_site_files WHERE site_id = ${siteId}
  `
	return rows.map((r) => ({ path: r.path, size: Number(r.size), mimeType: r.mime_type }))
}
export async function touchShare(shareId: string): Promise<void> {
	try {
		await sql`UPDATE private_site_shares SET last_used_at = NOW() WHERE share_id = ${shareId}`
	} catch {}
}

interface SessionRow {
	session_id: string
	site_id: string
	kind: string
	owner_did: string | null
	share_id: string | null
	expires_at: Date
	created_at: Date
}
export async function findLiveSession(secretHash: string): Promise<PrivateSessionRecord | null> {
	const rows = await sql<SessionRow[]>`
    SELECT s.session_id, s.site_id, s.kind, s.owner_did, s.share_id, s.expires_at, s.created_at
    FROM private_site_sessions s
    LEFT JOIN private_site_shares sh ON sh.share_id = s.share_id
    WHERE s.secret_hash = ${secretHash}
      AND s.expires_at > NOW()
      AND (
        s.share_id IS NULL
        OR (sh.revoked_at IS NULL AND (sh.expires_at IS NULL OR sh.expires_at > NOW()))
      )
    LIMIT 1
  `
	const row = rows[0]
	if (!row) return null
	return {
		sessionId: row.session_id,
		siteId: row.site_id,
		kind: row.kind as GrantKind,
		ownerDid: row.owner_did,
		shareId: row.share_id,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	}
}
export async function createSession(input: {
	sessionId: string
	secretHash: string
	siteId: string
	kind: GrantKind
	ownerDid: string | null
	shareId: string | null
	expiresAt: Date
}): Promise<void> {
	await sql`
    INSERT INTO private_site_sessions (session_id, secret_hash, site_id, kind, owner_did, share_id, expires_at)
    VALUES (${input.sessionId}, ${input.secretHash}, ${input.siteId}, ${input.kind}, ${input.ownerDid}, ${input.shareId}, ${input.expiresAt})
  `
}
export async function consumeHandoff(
	secretHash: string,
	siteId: string,
): Promise<{ siteId: string; ownerDid: string | null; shareId: string | null } | null> {
	const rows = await sql<Array<{ site_id: string; owner_did: string | null; share_id: string | null }>>`
    UPDATE private_site_handoffs
    SET consumed_at = NOW()
    WHERE secret_hash = ${secretHash} AND site_id = ${siteId} AND consumed_at IS NULL AND expires_at > NOW()
    RETURNING site_id, owner_did, share_id
  `
	const row = rows[0]
	return row ? { siteId: row.site_id, ownerDid: row.owner_did, shareId: row.share_id } : null
}
