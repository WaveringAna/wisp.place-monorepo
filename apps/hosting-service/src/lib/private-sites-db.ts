import type {
	GrantKind,
	PrivateSessionRecord,
	PrivateSite,
	PrivateSiteShare,
	PrivateSiteState,
} from '@wispplace/private-sites'
import postgres from 'postgres'

const privateSitesDatabaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp'

// This is a deliberately bounded primary-only pool. Every query below affects
// authorization, expiry, or private metadata, so it must never use a replica.
const sql = postgres(privateSitesDatabaseUrl, {
	max: 5,
	idle_timeout: 20,
})

let privateSitesDatabaseClosePromise: Promise<void> | undefined

/**
 * Close the separate private-sites pool during graceful shutdown.
 * This function is idempotent so repeated shutdown signals cannot end it twice.
 */
export function closePrivateSitesDatabase(): Promise<void> {
	if (privateSitesDatabaseClosePromise) return privateSitesDatabaseClosePromise

	privateSitesDatabaseClosePromise = (async () => {
		try {
			await sql.end({ timeout: 5 })
			console.log('[Private sites DB] Database connections closed')
		} catch {
			console.error('[Private sites DB] Database pool failed to close cleanly')
		}
	})()
	return privateSitesDatabaseClosePromise
}

interface PrivateSiteRow {
	site_id: string
	owner_did: string
	name: string
	file_count: number
	total_bytes: string | number
	state: PrivateSiteState
	expires_at: Date | string | null
	created_at: Date | string
	updated_at: Date | string
}

interface PrivateShareRow {
	share_id: string
	site_id: string
	token_hash: string
	token_prefix: string
	label: string | null
	audience_did: string | null
	expires_at: Date | string | null
	revoked_at: Date | string | null
	created_at: Date | string
	last_used_at: Date | string | null
}

/** Minimal primary-query surface, also used by deterministic query-plan tests. */
export type PrivateSitesQueryExecutor = typeof sql

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value))
const asDateOrNull = (value: Date | string | null): Date | null => (value === null ? null : asDate(value))

// Private MIME metadata is later used as an HTTP header. Drop malformed legacy
// values rather than allowing controls or oversized data into a response.
const safeMimeType = (value: string | null): string | null =>
	value && value.length <= 255 && /^[\x20-\x7E]+$/.test(value) ? value : null

const mapSite = (row: PrivateSiteRow): PrivateSite => ({
	state: row.state,
	siteId: row.site_id,
	ownerDid: row.owner_did,
	name: row.name,
	fileCount: Number(row.file_count),
	totalBytes: Number(row.total_bytes),
	expiresAt: asDateOrNull(row.expires_at),
	createdAt: asDate(row.created_at),
	updatedAt: asDate(row.updated_at),
})

const mapShare = (row: PrivateShareRow): PrivateSiteShare => ({
	shareId: row.share_id,
	siteId: row.site_id,
	tokenHash: row.token_hash,
	tokenPrefix: row.token_prefix,
	label: row.label,
	audienceDid: row.audience_did,
	expiresAt: asDateOrNull(row.expires_at),
	revokedAt: asDateOrNull(row.revoked_at),
	createdAt: asDate(row.created_at),
	lastUsedAt: asDateOrNull(row.last_used_at),
})

export interface PrivateSiteFile {
	path: string
	size: number
	mimeType: string | null
}

export interface AuthorizedPrivateSite {
	site: PrivateSite
	files: PrivateSiteFile[]
}

interface AuthorizedPrivateSiteRow extends PrivateSiteRow {
	file_path: string | null
	file_size: string | number | null
	file_mime_type: string | null
}

/**
 * Compatibility lookup. It is still primary-only and only exposes a currently
 * live ready site; serving should use loadAuthorizedPrivateSite instead.
 */
export async function getPrivateSite(siteId: string): Promise<PrivateSite | null> {
	const rows = await sql<PrivateSiteRow[]>`
		SELECT site_id, owner_did, name, file_count, total_bytes, state, expires_at, created_at, updated_at
		FROM private_sites
		WHERE site_id = ${siteId}
		  AND state = 'ready'
		  AND (expires_at IS NULL OR expires_at > NOW())
		LIMIT 1
	`
	return rows[0] ? mapSite(rows[0]) : null
}

