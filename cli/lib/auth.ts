import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
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
import { log } from '@clack/prompts'
import { serve as honoNodeServe } from '@hono/node-server'
import { resolveDid, resolvePdsFromHandle } from '@wispplace/atproto-utils'
import { isBun } from '@wispplace/bun-firehose'
import { Hono } from 'hono'
import open from 'open'
import { WISP_OAUTH_SCOPE } from './wisp-service'

const KEYCHAIN_SERVICE = 'wispctl'

interface KeyringEntryLike {
	setPassword(password: string): void
	getPassword(): string | null
	deletePassword(): void
}

type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntryLike

interface KeychainProbeResult {
	available: boolean
	detail?: string
	moduleAvailable: boolean
}

let keyringEntryConstructor: KeyringEntryConstructor | null | undefined

async function getKeyringEntryConstructor(): Promise<KeyringEntryConstructor | null> {
	if (keyringEntryConstructor !== undefined) {
		return keyringEntryConstructor
	}
	try {
		const module = await import('@napi-rs/keyring')
		keyringEntryConstructor = module.Entry as KeyringEntryConstructor
	} catch {
		keyringEntryConstructor = null
	}
	return keyringEntryConstructor
}

function formatProbeError(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.message
	}
	if (typeof error === 'string') {
		return error
	}
	return undefined
}

function describeUnavailableKeychain(result: KeychainProbeResult): string {
	if (process.platform === 'darwin') {
		if (!result.moduleAvailable) {
			return 'macOS Keychain support is unavailable in this build.'
		}
		if (result.detail?.toLowerCase().includes('authorization')) {
			return 'macOS Keychain access could not be authorized.'
		}
		return result.detail ? `macOS Keychain access failed: ${result.detail}` : 'macOS Keychain access is unavailable.'
	}

	if (process.platform === 'linux') {
		if (!result.moduleAvailable) {
			return 'System keychain support is unavailable in this build.'
		}
		if (result.detail?.toLowerCase().includes('secret service')) {
			return 'System keychain is unavailable (no Secret Service daemon or equivalent).'
		}
		return result.detail ? `System keychain access failed: ${result.detail}` : 'System keychain is unavailable.'
	}

	if (process.platform === 'win32') {
		if (!result.moduleAvailable) {
			return 'Windows Credential Manager support is unavailable in this build.'
		}
		return result.detail
			? `Windows Credential Manager access failed: ${result.detail}`
			: 'Windows Credential Manager is unavailable.'
	}

	if (!result.moduleAvailable) {
		return 'Secure OS credential storage is unavailable in this build.'
	}
	return result.detail
		? `Secure OS credential storage failed: ${result.detail}`
		: 'Secure OS credential storage is unavailable.'
}

async function probeKeychain(): Promise<KeychainProbeResult> {
	const KeyringEntry = await getKeyringEntryConstructor()
	if (!KeyringEntry) {
		return { available: false, moduleAvailable: false }
	}

	const testKey = '__wispctl_probe__'
	try {
		const entry = new KeyringEntry(KEYCHAIN_SERVICE, testKey)
		entry.setPassword('1')
		entry.deletePassword()
		return { available: true, moduleAvailable: true }
	} catch (error) {
		return {
			available: false,
			detail: formatProbeError(error),
			moduleAvailable: true,
		}
	}
}

const DEFAULT_DB_PATH = join(homedir(), '.config', 'wispctl', 'state.sqlite')

const LOOPBACK_PORT = 4000
const LOOPBACK_HOST = '127.0.0.1'

interface LoopbackPortSelection {
	port: number
	usedFallback: boolean
}

function parsePort(value: string | undefined): number | undefined {
	if (!value) {
		return undefined
	}
	const parsed = Number.parseInt(value, 10)
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
		return undefined
	}
	return parsed
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
	return await new Promise<boolean>((resolve, reject) => {
		const server = createServer()

		server.once('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'EADDRINUSE') {
				resolve(false)
				return
			}
			reject(err)
		})

		server.once('listening', () => {
			server.close((err) => {
				if (err) {
					reject(err)
					return
				}
				resolve(true)
			})
		})

		server.listen({ host, port, exclusive: true })
	})
}

async function findRandomAvailablePort(host: string): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer()

		server.once('error', reject)
		server.once('listening', () => {
			const address = server.address()
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Failed to determine loopback callback port')))
				return
			}

			const port = address.port
			server.close((err) => {
				if (err) {
					reject(err)
					return
				}
				resolve(port)
			})
		})

		server.listen({ host, port: 0, exclusive: true })
	})
}

