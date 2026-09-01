import { JoseKey } from '@atproto/jwk-jose'
import { NodeOAuthClient, type RuntimeLock } from '@atproto/oauth-client-node'
import { SQL } from 'bun'
import { databaseConfiguration, db } from './db'
import { logger } from './logger'
import { createClientMetadata } from './oauth-client-metadata'
import { createOAuthFetch } from './oauth-fetch'
import { withReservedOAuthLock } from './oauth-lock'
import { SlingshotHandleResolver } from './slingshot-handle-resolver'
import { createTtlMemoryStore } from './ttl-memory-store'

export { createClientMetadata, OAUTH_LEGACY_SCOPE, OAUTH_SCOPE } from './oauth-client-metadata'

// Cluster-wide lock backed by Postgres advisory locks. Replaces requestLocalLock
// which only serialized within a single process — with multiple main-app instances
// sharing the oauth_sessions table, two processes could race a token refresh,
// invalidate the single-use refresh token, and trip
// "The session was deleted by another process" from @atproto/oauth-client.
const LOCK_NAMESPACE = 0x0a415450524f544fn // "\nATPROTO" — stable 8-byte salt
const lockKey = (name: string): bigint => {
	const digest = new Bun.CryptoHasher('sha256').update(name).digest()
	const view = new DataView(digest.buffer, digest.byteOffset, 8)
	return view.getBigInt64(0, false) ^ LOCK_NAMESPACE
}

// Dedicated primary pool just for advisory locks. Each lock acquisition reserves
// a connection for the full duration of fn() (which makes HTTP calls to the PDS),
// so it must not share the main query pool — otherwise a slow PDS starves the
// pool and inner stateStore/sessionStore queries deadlock waiting for slots.
const lockDb = new SQL({ url: databaseConfiguration.primaryUrl, max: 4 })

let oauthLockDatabaseClosePromise: Promise<void> | undefined

/** Close the dedicated OAuth advisory-lock pool during graceful shutdown. */
export const closeOAuthLockDatabase = (): Promise<void> => {
	oauthLockDatabaseClosePromise ??= (async () => {
		try {
			await lockDb.end()
			logger.info('[OAuth] Advisory lock database connection closed')
		} catch {
			// Driver errors can contain a connection URL, so do not log them verbatim.
			logger.error('[OAuth] Error closing advisory lock database connection')
		}
	})()

	return oauthLockDatabaseClosePromise
}

const requestPgLock: RuntimeLock = async (name, fn) => {
	const key = lockKey(name)
	const reserved = await lockDb.reserve()
	return await withReservedOAuthLock(
		{
			async acquire(): Promise<void> {
				await reserved.unsafe(`SET lock_timeout = '30s'; SELECT pg_advisory_lock(${key})`)
			},
			async unlock(): Promise<void> {
				await reserved`SELECT pg_advisory_unlock(${key})`
			},
			release(): void {
				reserved.release()
			},
			close(): Promise<void> {
				return reserved.close({ timeout: 0 })
			},
		},
		fn,
		(kind) => logger.error('[OAuth] Advisory lock cleanup failed', { name, kind }),
	)
}

const oauthNetworkOptions = () => {
	const allowHttp = Bun.env.OAUTH_ALLOW_HTTP === 'true'
	const hasRewrite = Boolean(Bun.env.OAUTH_FETCH_REWRITE_FROM || Bun.env.OAUTH_FETCH_REWRITE_TO)
	if ((allowHttp || hasRewrite) && Bun.env.LOCAL_DEV !== 'true') {
		throw new Error('insecure OAuth networking overrides require LOCAL_DEV=true')
	}

	return {
		allowHttp,
		plcDirectoryUrl: Bun.env.OAUTH_PLC_DIRECTORY_URL,
		fetch: createOAuthFetch({
			rewriteFrom: Bun.env.OAUTH_FETCH_REWRITE_FROM,
			rewriteTo: Bun.env.OAUTH_FETCH_REWRITE_TO,
		}),
	}
}

// Session timeout configuration (30 days in seconds)
const SESSION_TIMEOUT = 30 * 24 * 60 * 60 // 2592000 seconds
// OAuth state timeout (1 hour in seconds)
const STATE_TIMEOUT = 60 * 60 // 3600 seconds