export async function findSharesByTokenHash(siteId: string, tokenHash: string): Promise<PrivateSiteShare[]> {
	const rows = await sql<PrivateShareRow[]>`
		SELECT share.share_id, share.site_id, share.token_hash, share.token_prefix, share.label,
			share.audience_did, share.expires_at, share.revoked_at, share.created_at, share.last_used_at
		FROM private_site_shares AS share
		JOIN private_sites AS site ON site.site_id = share.site_id
		WHERE share.site_id = ${siteId}
		  AND share.token_hash = ${tokenHash}
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
	`
	return rows.map(mapShare)
}

export async function listPrivateSiteFiles(siteId: string): Promise<PrivateSiteFile[]> {
	const rows = await sql<Array<{ path: string; size: string | number; mime_type: string | null }>>`
		SELECT file.path, file.size, file.mime_type
		FROM private_site_files AS file
		JOIN private_sites AS site ON site.site_id = file.site_id
		WHERE file.site_id = ${siteId}
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		ORDER BY file.path ASC
	`
	return rows.map((row) => ({ path: row.path, size: Number(row.size), mimeType: safeMimeType(row.mime_type) }))
}

interface SessionRow {
	session_id: string
	site_id: string
	kind: string
	owner_did: string | null
	share_id: string | null
	expires_at: Date | string
	created_at: Date | string
}

