import { JoseKey } from '@atproto/jwk-jose'
import { NodeOAuthClient, type RuntimeLock } from '@atproto/oauth-client-node'
import { SQL } from 'bun'
import { probeConnectionWithRetry } from './connection-warming'
import { databaseConfiguration, db } from './db'
import { forgetGrantedScope, rememberGrantedScope } from './granted-scopes'
import { logger } from './logger'
import { deleteExpiredOAuthRows } from './oauth-cleanup'
import { createClientMetadata } from './oauth-client-metadata'
import { createOAuthFetch } from './oauth-fetch'
import { needsRotation, newKid, type StoredKeyInfo, signingOrder } from './oauth-key-rotation'
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
//
// Deliberately no maxLifetime. A connection here is reserved for the whole
// critical section, so a lifetime cap can retire one while it still holds an
// advisory lock: the query dies with "Max lifetime timeout reached", the lock is
// orphaned on the server, and the slot is not reliably returned to this
// four-connection pool. Four of those and every caller waits forever.
const lockDb = new SQL({
	url: databaseConfiguration.primaryUrl,
	max: 4,
	idleTimeout: databaseConfiguration.primaryPool.idleTimeoutSeconds,
	connectionTimeout: databaseConfiguration.primaryPool.connectionTimeoutSeconds,
})

/**
 * How long to wait for a free connection in the lock pool.
 *
 * An unbounded wait is what turns a degraded pool into a silent outage: every
 * sign-in stops mid-callback with nothing logged, because waiting is not an
 * error. Refusing loudly gives the caller a 500 and leaves a trace to find.
 */
const LOCK_RESERVE_TIMEOUT_MS = 15_000

const reserveLockConnection = async () => {
	const reservation = lockDb.reserve()
	let reserved = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error('Timed out reserving an OAuth advisory lock connection')),
			LOCK_RESERVE_TIMEOUT_MS,
		)
	})

	try {
		const connection = await Promise.race([reservation, expiry])
		reserved = true
		return connection
	} finally {
		clearTimeout(timer)
		// A reservation that lands after we gave up must not keep the slot.
		if (!reserved) void reservation.then((late) => late.release()).catch(() => undefined)
	}
}

/**
 * Hold one lock connection open.
 *
 * Nothing else uses this pool, so without warming it was always cold: the very
 * first thing an OAuth callback does with it is establish a connection to the
 * primary, which from a distant region costs more than the lock it is about to
 * take. `client.callback()` always takes this lock — it revokes any prior
 * session before storing the new one — so the cost landed on every sign-in.
 */
export const warmOAuthLockConnection = async (): Promise<void> => {
	await probeConnectionWithRetry(() => lockDb`SELECT 1`)
}

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
	const reserved = await reserveLockConnection()
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

const sessionStore = {
	async set(sub: string, data: any) {
		console.debug('[sessionStore] set', sub)
		const scope = data?.tokenSet?.scope
		if (typeof scope === 'string') rememberGrantedScope(sub, scope)
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
		forgetGrantedScope(sub)
		await db`DELETE FROM oauth_sessions WHERE sub = ${sub}`
	},
}

export { sessionStore }

export const cleanupExpiredSessions = () => deleteExpiredOAuthRows(db)

const loadPersistedKeys = async (): Promise<JoseKey[]> => {
	const rows = await db`SELECT kid, jwk, created_at FROM oauth_keys`
	const stored: (StoredKeyInfo & { key: JoseKey })[] = []
	for (const row of rows) {
		try {
			const obj = JSON.parse(row.jwk)
			const key = await JoseKey.fromImportable(obj as any, (obj as any).kid)
			stored.push({ kid: row.kid, createdAt: Number(row.created_at ?? 0), key })
		} catch (err) {
			logger.error('[OAuth] Could not parse stored JWK', err)
		}
	}
	return signingOrder(stored, Math.floor(Date.now() / 1000)).map((s) => s.key)
}

// 60s ttl: the OAuth client checks this cache every minute and rebuilds when a
// rotation adds a key, and /jwks.json serves the same keys.
let keysCache: { keys: JoseKey[]; fetchedAtMs: number } | undefined
const KEYS_CACHE_TTL_MS = 60_000

export const getCurrentKeys = async (): Promise<JoseKey[]> => {
	if (keysCache && Date.now() - keysCache.fetchedAtMs < KEYS_CACHE_TTL_MS) return keysCache.keys
	const keys = await loadPersistedKeys()
	keysCache = { keys, fetchedAtMs: Date.now() }
	return keys
}

/**
 * Adds a key under a new kid when the newest one is past KEY_MAX_AGE_S. Every
 * instance runs this hourly; the advisory lock keeps them from each adding one.
 */
export const rotateKeysIfNeeded = async (): Promise<boolean> => {
	try {
		const kid = await db.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(${lockKey('oauth-key-rotation').toString()}::bigint)`
			const rows = await tx`SELECT kid, created_at FROM oauth_keys`
			const now = Math.floor(Date.now() / 1000)
			const known = rows.map((r: { kid: string; created_at: number | null }) => ({
				kid: r.kid,
				createdAt: Number(r.created_at ?? 0),
			}))
			if (!needsRotation(known, now)) return null
			const kid = newKid(now)
			const key = await JoseKey.generate(['ES256'], kid)
			await tx`
				INSERT INTO oauth_keys (kid, jwk, created_at)
				VALUES (${kid}, ${JSON.stringify(key.privateJwk)}, ${now})
			`
			return kid
		})
		if (!kid) {
			logger.debug('[KeyRotation] No keys need rotation')
			return false
		}
		keysCache = undefined
		logger.info(`[KeyRotation] Added key ${kid}; instances sign with it once it has been published for an hour`)
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

type OAuthClientConfig = {
	domain: `http://${string}` | `https://${string}`
	clientName: string
}

const keysetFingerprint = (keys: JoseKey[]): string =>
	keys.map((k) => `${k.kid}:${(k.publicJwk as { x?: string } | undefined)?.x ?? ''}`).join(',')

const KEYSET_CHECK_INTERVAL_MS = 60_000

/**
 * The returned client follows the stored keyset: once a minute it compares the
 * keys it signs with against oauth_keys and swaps in a client built on the new
 * ones. State and sessions live in Postgres, so a swap loses only caches.
 */
export const getOAuthClient = async (config: OAuthClientConfig): Promise<NodeOAuthClient> => {
	if ((await getCurrentKeys()).length === 0) await rotateKeysIfNeeded()
	let keys = await getCurrentKeys()
	let current = buildOAuthClient(config, keys)

	const timer = setInterval(() => {
		void getCurrentKeys()
			.then((latest) => {
				if (latest.length === 0 || keysetFingerprint(latest) === keysetFingerprint(keys)) return
				keys = latest
				current = buildOAuthClient(config, keys)
				logger.info(`[OAuth] Keyset changed; now signing with ${keys[0]?.kid}`)
			})
			.catch((err) => logger.error('[OAuth] Keyset check failed', err))
	}, KEYSET_CHECK_INTERVAL_MS)
	timer.unref?.()

	return new Proxy({} as NodeOAuthClient, {
		get: (_target, prop) => {
			const value = Reflect.get(current, prop, current)
			return typeof value === 'function' ? value.bind(current) : value
		},
	})
}

const buildOAuthClient = (config: OAuthClientConfig, keys: JoseKey[]) =>
	new NodeOAuthClient({
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
