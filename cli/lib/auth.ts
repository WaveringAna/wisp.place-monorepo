import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { cwd } from 'node:process'
import { Agent, CredentialSession } from '@atproto/api'
import {
	NodeOAuthClient,
	type NodeSavedSession,
	type NodeSavedSessionStore,
	type NodeSavedState,
	type NodeSavedStateStore,
	requestLocalLock,
} from '@atproto/oauth-client-node'
import { serve as honoNodeServe } from '@hono/node-server'
import { resolvePdsFromHandle } from '@wispplace/atproto-utils'
import { isBun } from '@wispplace/bun-firehose'
import { Hono } from 'hono'
import open from 'open'

// All scopes requested upfront so the client_id is stable across commands
const OAUTH_SCOPE = [
	'atproto',
	'repo:place.wisp.fs',
	'repo:place.wisp.subfs',
	'repo:place.wisp.settings',
	'blob:*/*',
	'rpc:place.wisp.v2.site.getList?aud=*',
	'rpc:place.wisp.v2.site.delete?aud=*',
	'rpc:place.wisp.v2.domain.getList?aud=*',
	'rpc:place.wisp.v2.domain.claim?aud=*',
	'rpc:place.wisp.v2.domain.claimSubdomain?aud=*',
	'rpc:place.wisp.v2.domain.getStatus?aud=*',
	'rpc:place.wisp.v2.domain.addSite?aud=*',
	'rpc:place.wisp.v2.domain.delete?aud=*',
].join(' ')

const DEFAULT_DB_PATH = join(homedir(), '.config', 'wispctl', 'state.sqlite')

const LOOPBACK_PORT = 4000
const LOOPBACK_HOST = '127.0.0.1'

// Runtime-agnostic KV adapter — all SQL is baked in so return types are known

interface KvRow {
	value: string
	expires_at: number | null
}

interface KvAdapter {
	get(key: string): KvRow | undefined
	set(key: string, value: string, expiresAt: number | null): void
	del(key: string): void
	clear(): void
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS kv (
		key        TEXT PRIMARY KEY,
		value      TEXT NOT NULL,
		expires_at INTEGER
	)
`

async function openKv(dbPath: string): Promise<KvAdapter> {
	mkdirSync(dirname(dbPath), { recursive: true })

	if (isBun) {
		const { Database } = await import('bun:sqlite')
		const db = new Database(dbPath)
		db.run('PRAGMA journal_mode = WAL')
		db.run(SCHEMA)
		const getStmt = db.query<KvRow, [string]>('SELECT value, expires_at FROM kv WHERE key = ?')
		const setStmt = db.query('INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)')
		const delStmt = db.query('DELETE FROM kv WHERE key = ?')
		return {
			get: (key) => getStmt.get(key) ?? undefined,
			set: (key, value, expiresAt) => { setStmt.run(key, value, expiresAt) },
			del: (key) => { delStmt.run(key) },
			clear: () => db.run('DELETE FROM kv'),
		}
	} else {
		const { DatabaseSync } = await import('node:sqlite')
		const db = new DatabaseSync(dbPath)
		db.exec('PRAGMA journal_mode = WAL')
		db.exec(SCHEMA)
		const getStmt = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?')
		const setStmt = db.prepare('INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)')
		const delStmt = db.prepare('DELETE FROM kv WHERE key = ?')
		return {
			get: (key) => getStmt.get(key) as KvRow | undefined,
			set: (key, value, expiresAt) => { setStmt.run(key, value, expiresAt) },
			del: (key) => { delStmt.run(key) },
			clear: () => db.exec('DELETE FROM kv'),
		}
	}
}

function kvGet(kv: KvAdapter, key: string): string | undefined {
	const row = kv.get(key)
	if (!row) return undefined
	if (row.expires_at !== null && row.expires_at <= Date.now()) {
		kv.del(key)
		return undefined
	}
	return row.value
}

function kvSet(kv: KvAdapter, key: string, value: string, ttlSeconds?: number): void {
	const expiresAt = ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : null
	kv.set(key, value, expiresAt)
}

function createStateStore(kv: KvAdapter): NodeSavedStateStore {
	return {
		async set(key: string, state: NodeSavedState) {
			kvSet(kv, `oauth_state:${key}`, JSON.stringify(state), 600)
		},
		async get(key: string) {
			const raw = kvGet(kv, `oauth_state:${key}`)
			if (!raw) return undefined
			return JSON.parse(raw) as NodeSavedState
		},
		async del(key: string) {
			kv.del(`oauth_state:${key}`)
		},
	}
}

function createSessionStore(kv: KvAdapter): NodeSavedSessionStore {
	return {
		async set(sub: string, session: NodeSavedSession) {
			kvSet(kv, `oauth_session:${sub}`, JSON.stringify(session), 60 * 60 * 24 * 14)
		},
		async get(sub: string) {
			const raw = kvGet(kv, `oauth_session:${sub}`)
			if (!raw) return undefined
			return JSON.parse(raw) as NodeSavedSession
		},
		async del(sub: string) {
			kv.del(`oauth_session:${sub}`)
		},
	}
}

export interface AuthOptions {
	dbPath?: string
	appPassword?: string
	onStatus?: (message: string) => void
}

function emitStatus(options: AuthOptions | undefined, message: string) {
	if (options?.onStatus) {
		options.onStatus(message)
		return
	}
	console.log(message)
}

function emitWarning(options: AuthOptions | undefined, message: string) {
	if (options?.onStatus) {
		options.onStatus(`Warning: ${message}`)
		return
	}
	console.warn(`Warning: ${message}`)
}

/**
 * Check whether the current directory has a stored session
 */
export async function hasDirSession(dbPath?: string): Promise<boolean> {
	try {
		const kv = await openKv(dbPath || DEFAULT_DB_PATH)
		return kvGet(kv, `dir:${cwd()}`) !== undefined
	} catch {
		return false
	}
}

/**
 * Authenticate with AT Protocol using OAuth loopback flow
 */
export async function authenticateOAuth(
	handle?: string,
	options: AuthOptions = {},
): Promise<{ agent: Agent; did: string }> {
	const kv = await openKv(options.dbPath || DEFAULT_DB_PATH)

	const redirectUri = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}/oauth/callback`
	const clientIdParams = new URLSearchParams()
	clientIdParams.append('redirect_uri', redirectUri)
	clientIdParams.append('scope', OAUTH_SCOPE)