const stateStore = {
	async set(key: string, data: any) {
		console.debug('[stateStore] set', key)
		const expiresAt = Math.floor(Date.now() / 1000) + STATE_TIMEOUT
		await db`
            INSERT INTO oauth_states (key, data, created_at, expires_at)
            VALUES (${key}, ${JSON.stringify(data)}, EXTRACT(EPOCH FROM NOW()), ${expiresAt})
            ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, expires_at = ${expiresAt}
        `
	},
	async get(key: string) {
		console.debug('[stateStore] get', key)
		const now = Math.floor(Date.now() / 1000)
		const result = await db`
            SELECT data, expires_at
            FROM oauth_states
            WHERE key = ${key}
        `
		if (!result[0]) return undefined

		// Check if expired
		const expiresAt = Number(result[0].expires_at)
		if (expiresAt && now > expiresAt) {
			console.debug('[stateStore] State expired, deleting', key)
			await db`DELETE FROM oauth_states WHERE key = ${key}`
			return undefined
		}

		return JSON.parse(result[0].data)
	},
	async del(key: string) {
		console.debug('[stateStore] del', key)
		await db`DELETE FROM oauth_states WHERE key = ${key}`
	},
}

/**
 * The scope granted by the most recently stored session, per subject.
 *
 * The OAuth callback has to know what the authorization server actually granted
 * so it can detect a server that accepted the `include:place.wisp.*` permission
 * sets and then dropped them. Asking the session for it costs a full advisory
 * lock cycle and a read on the primary, microseconds after this process wrote
 * the very value being read. Only the scope string is remembered — never a
 * token — so nothing here can serve a stale credential to a refresh.
 */
const grantedScopes = createTtlMemoryStore<string, string>({ ttlMs: 60_000, max: 500 })

/** The granted scope recorded when this process last stored a session. */
export const recentGrantedScope = (sub: string): string | undefined => grantedScopes.get(sub)

const sessionStore = {
	async set(sub: string, data: any) {
		console.debug('[sessionStore] set', sub)
		const scope = data?.tokenSet?.scope
		if (typeof scope === 'string') grantedScopes.set(sub, scope)
		const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TIMEOUT
		await db`
            INSERT INTO oauth_sessions (sub, data, updated_at, expires_at)
            VALUES (${sub}, ${JSON.stringify(data)}, EXTRACT(EPOCH FROM NOW()), ${expiresAt})
            ON CONFLICT (sub) DO UPDATE SET
                data = EXCLUDED.data,
                updated_at = EXTRACT(EPOCH FROM NOW()),
                expires_at = ${expiresAt}
        `
	},
	async get(sub: string) {
		const now = Math.floor(Date.now() / 1000)
		const result = await db`
            SELECT data, expires_at
            FROM oauth_sessions
            WHERE sub = ${sub}
        `
		if (!result[0]) return undefined

		// Check if expired
		const expiresAt = Number(result[0].expires_at)
		if (expiresAt && now > expiresAt) {
			logger.debug('[sessionStore] Session expired, deleting', { sub })
			await db`DELETE FROM oauth_sessions WHERE sub = ${sub}`
			return undefined
		}

		return JSON.parse(result[0].data)
	},
	async del(sub: string) {
		console.debug('[sessionStore] del', sub)
		grantedScopes.del(sub)
		await db`DELETE FROM oauth_sessions WHERE sub = ${sub}`
	},
}

export { sessionStore }

// Cleanup expired sessions and states
export const cleanupExpiredSessions = async () => {
	const now = Math.floor(Date.now() / 1000)
	try {
		const sessionsDeleted = await db`
            DELETE FROM oauth_sessions WHERE expires_at < ${now}
        `
		const statesDeleted = await db`
            DELETE FROM oauth_states WHERE expires_at IS NOT NULL AND expires_at < ${now}
        `
		logger.info(
			`[Cleanup] Deleted ${sessionsDeleted.length} expired sessions and ${statesDeleted.length} expired states`,
		)
		return { sessions: sessionsDeleted.length, states: statesDeleted.length }
	} catch (err) {
		logger.error('[Cleanup] Failed to cleanup expired data', err)
		return { sessions: 0, states: 0 }
	}
}

const persistKey = async (key: JoseKey) => {
	const priv = key.privateJwk
	if (!priv) return
	const kid = key.kid ?? crypto.randomUUID()
	await db`
        INSERT INTO oauth_keys (kid, jwk, created_at)
        VALUES (${kid}, ${JSON.stringify(priv)}, EXTRACT(EPOCH FROM NOW()))
        ON CONFLICT (kid) DO UPDATE SET
            jwk = EXCLUDED.jwk,
            created_at = EXCLUDED.created_at
    `
	keysCache = undefined
}

