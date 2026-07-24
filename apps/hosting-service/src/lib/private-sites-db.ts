/**
 * Read-only private-site queries for the hosting service.
 *
 * The hosting service never creates or mutates private sites; main-app owns writes. The
 * one exception is the best-effort `last_used_at` audit touch, which records that a share
 * link was used without recording the credential itself.
 */

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
	expiresAt: row.expires_at,
	revokedAt: row.revoked_at,
	createdAt: row.created_at,
	lastUsedAt: row.last_used_at,
})

/**
 * Private site lookup.
 *
 * Deliberately NOT routed through the shared request cache used for public domain
 * lookups: a cached negative or stale row could keep a revoked or deleted private site
 * reachable, and private authorization state must be read fresh.
 */
export async function getPrivateSite(siteId: string): Promise<PrivateSite | null> {
	const rows = await sql<PrivateSiteRow[]>`
    SELECT site_id, owner_did, name, file_count, total_bytes, expires_at, created_at, updated_at
    FROM private_sites WHERE site_id = ${siteId} LIMIT 1
  `
	return rows[0] ? mapSite(rows[0]) : null
}

/** Candidate shares for a presented token hash. The authoritative check is timing-safe. */
export async function findSharesByTokenHash(siteId: string, tokenHash: string): Promise<PrivateSiteShare[]> {
	const rows = await sql<PrivateShareRow[]>`
    SELECT share_id, site_id, token_hash, token_prefix, label, expires_at, revoked_at, created_at, last_used_at
    FROM private_site_shares WHERE site_id = ${siteId} AND token_hash = ${tokenHash}
  `
	return rows.map(mapShare)
}

/** File metadata for a private site, used to resolve index files and content types. */
export async function listPrivateSiteFiles(
	siteId: string,
): Promise<Array<{ path: string; size: number; mimeType: string | null }>> {
	const rows = await sql<Array<{ path: string; size: string | number; mime_type: string | null }>>`
    SELECT path, size, mime_type FROM private_site_files WHERE site_id = ${siteId}
  `
	return rows.map((r) => ({ path: r.path, size: Number(r.size), mimeType: r.mime_type }))
}

/** Best-effort audit touch. Never fails a request that has already been authorized. */
export async function touchShare(shareId: string): Promise<void> {
	try {
		await sql`UPDATE private_site_shares SET last_used_at = NOW() WHERE share_id = ${shareId}`
	} catch {
		// intentionally ignored
	}
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

/**
 * Look up a live per-site session by its secret hash.
 *
 * Joins the owning share so a revoked or expired share invalidates any session it issued,
 * rather than the session outliving the grant it came from.
 */
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

/** Persist a newly exchanged session. */
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

/**
 * Consume a one-time owner handoff token.
 *
 * The update is conditional and returns the row, so a concurrent second use cannot also
 * succeed: whichever statement wins marks it consumed and the other matches nothing.
 */
export async function consumeHandoff(secretHash: string): Promise<{ siteId: string; ownerDid: string } | null> {
	const rows = await sql<Array<{ site_id: string; owner_did: string }>>`
    UPDATE private_site_handoffs
    SET consumed_at = NOW()
    WHERE secret_hash = ${secretHash} AND consumed_at IS NULL AND expires_at > NOW()
    RETURNING site_id, owner_did
  `
	const row = rows[0]
	return row ? { siteId: row.site_id, ownerDid: row.owner_did } : null
}