	const client = new NodeOAuthClient({
		clientMetadata: {
			client_id: `http://localhost?${clientIdParams.toString()}`,
			client_name: 'Wisp CLI',
			client_uri: 'https://wisp.place',
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			application_type: 'web',
			token_endpoint_auth_method: 'none',
			scope: OAUTH_SCOPE,
			dpop_bound_access_tokens: false,
		},
		stateStore: createStateStore(kv),
		sessionStore: createSessionStore(kv),
		requestLock: requestLocalLock,
	})

	// Try to restore the session mapped to the current directory
	const dirKey = `dir:${cwd()}`
	const storedDid = kvGet(kv, dirKey)
	if (storedDid) {
		try {
			const session = await client.restore(storedDid)
			if (session) {
				emitStatus(options, `Restored session for ${storedDid}`)
				return { agent: new Agent(session), did: storedDid }
			}
		} catch {
			// Session invalid or expired — clear mapping and re-auth
			kv.del(dirKey)
		}
	}

	// Need a handle to start a new OAuth flow
	if (!handle) {
		throw new Error('No active session for this directory. Run `wispctl login <handle>` first.')
	}

	// Start new OAuth flow
	emitStatus(options, `Starting OAuth flow for ${handle}...`)

	const callbackPromise = new Promise<{ params: URLSearchParams }>((resolve, reject) => {
		const app = new Hono()
		let serverHandle: { close: () => void } | null = null
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined
		let settled = false

		const successHtml = `
      <html>
        <head>
          <title>Wisp CLI - Authentication Successful</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>
            :root {
              color-scheme: light dark;
            }

            body {
              margin: 0;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              font-family: system-ui, -apple-system, Segoe UI, sans-serif;
              background: #f4f5f7;
              color: #111827;
              text-align: center;
              padding: 24px;
            }

            .content {
              max-width: 560px;
            }

            h1 {
              margin: 0 0 10px;
              font-size: 22px;
            }

            p {
              margin: 0;
              color: #4b5563;
              line-height: 1.5;
            }

            @media (prefers-color-scheme: dark) {
              body {
                background: #1e1e1e;
                color: #f3f4f6;
              }

              p {
                color: #d1d5db;
              }
            }
          </style>
        </head>
        <body>
          <div class="content">
            <h1>Authentication Successful</h1>
            <p>You can close this window and return to the CLI.</p>
          </div>
        </body>
      </html>
    `

		app.get('/oauth/callback', (c) => {
			const params = new URLSearchParams(c.req.url.split('?')[1] || '')
			if (timeoutHandle) {
				clearTimeout(timeoutHandle)
			}
			settled = true
			setTimeout(() => serverHandle?.close(), 100)
			resolve({ params })
			return c.html(successHtml)
		})

		app.all('*', (c) => c.text('Not found', 404))

		if (isBun) {
			const bunServer = Bun.serve({
				port: LOOPBACK_PORT,
				hostname: LOOPBACK_HOST,
				fetch: app.fetch,
			})
			serverHandle = { close: () => bunServer.stop() }
		} else {
			const nodeServer = honoNodeServe({
				fetch: app.fetch,
				port: LOOPBACK_PORT,
				hostname: LOOPBACK_HOST,
			})
			serverHandle = { close: () => nodeServer.close() }
		}

		timeoutHandle = setTimeout(
			() => {
				if (settled) return
				settled = true
				serverHandle?.close()
				reject(new Error('OAuth callback timeout'))
			},
			5 * 60 * 1000,
		)

		if (typeof (timeoutHandle as { unref?: () => void }).unref === 'function') {
			;(timeoutHandle as { unref: () => void }).unref()
		}
	})