// 60s ttl: keys rotate ~twice a year, so cross-instance staleness after a
// rotation self-heals well before the next sign-in checks the new keyset.
let keysCache: { keys: JoseKey[]; fetchedAtMs: number } | undefined
const KEYS_CACHE_TTL_MS = 60_000

const loadPersistedKeys = async (): Promise<JoseKey[]> => {
	const rows = await db`SELECT kid, jwk, created_at FROM oauth_keys ORDER BY kid`
	const keys: JoseKey[] = []
	for (const row of rows) {
		try {
			const obj = JSON.parse(row.jwk)
			const key = await JoseKey.fromImportable(obj as any, (obj as any).kid)
			keys.push(key)
		} catch (err) {
			logger.error('[OAuth] Could not parse stored JWK', err)
		}
	}
	return keys
}

const ensureKeys = async (): Promise<JoseKey[]> => {
	const keys = await loadPersistedKeys()
	const needed: string[] = []
	for (let i = 1; i <= 3; i++) {
		const kid = `key${i}`
		if (!keys.some((k) => k.kid === kid)) needed.push(kid)
	}
	for (const kid of needed) {
		const newKey = await JoseKey.generate(['ES256'], kid)
		await persistKey(newKey)
		keys.push(newKey)
	}
	keys.sort((a, b) => (a.kid ?? '').localeCompare(b.kid ?? ''))
	return keys
}

export const getCurrentKeys = async (): Promise<JoseKey[]> => {
	if (keysCache && Date.now() - keysCache.fetchedAtMs < KEYS_CACHE_TTL_MS) return keysCache.keys
	const keys = await loadPersistedKeys()
	keysCache = { keys, fetchedAtMs: Date.now() }
	return keys
}

// Key rotation - rotate keys older than 6 months
const KEY_MAX_AGE = 182.5 * 24 * 60 * 60 // ~6 months in seconds

export const rotateKeysIfNeeded = async (): Promise<boolean> => {
	const now = Math.floor(Date.now() / 1000)
	const cutoffTime = now - KEY_MAX_AGE

	try {
		// Find keys older than 30 days
		const oldKeys = await db`
            SELECT kid, created_at FROM oauth_keys
            WHERE created_at IS NOT NULL AND created_at < ${cutoffTime}
            ORDER BY created_at ASC
        `

		if (oldKeys.length === 0) {
			logger.debug('[KeyRotation] No keys need rotation')
			return false
		}

		logger.info(`[KeyRotation] Found ${oldKeys.length} key(s) older than 6 months, rotating oldest key`)

		// Rotate the oldest key
		const oldestKey = oldKeys[0]
		const oldKid = oldestKey.kid

		// Generate new key with same kid
		const newKey = await JoseKey.generate(['ES256'], oldKid)
		await persistKey(newKey)

		logger.info(`[KeyRotation] Rotated key ${oldKid}`)

		return true
	} catch (err) {
		logger.error('[KeyRotation] Failed to rotate keys', err)
		return false
	}
}

// A cache miss on any of these costs a request to a PDS that may be a hemisphere
// away, and none of the cached values change on a scale of minutes. The library
// defaults to 60s, which guarantees a cold fetch on every login because the
// consent screen alone takes longer than that.
const METADATA_CACHE_TTL_MS = 15 * 60_000
const METADATA_CACHE_MAX = 500
// Nonces are single-origin and rotate on the server's schedule. A stale one
// costs one extra round trip and self-heals, so it may be held as long as the
// metadata; too short a TTL guarantees the challenge on every login instead.
const DPOP_NONCE_CACHE_TTL_MS = 10 * 60_000

export const getOAuthClient = async (config: {
	domain: `http://${string}` | `https://${string}`
	clientName: string
}) => {
	const keys = await ensureKeys()

	return new NodeOAuthClient({
		...oauthNetworkOptions(),
		clientMetadata: createClientMetadata(config),
		keyset: keys,
		stateStore,
		sessionStore,
		requestLock: requestPgLock,
		handleResolver: new SlingshotHandleResolver(),
		authorizationServerMetadataCache: createTtlMemoryStore({
			ttlMs: METADATA_CACHE_TTL_MS,
			max: METADATA_CACHE_MAX,
		}),
		protectedResourceMetadataCache: createTtlMemoryStore({
			ttlMs: METADATA_CACHE_TTL_MS,
			max: METADATA_CACHE_MAX,
		}),
		dpopNonceCache: createTtlMemoryStore({ ttlMs: DPOP_NONCE_CACHE_TTL_MS, max: METADATA_CACHE_MAX }),
	})
}
