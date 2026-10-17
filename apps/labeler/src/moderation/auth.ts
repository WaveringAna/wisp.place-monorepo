import {
	NodeOAuthClient,
	type NodeSavedSession,
	type NodeSavedState,
	requestLocalLock,
} from '@atproto/oauth-client-node'
import type postgres from 'postgres'

/**
 * Moderator sign-in with atproto OAuth. It only learns who the visitor is: the
 * bare `atproto` scope, tokens revoked as soon as the callback has the DID, and
 * only DIDs in `moderators` let in. The login is this service's own cookie.
 */

const COOKIE = 'wisp_moderation'
const LOGIN_TTL_MS = 7 * 24 * 3600_000
const OAUTH_STATE_TTL_MS = 15 * 60_000

function postgresStore<V>(sql: postgres.Sql, kind: string, ttlMs: number | null) {
	return {
		async get(key: string): Promise<V | undefined> {
			const [row] = await sql<{ value: V }[]>`
				SELECT value FROM moderation_oauth
				WHERE kind = ${kind} AND key = ${key} AND (expires_at IS NULL OR expires_at > now())`
			return row?.value
		},
		async set(key: string, value: V) {
			const expires = ttlMs === null ? null : new Date(Date.now() + ttlMs)
			await sql`
				INSERT INTO moderation_oauth (kind, key, value, expires_at)
				VALUES (${kind}, ${key}, ${sql.json(value as postgres.JSONValue)}, ${expires})
				ON CONFLICT (kind, key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`
		},
		async del(key: string) {
			await sql`DELETE FROM moderation_oauth WHERE kind = ${kind} AND key = ${key}`
		},
	}
}

export function readCookie(req: Request, name = COOKIE): string | undefined {
	for (const part of req.headers.get('cookie')?.split(';') ?? []) {
		const [k, ...v] = part.trim().split('=')
		if (k === name) return v.join('=')
	}
	return undefined
}

export function createModeratorAuth({
	sql,
	publicUrl,
	moderators,
	resolveHandle,
}: {
	sql: postgres.Sql
	publicUrl: string
	moderators: ReadonlySet<string>
	resolveHandle: (did: string) => Promise<string | null>
}) {
	const client = new NodeOAuthClient({
		clientMetadata: {
			client_id: `${publicUrl}/oauth-client-metadata.json`,
			client_name: 'wisp.place moderation',
			client_uri: publicUrl,
			redirect_uris: [`${publicUrl}/oauth/callback`],
			scope: 'atproto',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			application_type: 'web',
			token_endpoint_auth_method: 'none',
			dpop_bound_access_tokens: true,
		},
		stateStore: postgresStore<NodeSavedState>(sql, 'state', OAUTH_STATE_TTL_MS),
		sessionStore: postgresStore<NodeSavedSession>(sql, 'session', OAUTH_STATE_TTL_MS),
		requestLock: requestLocalLock,
	})

	const cookie = (value: string, maxAgeSeconds: number) =>
		`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`

	const handles = new Map<string, string>()

	return {
		metadata: () => Response.json(client.clientMetadata),

		/** The signed-in moderator's DID, or null. */
		async moderator(req: Request): Promise<string | null> {
			const id = readCookie(req)
			if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null
			const [row] = await sql<{ did: string }[]>`
				SELECT did FROM moderation_logins WHERE id = ${id} AND expires_at > now()`
			return row && moderators.has(row.did) ? row.did : null
		},

		async handle(did: string): Promise<string> {
			const cached = handles.get(did)
			if (cached) return cached
			const handle = (await resolveHandle(did).catch(() => null)) ?? did
			handles.set(did, handle)
			return handle
		},

		async start(handle: string): Promise<Response> {
			const url = await client.authorize(handle, { scope: 'atproto' })
			return new Response(null, { status: 302, headers: { location: url.toString() } })
		},

		async callback(req: Request): Promise<Response> {
			const { session } = await client.callback(new URL(req.url).searchParams)
			const did = session.did
			await session.signOut().catch(() => {})
			if (!moderators.has(did)) return new Response(`${did} is not a moderator here.\n`, { status: 403 })
			const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
			await sql`DELETE FROM moderation_logins WHERE expires_at < now()`
			await sql`INSERT INTO moderation_logins (id, did, expires_at) VALUES (${id}, ${did}, ${new Date(Date.now() + LOGIN_TTL_MS)})`
			return new Response(null, {
				status: 302,
				headers: { location: '/', 'set-cookie': cookie(id, LOGIN_TTL_MS / 1000) },
			})
		},

		async logout(req: Request): Promise<Response> {
			const id = readCookie(req)
			if (id) await sql`DELETE FROM moderation_logins WHERE id = ${id}`
			return new Response(null, { status: 302, headers: { location: '/login', 'set-cookie': cookie('', 0) } })
		},
	}
}

export type ModeratorAuth = ReturnType<typeof createModeratorAuth>