	const authUrl = await client.authorize(handle, { scope: OAUTH_SCOPE })

	emitStatus(options, 'Opening browser for authentication...')
	emitStatus(options, `If browser does not open, visit: ${authUrl}`)
	await open(authUrl.toString())

	const { params } = await callbackPromise
	const { session } = await client.callback(params)

	const tokenInfo = await session.getTokenInfo(false)
	const grantedScopes = new Set((tokenInfo.scope || '').split(/\s+/).filter(Boolean))
	const missingScopes = OAUTH_SCOPE.split(' ').filter((s) => !grantedScopes.has(decodeURIComponent(s)))
	if (missingScopes.length > 0) {
		emitWarning(
			options,
			`OAuth token is missing ${missingScopes.length} requested scope(s). First missing: ${missingScopes[0]}`,
		)
	}

	const agent = new Agent(session)
	const did = session.did

	// Map the current directory to this DID for future restores
	kvSet(kv, dirKey, did)

	emitStatus(options, `Authenticated as ${did}`)

	return { agent, did }
}

/**
 * Authenticate with AT Protocol using app password (for CI/headless)
 */
export async function authenticateAppPassword(
	identifier: string,
	password: string,
	pdsUrl?: string,
	options: AuthOptions = {},
): Promise<{ agent: Agent; did: string }> {
	let serviceUrl = pdsUrl

	if (!serviceUrl) {
		emitStatus(options, `Resolving PDS for ${identifier}...`)
		serviceUrl = await resolvePdsFromHandle(identifier)
		emitStatus(options, `Found PDS: ${serviceUrl}`)
	}

	const credSession = new CredentialSession(new URL(serviceUrl))
	await credSession.login({ identifier, password })

	const agent = new Agent(credSession)
	const did = credSession.did!

	emitStatus(options, `Authenticated as ${did}`)

	return { agent, did }
}

/**
 * Authenticate - tries OAuth if no password provided, otherwise uses app password
 */
export async function authenticate(handle?: string, options: AuthOptions = {}): Promise<{ agent: Agent; did: string }> {
	if (options.appPassword) {
		if (!handle) throw new Error('Handle required with app password authentication')
		return authenticateAppPassword(handle, options.appPassword, undefined, options)
	}
	return authenticateOAuth(handle, options)
}

/**
 * Clear the session mapping for the current directory (local logout)
 */
export async function clearDirSession(dbPath?: string) {
	try {
		const kv = await openKv(dbPath || DEFAULT_DB_PATH)
		kv.del(`dir:${cwd()}`)
		console.log('Cleared session for current directory')
	} catch {
		// db doesn't exist yet
	}
}

/**
 * Clear all stored OAuth sessions and directory mappings
 */
export async function clearSessions(dbPath?: string) {
	try {
		const kv = await openKv(dbPath || DEFAULT_DB_PATH)
		kv.clear()
		console.log('Cleared all stored OAuth sessions')
	} catch {
		// db doesn't exist yet
	}
}