async function resolveLoopbackPort(preferredPort: number, host: string): Promise<LoopbackPortSelection> {
	if (await isPortAvailable(host, preferredPort)) {
		return { port: preferredPort, usedFallback: false }
	}
	const port = await findRandomAvailablePort(host)
	return { port, usedFallback: true }
}

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
	valuesByPrefix(prefix: string): string[]
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
		const prefixStmt = db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key LIKE ?')
		return {
			get: (key) => getStmt.get(key) ?? undefined,
			set: (key, value, expiresAt) => {
				setStmt.run(key, value, expiresAt)
			},
			del: (key) => {
				delStmt.run(key)
			},
			clear: () => db.run('DELETE FROM kv'),
			valuesByPrefix: (prefix) => prefixStmt.all(`${prefix}%`).map((r) => r.value),
		}
	} else {
		const { DatabaseSync } = await import('node:sqlite')
		const db = new DatabaseSync(dbPath)
		db.exec('PRAGMA journal_mode = WAL')
		db.exec(SCHEMA)
		const getStmt = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?')
		const setStmt = db.prepare('INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)')
		const delStmt = db.prepare('DELETE FROM kv WHERE key = ?')
		const prefixStmt = db.prepare('SELECT value FROM kv WHERE key LIKE ?')
		return {
			get: (key) => getStmt.get(key) as KvRow | undefined,
			set: (key, value, expiresAt) => {
				setStmt.run(key, value, expiresAt)
			},
			del: (key) => {
				delStmt.run(key)
			},
			clear: () => db.exec('DELETE FROM kv'),
			valuesByPrefix: (prefix) => (prefixStmt.all(`${prefix}%`) as { value: string }[]).map((r) => r.value),
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

function createSessionStore(
	kv: KvAdapter,
	keyringEntryConstructor: KeyringEntryConstructor | null,
): NodeSavedSessionStore {
	if (keyringEntryConstructor) {
		return {
			async set(sub, session) {
				new keyringEntryConstructor(KEYCHAIN_SERVICE, sub).setPassword(JSON.stringify(session))
			},
			async get(sub) {
				try {
					const raw = new keyringEntryConstructor(KEYCHAIN_SERVICE, sub).getPassword()
					if (!raw) return undefined
					return JSON.parse(raw) as NodeSavedSession
				} catch {
					return undefined
				}
			},
			async del(sub) {
				try {
					new keyringEntryConstructor(KEYCHAIN_SERVICE, sub).deletePassword()
				} catch {}
			},
		}
	}
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
	forceReauth?: boolean
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
 * Return the subset of `WISP_OAUTH_SCOPE` not present in a token's granted scope.
 *
 * Reused both after a fresh OAuth callback (to warn) and at session restore (to
 * transparently re-auth when a stored token predates an expanded scope set).
 */
function missingScopesFor(grantedScope: string | undefined): string[] {
	const granted = new Set((grantedScope || '').split(/\s+/).filter(Boolean))
	return WISP_OAUTH_SCOPE.split(' ').filter((s) => !granted.has(decodeURIComponent(s)))
}

/**
 * Authenticate with AT Protocol using OAuth loopback flow
 */
export async function authenticateOAuth(
	handle?: string,
	options: AuthOptions = {},
): Promise<{ agent: Agent; did: string }> {
	const kv = await openKv(options.dbPath || DEFAULT_DB_PATH)

	const keychainProbe = await probeKeychain()
	const useKeychain = keychainProbe.available
	const keyringEntryConstructor = useKeychain ? await getKeyringEntryConstructor() : null
	const stateStore = createStateStore(kv)
	const sessionStore = createSessionStore(kv, keyringEntryConstructor)
	const createOAuthClient = (redirectUri: string): NodeOAuthClient => {
		const clientIdParams = new URLSearchParams()
		clientIdParams.append('redirect_uri', redirectUri)
		clientIdParams.append('scope', WISP_OAUTH_SCOPE)
		return new NodeOAuthClient({
			clientMetadata: {
				client_id: `http://localhost?${clientIdParams.toString()}`,
				client_name: 'Wisp CLI',
				client_uri: 'https://wisp.place',
				redirect_uris: [redirectUri],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				application_type: 'web',
				token_endpoint_auth_method: 'none',
				scope: WISP_OAUTH_SCOPE,
				dpop_bound_access_tokens: false,
			},
			stateStore,
			sessionStore,
			requestLock: requestLocalLock,
		})
	}

	// Try to restore the session mapped to the current directory
	const dirKey = `dir:${cwd()}`
	const dirOAuthPortKey = `dir_oauth_port:${cwd()}`
	let oauthPort = parsePort(kvGet(kv, dirOAuthPortKey)) ?? LOOPBACK_PORT
	let redirectUri = `http://${LOOPBACK_HOST}:${oauthPort}/oauth/callback`
	let client = createOAuthClient(redirectUri)
	const storedDid = kvGet(kv, dirKey)
	// Identifier to pass to `client.authorize`. Falls back to the stored DID so a
	// transparent re-auth (missing scopes) never prompts the user for a handle.
	let loginIdentifier = handle
	if (storedDid && options.forceReauth) {
		kv.del(dirKey)
	} else if (storedDid) {
		let canRestore = true
		if (handle) {
			const resolvedDid = await resolveDid(handle)
			if (resolvedDid && resolvedDid !== storedDid) {
				emitStatus(
					options,
					`Stored session is for ${storedDid}, but ${handle} resolves to ${resolvedDid}. Re-authenticating.`,
				)
				kv.del(dirKey)
				canRestore = false
			}
		}
		if (canRestore) {
			try {
				const session = await client.restore(storedDid)
				if (session) {
					// A stored token may predate an expanded scope set (e.g. the
					// privateSite/domain.verify scopes). Re-auth transparently so the
					// subsequent XRPC call doesn't fail with a scope error.
					const tokenInfo = await session.getTokenInfo(false)
					const missingScopes = missingScopesFor(tokenInfo.scope)
					if (missingScopes.length > 0) {
						emitStatus(options, `Stored session is missing ${missingScopes.length} scope(s). Re-authenticating...`)
						kv.del(dirKey)
						canRestore = false
						// Re-auth for the same account without re-prompting.
						loginIdentifier = storedDid
					} else {
						emitStatus(options, `Restored session for ${storedDid}`)
						return { agent: new Agent(session), did: storedDid }
					}
				}
			} catch {
				// Session invalid or expired — clear mapping and re-auth
				kv.del(dirKey)
			}
		}
	}

	// Need an identifier to start a new OAuth flow
	if (!loginIdentifier) {
		throw new Error('No active session for this directory. Run `wispctl login <handle>` first.')
	}

	if (!useKeychain) {
		log.warn(
			`Session tokens will be stored unencrypted in SQLite: ${describeUnavailableKeychain(keychainProbe)} Use --password for headless app-password auth.`,
		)
	}

	const preferredPort = oauthPort
	const portSelection = await resolveLoopbackPort(preferredPort, LOOPBACK_HOST)
	if (portSelection.usedFallback) {
		emitStatus(
			options,
			`OAuth callback port ${preferredPort} is unavailable. Using ${portSelection.port} for this login flow.`,
		)
	}

	if (portSelection.port !== oauthPort) {
		oauthPort = portSelection.port
		redirectUri = `http://${LOOPBACK_HOST}:${oauthPort}/oauth/callback`
		client = createOAuthClient(redirectUri)
	}

	// Start new OAuth flow
	emitStatus(options, `Starting OAuth flow for ${loginIdentifier}...`)

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
				port: oauthPort,
				hostname: LOOPBACK_HOST,
				fetch: app.fetch,
			})
			serverHandle = { close: () => bunServer.stop() }
		} else {
			const nodeServer = honoNodeServe({
				fetch: app.fetch,
				port: oauthPort,
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

	const authUrl = await client.authorize(loginIdentifier, { scope: WISP_OAUTH_SCOPE })

	emitStatus(options, 'Opening browser for authentication...')
	emitStatus(options, `If browser does not open, visit: ${authUrl}`)
	await open(authUrl.toString())

	const { params } = await callbackPromise
	const { session } = await client.callback(params)

	const tokenInfo = await session.getTokenInfo(false)
	const missingScopes = missingScopesFor(tokenInfo.scope)
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
	if (oauthPort === LOOPBACK_PORT) {
		kv.del(dirOAuthPortKey)
	} else {
		kvSet(kv, dirOAuthPortKey, String(oauthPort))
	}

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
	if (options.appPassword !== undefined) {
		const trimmedPassword = options.appPassword.trim()
		if (!trimmedPassword) {
			throw new Error('App password is required when using --password')
		}
		if (!handle) throw new Error('Handle required with app password authentication')
		return authenticateAppPassword(handle, trimmedPassword, undefined, options)
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
		// Delete any keychain entries for DIDs we know about via dir mappings
		const dids = kv.valuesByPrefix('dir:')
		const KeyringEntry = await getKeyringEntryConstructor()
		if (KeyringEntry) {
			for (const did of dids) {
				try {
					new KeyringEntry(KEYCHAIN_SERVICE, did).deletePassword()
				} catch {}
			}
		}
		kv.clear()
		console.log('Cleared all stored OAuth sessions')
	} catch {
		// db doesn't exist yet
	}
}