/** Compatibility lookup; primary serving uses the one-query aggregate below. */
export async function findLiveSession(secretHash: string): Promise<PrivateSessionRecord | null> {
	const rows = await sql<SessionRow[]>`
		SELECT private_session.session_id, private_session.site_id, private_session.kind, private_session.owner_did, private_session.share_id,
			private_session.expires_at, private_session.created_at
		FROM private_site_sessions AS private_session
		JOIN private_sites AS site ON site.site_id = private_session.site_id
		LEFT JOIN private_site_shares AS share ON share.share_id = private_session.share_id
		WHERE private_session.secret_hash = ${secretHash}
		  AND private_session.expires_at > NOW()
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		  AND (
			(private_session.kind = 'owner' AND private_session.owner_did = site.owner_did AND private_session.share_id IS NULL)
			OR (
				private_session.kind = 'share'
				AND private_session.share_id IS NOT NULL
				AND share.site_id = site.site_id
				AND share.revoked_at IS NULL
				AND (share.expires_at IS NULL OR share.expires_at > NOW())
			)
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
		expiresAt: asDate(row.expires_at),
		createdAt: asDate(row.created_at),
	}
}

/**
 * One primary round trip for the normal cookie path. It uses only the cookie
 * hash and joins ready/unexpired site, session, share, and file metadata.
 */
export const loadAuthorizedPrivateSiteWithExecutor = async (
	executor: PrivateSitesQueryExecutor,
	siteId: string,
	sessionSecretHash: string,
): Promise<AuthorizedPrivateSite | null> => {
	const rows = await executor<AuthorizedPrivateSiteRow[]>`
		SELECT
			site.site_id, site.owner_did, site.name, site.file_count, site.total_bytes,
			site.state, site.expires_at, site.created_at, site.updated_at,
			file.path AS file_path, file.size AS file_size, file.mime_type AS file_mime_type
		FROM private_sites AS site
		JOIN private_site_sessions AS private_session ON private_session.site_id = site.site_id
		LEFT JOIN private_site_shares AS share ON share.share_id = private_session.share_id
		LEFT JOIN private_site_files AS file ON file.site_id = site.site_id
		WHERE site.site_id = ${siteId}
		  AND private_session.secret_hash = ${sessionSecretHash}
		  AND private_session.expires_at > NOW()
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		  AND (
			(private_session.kind = 'owner' AND private_session.owner_did = site.owner_did AND private_session.share_id IS NULL)
			OR (
				private_session.kind = 'share'
				AND private_session.share_id IS NOT NULL
				AND share.site_id = site.site_id
				AND share.revoked_at IS NULL
				AND (share.expires_at IS NULL OR share.expires_at > NOW())
			)
		  )
		ORDER BY file.path ASC
	`
	const first = rows[0]
	if (!first) return null

	return {
		site: mapSite(first),
		files: rows.flatMap((row) =>
			row.file_path === null || row.file_size === null
				? []
				: [{ path: row.file_path, size: Number(row.file_size), mimeType: safeMimeType(row.file_mime_type) }],
		),
	}
}

export const loadAuthorizedPrivateSite = async (
	siteId: string,
	sessionSecretHash: string,
): Promise<AuthorizedPrivateSite | null> => await loadAuthorizedPrivateSiteWithExecutor(sql, siteId, sessionSecretHash)

export async function createSession(input: {
	sessionId: string
	secretHash: string
	siteId: string
	kind: GrantKind
	ownerDid: string | null
	shareId: string | null
	expiresAt: Date
}): Promise<boolean> {
	const rows = await sql`
		INSERT INTO private_site_sessions (session_id, secret_hash, site_id, kind, owner_did, share_id, expires_at)
		SELECT ${input.sessionId}, ${input.secretHash}, site.site_id, ${input.kind}, ${input.ownerDid}, ${input.shareId}, ${input.expiresAt}
		FROM private_sites AS site
		LEFT JOIN private_site_shares AS share ON share.share_id = ${input.shareId}
		WHERE site.site_id = ${input.siteId}
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		  AND (
			(${input.kind} = 'owner' AND ${input.ownerDid} = site.owner_did AND ${input.shareId} IS NULL)
			OR (
				${input.kind} = 'share'
				AND ${input.shareId} IS NOT NULL
				AND share.site_id = site.site_id
				AND share.revoked_at IS NULL
				AND (share.expires_at IS NULL OR share.expires_at > NOW())
			)
		  )
		RETURNING session_id
	`
	return rows.length > 0
}

export interface PrivateHandoffExchangeInput {
	siteId: string
	secretHash: string
	sessionId: string
	sessionSecretHash: string
	expiresAt: Date
}

export type PrivateHandoffExchangeResult = { kind: 'owner'; ownerDid: string } | { kind: 'share'; shareId: string }

/** Atomically validate+consume a handoff and mint its session on the primary. */
export async function exchangePrivateHandoff(
	input: PrivateHandoffExchangeInput,
): Promise<PrivateHandoffExchangeResult | null> {
	const rows = await sql<Array<{ kind: string; owner_did: string | null; share_id: string | null }>>`
		WITH consumed AS (
			UPDATE private_site_handoffs AS handoff
			SET consumed_at = NOW()
			FROM private_sites AS site
			WHERE handoff.secret_hash = ${input.secretHash}
			  AND handoff.site_id = ${input.siteId}
			  AND handoff.consumed_at IS NULL
			  AND handoff.expires_at > NOW()
			  AND site.site_id = handoff.site_id
			  AND site.state = 'ready'
			  AND (site.expires_at IS NULL OR site.expires_at > NOW())
			  AND (
				(handoff.owner_did IS NOT NULL AND handoff.owner_did = site.owner_did AND handoff.share_id IS NULL)
				OR (
					handoff.share_id IS NOT NULL
					AND handoff.owner_did IS NULL
					AND EXISTS (
						SELECT 1
						FROM private_site_shares AS share
						WHERE share.share_id = handoff.share_id
						  AND share.site_id = site.site_id
						  AND share.revoked_at IS NULL
						  AND (share.expires_at IS NULL OR share.expires_at > NOW())
					)
				)
			  )
			RETURNING handoff.site_id, handoff.owner_did, handoff.share_id
		), session AS (
			INSERT INTO private_site_sessions (session_id, secret_hash, site_id, kind, owner_did, share_id, expires_at)
			SELECT
				${input.sessionId},
				${input.sessionSecretHash},
				consumed.site_id,
				CASE WHEN consumed.owner_did IS NULL THEN 'share' ELSE 'owner' END,
				consumed.owner_did,
				consumed.share_id,
				${input.expiresAt}
			FROM consumed
			RETURNING kind, owner_did, share_id
		)
		SELECT kind, owner_did, share_id FROM session
	`
	const row = rows[0]
	if (!row) return null
	if (row.kind === 'owner' && row.owner_did) return { kind: 'owner', ownerDid: row.owner_did }
	if (row.kind === 'share' && row.share_id) return { kind: 'share', shareId: row.share_id }
	return null
}

export interface PrivateShareTokenExchangeInput {
	siteId: string
	tokenHash: string
	sessionId: string
	sessionSecretHash: string
	expiresAt: Date
}

export type PrivateShareTokenExchangeResult =
	| { kind: 'share'; shareId: string }
	| { kind: 'audienceMismatch'; audienceDid: string }

/**
 * Validates a token and mints an unscoped session in one statement. A scoped
 * token returns its sign-in instruction only when the token itself is live.
 */
export const exchangePrivateShareTokenWithExecutor = async (
	executor: PrivateSitesQueryExecutor,
	input: PrivateShareTokenExchangeInput,
): Promise<PrivateShareTokenExchangeResult | null> => {
	const rows = await executor<Array<{ kind: string; share_id: string; audience_did: string | null }>>`
		WITH candidate AS (
			SELECT site.site_id, share.share_id, share.audience_did
			FROM private_sites AS site
			JOIN private_site_shares AS share ON share.site_id = site.site_id
			WHERE site.site_id = ${input.siteId}
			  AND share.token_hash = ${input.tokenHash}
			  AND site.state = 'ready'
			  AND (site.expires_at IS NULL OR site.expires_at > NOW())
			  AND share.revoked_at IS NULL
			  AND (share.expires_at IS NULL OR share.expires_at > NOW())
			LIMIT 1
		), created AS (
			INSERT INTO private_site_sessions (session_id, secret_hash, site_id, kind, owner_did, share_id, expires_at)
			SELECT ${input.sessionId}, ${input.sessionSecretHash}, candidate.site_id, 'share', NULL, candidate.share_id, ${input.expiresAt}
			FROM candidate
			WHERE candidate.audience_did IS NULL
			RETURNING share_id
		)
		SELECT 'share'::TEXT AS kind, created.share_id, NULL::TEXT AS audience_did
		FROM created
		UNION ALL
		SELECT 'audienceMismatch'::TEXT AS kind, candidate.share_id, candidate.audience_did
		FROM candidate
		WHERE candidate.audience_did IS NOT NULL
	`
	const row = rows[0]
	if (!row) return null
	if (row.kind === 'share') return { kind: 'share', shareId: row.share_id }
	if (row.kind === 'audienceMismatch' && row.audience_did !== null) {
		return { kind: 'audienceMismatch', audienceDid: row.audience_did }
	}
	return null
}

export const exchangePrivateShareToken = async (
	input: PrivateShareTokenExchangeInput,
): Promise<PrivateShareTokenExchangeResult | null> => await exchangePrivateShareTokenWithExecutor(sql, input)

/** Compatibility primitive; the atomic exchange above is preferred. */
export async function consumeHandoff(
	secretHash: string,
	siteId: string,
): Promise<{ siteId: string; ownerDid: string | null; shareId: string | null } | null> {
	const rows = await sql<Array<{ site_id: string; owner_did: string | null; share_id: string | null }>>`
		UPDATE private_site_handoffs AS handoff
		SET consumed_at = NOW()
		FROM private_sites AS site
		WHERE handoff.secret_hash = ${secretHash}
		  AND handoff.site_id = ${siteId}
		  AND handoff.consumed_at IS NULL
		  AND handoff.expires_at > NOW()
		  AND site.site_id = handoff.site_id
		  AND site.state = 'ready'
		  AND (site.expires_at IS NULL OR site.expires_at > NOW())
		  AND (
			(handoff.owner_did IS NOT NULL AND handoff.owner_did = site.owner_did AND handoff.share_id IS NULL)
			OR (
				handoff.share_id IS NOT NULL
				AND handoff.owner_did IS NULL
				AND EXISTS (
					SELECT 1
					FROM private_site_shares AS share
					WHERE share.share_id = handoff.share_id
					  AND share.site_id = site.site_id
					  AND share.revoked_at IS NULL
					  AND (share.expires_at IS NULL OR share.expires_at > NOW())
				)
			)
		  )
		RETURNING handoff.site_id, handoff.owner_did, handoff.share_id
	`
	const row = rows[0]
	return row ? { siteId: row.site_id, ownerDid: row.owner_did, shareId: row.share_id } : null
}

export async function touchShare(shareId: string): Promise<void> {
	try {
		await sql`UPDATE private_site_shares SET last_used_at = NOW() WHERE share_id = ${shareId}`
	} catch {}
}
