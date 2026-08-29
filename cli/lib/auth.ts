import { createServer } from 'node:net'
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
import { resolvePdsFromHandle } from '@wispplace/atproto-utils'
import { isBun } from '@wispplace/bun-firehose'
import { describeCapability, missingCapabilities, wispCliRequiredCapabilities } from '@wispplace/constants'
import { Hono } from 'hono'
import open from 'open'
import {
	type AuthMethod,
	backfillHandle,
	clearDirDid,
	deleteAccount,
	deleteStoredAppPassword,
	deleteStoredOAuthSession,
	describeUnavailableKeychain,
	getDirDid,
	getStoredAppPassword,
	getStoredOAuthSession,
	type KvAdapter,
	kvGet,
	kvSet,
	listAccounts,
	listDirsForDid,
	normalizeHandle,
	type OAuthScopeStrategy,
	openAccountStore,
	probeKeychain,
	readAccount,
	resolveAccountForDir,
	resolveIdentifierToDid,
	type StoredAccount,
	setDefaultDid,
	setDirDid,
	setStoredAppPassword,
	setStoredOAuthSession,
	upsertAccount,
} from './account-store.ts'
import { WISP_OAUTH_LEGACY_SCOPE, WISP_OAUTH_SCOPE } from './wisp-service'

/** Public resolvers used only when the system nameservers fail to answer. */
const FALLBACK_NAMESERVERS = ['1.1.1.1', '8.8.8.8']

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

function createSessionStore(kv: KvAdapter, useKeychain: boolean): NodeSavedSessionStore {
	if (useKeychain) {
		return {
			async set(sub, session) {
				await setStoredOAuthSession(sub, JSON.stringify(session))
			},
			async get(sub) {
				const raw = await getStoredOAuthSession(sub)
				if (!raw) return undefined
				try {
					return JSON.parse(raw) as NodeSavedSession
				} catch {
					return undefined
				}
			},
			async del(sub) {
				await deleteStoredOAuthSession(sub)
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
 * The account a bare command in this directory would authenticate as, if any.
 *
 * Used by callers to decide whether they still need to prompt for a handle.
 */
export async function resolveAccountForCwd(dbPath?: string): Promise<StoredAccount | undefined> {
	try {
		const kv = await openAccountStore(dbPath)
		return resolveAccountForDir(kv)
	} catch {
		return undefined
	}
}

/**
 * Return the capabilities the CLI needs that a token's granted scope lacks.
 *
 * The granted scope is always the *expanded* granular form — an authorization
 * server rewrites `include:place.wisp.authSites` into the `repo:`/`rpc:` values
 * the permission set contains before minting the token — so this compares
 * meaning rather than scope strings. Reused after a fresh OAuth callback (to
 * detect a server that ignored the permission sets) and at session restore (to
 * transparently re-auth when a stored token predates a widened scope set).
 */
function missingScopesFor(grantedScope: string | undefined) {
	return missingCapabilities(grantedScope, wispCliRequiredCapabilities())
}

/**
 * Authenticate with AT Protocol using OAuth loopback flow
 */
export async function authenticateOAuth(
	handle?: string,
	options: AuthOptions = {},
): Promise<{ agent: Agent; did: string }> {
	const kv = await openAccountStore(options.dbPath)

	const keychainProbe = await probeKeychain()
	const useKeychain = keychainProbe.available
	const stateStore = createStateStore(kv)
	const sessionStore = createSessionStore(kv, useKeychain)
	// A loopback client declares its scopes inside the `client_id`, so declaring
	// both strategies at once would double the length of every authorization URL
	// the user sees. Build one client per strategy instead and only reach for the
	// granular one if the permission sets are refused.
	const scopeFor = (strategy: OAuthScopeStrategy) =>
		strategy === 'granular' ? WISP_OAUTH_LEGACY_SCOPE : WISP_OAUTH_SCOPE

	const createOAuthClient = (redirectUri: string, strategy: OAuthScopeStrategy = 'sets'): NodeOAuthClient => {
		const scope = scopeFor(strategy)
		const clientIdParams = new URLSearchParams()
		clientIdParams.append('redirect_uri', redirectUri)
		clientIdParams.append('scope', scope)
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
				scope,
				dpop_bound_access_tokens: false,
			},
			stateStore,
			sessionStore,
			requestLock: requestLocalLock,
			// A handle with no /.well-known/atproto-did has DNS as its only route,
			// so one flaky system resolver is enough to fail a login outright.
			// These are consulted only after the system resolver gives nothing.
			fallbackNameservers: FALLBACK_NAMESERVERS,
		})
	}

	// Work out which account this invocation is for. An explicit handle or DID
	// wins; otherwise fall back to the directory mapping, then the chosen
	// default, then a lone stored account.
	const dirOAuthPortKey = `dir_oauth_port:${cwd()}`
	let oauthPort = parsePort(kvGet(kv, dirOAuthPortKey)) ?? LOOPBACK_PORT
	let redirectUri = `http://${LOOPBACK_HOST}:${oauthPort}/oauth/callback`
	let client = createOAuthClient(redirectUri)

	let targetDid: string | undefined
	// Identifier to pass to `client.authorize`. Falls back to the known DID so a
	// transparent re-auth (missing scopes) never prompts the user for a handle.
	let loginIdentifier = handle

	if (handle) {
		// A failed resolve is not fatal: the OAuth authorization server resolves
		// the identifier itself. Losing the lookup only costs us the chance to
		// reuse a stored session, so fall through to the browser flow instead of
		// blocking login on our own identity resolver.
		targetDid = (await resolveIdentifierToDid(kv, handle)) ?? undefined
	} else {
		const dirAccount = resolveAccountForDir(kv)
		targetDid = dirAccount?.did
		loginIdentifier = dirAccount?.handle ?? dirAccount?.did
	}

	// Record the account against this directory so the next bare command here
	// resolves without a handle, and remember the handle for display.
	const finish = async (
		agent: Agent,
		did: string,
		method: AuthMethod,
		oauthScope?: OAuthScopeStrategy,
	): Promise<{ agent: Agent; did: string }> => {
		const explicitHandle = handle && !handle.startsWith('did:') ? normalizeHandle(handle) : undefined
		upsertAccount(kv, did, {
			handle: explicitHandle,
			handleChecked: explicitHandle ? true : undefined,
			method,
			oauthScope,
		})
		setDirDid(kv, did)
		await backfillHandle(kv, did)
		return { agent, did }
	}

	if (targetDid && options.forceReauth) {
		loginIdentifier = handle ?? targetDid
	} else if (targetDid) {
		const accountDid = targetDid
		const account = readAccount(kv, accountDid)
		const label = account?.handle ?? accountDid

		const tryOAuth = async (): Promise<{ agent: Agent; did: string } | undefined> => {
			try {
				// The stored session belongs to whichever client_id minted it, and a
				// loopback client_id contains its scopes — so restore through the same
				// strategy or the refresh is rejected as a different client.
				const restoreClient =
					account?.oauthScope && account.oauthScope !== 'sets'
						? createOAuthClient(redirectUri, account.oauthScope)
						: client
				const session = await restoreClient.restore(accountDid)
				if (!session) return undefined
				// A stored token may predate an expanded scope set (e.g. the
				// privateSite/domain.verify scopes). Re-auth transparently so the
				// subsequent XRPC call doesn't fail with a scope error.
				const tokenInfo = await session.getTokenInfo(false)
				const missingScopes = missingScopesFor(tokenInfo.scope)
				if (missingScopes.length > 0) {
					emitStatus(options, `Stored session is missing ${missingScopes.length} scope(s). Re-authenticating...`)
					return undefined
				}
				emitStatus(options, `Restored session for ${label}`)
				return await finish(new Agent(session), accountDid, 'oauth')
			} catch {
				// Session invalid or expired — fall through to the next credential.
				return undefined
			}
		}

		const tryAppPassword = async (): Promise<{ agent: Agent; did: string } | undefined> => {
			const password = await getStoredAppPassword(accountDid)
			if (!password) return undefined
			try {
				const { agent, did } = await authenticateAppPassword(account?.handle ?? accountDid, password, account?.pdsUrl, {
					...options,
					onStatus: () => {},
				})
				if (did !== accountDid) {
					emitWarning(options, `Stored app password authenticated as ${did}, expected ${accountDid}; ignoring it.`)
					return undefined
				}
				emitStatus(options, `Restored app password session for ${label}`)
				return await finish(agent, did, 'app-password')
			} catch {
				emitWarning(options, `Stored app password for ${label} was rejected.`)
				return undefined
			}
		}

		const attempts = account?.method === 'app-password' ? [tryAppPassword, tryOAuth] : [tryOAuth, tryAppPassword]
		for (const attempt of attempts) {
			const restored = await attempt()
			if (restored) return restored
		}

		// Nothing stored worked — re-auth for the same account without re-prompting.
		loginIdentifier = handle ?? accountDid
	}

	// Need an identifier to start a new OAuth flow
	if (!loginIdentifier) {
		throw new Error('No stored account. Run `wispctl login <handle>` first.')
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

	const createCallbackServer = (): Promise<{ params: URLSearchParams }> =>
		new Promise<{ params: URLSearchParams }>((resolve, reject) => {
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

	// `loginIdentifier` is checked above; capture it so the closures below keep
	// the narrowed type.
	const identifier = loginIdentifier

	const completeFlow = async (authUrl: URL) => {
		const callbackPromise = createCallbackServer()
		emitStatus(options, 'Opening browser for authentication...')
		emitStatus(options, `If browser does not open, visit: ${authUrl}`)
		await open(authUrl.toString())
		const { params } = await callbackPromise
		return await client.callback(params)
	}

	// Prefer the published permission sets. A server that cannot resolve them
	// rejects the pushed authorization request outright, so fall straight back
	// to the granular expansion.
	let strategy: OAuthScopeStrategy = 'sets'
	const useGranular = async (): Promise<URL> => {
		strategy = 'granular'
		client = createOAuthClient(redirectUri, 'granular')
		return await client.authorize(identifier, { scope: scopeFor('granular') })
	}

	let authUrl: URL
	try {
		authUrl = await client.authorize(identifier, { scope: scopeFor('sets') })
	} catch (err) {
		emitWarning(
			options,
			`Authorization server rejected the wisp.place permission sets (${err instanceof Error ? err.message : String(err)}). Falling back to granular scopes.`,
		)
		authUrl = await useGranular()
	}

	let { session } = await completeFlow(authUrl)
	let tokenInfo = await session.getTokenInfo(false)
	let missingScopes = missingScopesFor(tokenInfo.scope)

	// An older authorization server accepts the request but silently drops the
	// `include:` values it does not understand, leaving a session that can not
	// write anything. That only shows up in the granted scope.
	if (missingScopes.length > 0 && strategy === 'sets') {
		emitWarning(
			options,
			'Authorization server ignored the wisp.place permission sets. Retrying with granular scopes...',
		)
		await sessionStore.del(session.did)
		;({ session } = await completeFlow(await useGranular()))
		tokenInfo = await session.getTokenInfo(false)
		missingScopes = missingScopesFor(tokenInfo.scope)
	}

	if (missingScopes.length > 0) {
		emitWarning(
			options,
			`OAuth token is missing ${missingScopes.length} requested permission(s). First missing: ${describeCapability(missingScopes[0])}`,
		)
	}

	const agent = new Agent(session)
	const did = session.did
	if (targetDid && did !== targetDid) {
		await sessionStore.del(did)
		throw new Error(`Authenticated account ${did} does not match the requested account ${targetDid}`)
	}

	if (oauthPort === LOOPBACK_PORT) {
		kv.del(dirOAuthPortKey)
	} else {
		kvSet(kv, dirOAuthPortKey, String(oauthPort))
	}

	const result = await finish(agent, did, 'oauth', strategy)

	emitStatus(options, `Authenticated as ${did}`)

	return result
}

/**
 * Authenticate with AT Protocol using app password (for CI/headless)
 */
export async function authenticateAppPassword(
	identifier: string,
	password: string,
	pdsUrl?: string,
	options: AuthOptions = {},
): Promise<{ agent: Agent; did: string; serviceUrl: string }> {
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

	return { agent, did, serviceUrl }
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

	// Env fallback keeps the secret out of argv (and the process table) in CI.
	// Unlike `--password` it is opportunistic: with no handle to log in as, fall
	// through to the normal stored-credential cascade.
	const envPassword = process.env.WISPCTL_APP_PASSWORD?.trim()
	if (envPassword && handle) {
		return authenticateAppPassword(handle, envPassword, undefined, options)
	}

	return authenticateOAuth(handle, options)
}

/**
 * Log in with an app password and persist it for use from any directory.
 */
export async function loginWithAppPassword(
	handle: string,
	password: string,
	options: AuthOptions = {},
): Promise<{ did: string; handle: string; stored: boolean; keychainDetail?: string }> {
	const trimmed = password.trim()
	if (!trimmed) {
		throw new Error('App password is required')
	}

	const kv = await openAccountStore(options.dbPath)
	const { did, serviceUrl } = await authenticateAppPassword(handle, trimmed, undefined, options)

	upsertAccount(kv, did, {
		handle: handle.startsWith('did:') ? undefined : normalizeHandle(handle),
		handleChecked: handle.startsWith('did:') ? undefined : true,
		method: 'app-password',
		pdsUrl: serviceUrl,
	})
	setDirDid(kv, did)
	const stored = await setStoredAppPassword(did, trimmed)
	const resolvedHandle = (await backfillHandle(kv, did)) ?? handle

	let keychainDetail: string | undefined
	if (!stored) {
		keychainDetail = describeUnavailableKeychain(await probeKeychain())
	}

	return { did, handle: resolvedHandle, stored, keychainDetail }
}

/** Find a stored account by handle or DID, refreshing stale handle aliases. */
async function findAccount(kv: KvAdapter, identifier: string): Promise<StoredAccount | undefined> {
	if (identifier.startsWith('did:')) {
		return readAccount(kv, identifier)
	}

	const did = await resolveIdentifierToDid(kv, normalizeHandle(identifier))
	return did ? readAccount(kv, did) : undefined
}

export interface AccountListing extends StoredAccount {
	hasCredential: boolean
	dirs: string[]
	isDefault: boolean
	isCurrentDir: boolean
}

async function hasStoredCredential(kv: KvAdapter, did: string): Promise<boolean> {
	if (await getStoredOAuthSession(did)) return true
	if (await getStoredAppPassword(did)) return true
	return kvGet(kv, `oauth_session:${did}`) !== undefined
}

export async function listStoredAccounts(dbPath?: string): Promise<AccountListing[]> {
	const kv = await openAccountStore(dbPath)
	const defaultDid = kvGet(kv, 'default_account')
	const currentDirDid = getDirDid(kv)

	return await Promise.all(
		listAccounts(kv).map(async (account) => ({
			...account,
			// Accounts carried over from directory-only mappings have no handle
			// yet. Resolve it once here so the listing reads as names rather than
			// DIDs; a failure just leaves the DID showing.
			handle: account.handle ?? (await backfillHandle(kv, account.did)),
			hasCredential: await hasStoredCredential(kv, account.did),
			dirs: listDirsForDid(kv, account.did),
			isDefault: account.did === defaultDid,
			isCurrentDir: account.did === currentDirDid,
		})),
	)
}

/** Choose the account used by bare commands in directories with no mapping. */
export async function setDefaultAccount(identifier: string, dbPath?: string): Promise<StoredAccount> {
	const kv = await openAccountStore(dbPath)
	const account = await findAccount(kv, identifier)
	if (!account) {
		throw new Error(`No stored account for ${identifier}. Run \`wispctl login ${identifier}\` first.`)
	}
	setDefaultDid(kv, account.did)
	return account
}

/**
 * Forget one account everywhere: keychain credentials, the account record, and
 * every directory still pointing at it.
 */
export async function logoutAccount(identifier: string, dbPath?: string): Promise<StoredAccount | undefined> {
	const kv = await openAccountStore(dbPath)
	const account = await findAccount(kv, identifier)
	if (!account) return undefined

	await deleteStoredOAuthSession(account.did)
	await deleteStoredAppPassword(account.did)
	kv.del(`oauth_session:${account.did}`)
	deleteAccount(kv, account.did)

	return account
}

/**
 * Unlink the current directory from its account (credentials stay in the
 * keychain for use elsewhere).
 */
export async function clearDirSession(dbPath?: string) {
	try {
		const kv = await openAccountStore(dbPath)
		clearDirDid(kv)
		console.log('Unlinked the current directory (stored credentials kept)')
	} catch {
		// db doesn't exist yet
	}
}

/**
 * Clear every stored account and credential
 */
export async function clearSessions(dbPath?: string) {
	try {
		const kv = await openAccountStore(dbPath)
		const dids = new Set(listAccounts(kv).map((account) => account.did))
		// Legacy installs may have directory mappings with no account record yet.
		for (const { value } of kv.entriesByPrefix('dir:')) {
			if (value.startsWith('did:')) dids.add(value)
		}
		for (const did of dids) {
			await deleteStoredOAuthSession(did)
			await deleteStoredAppPassword(did)
		}
		kv.clear()
		console.log('Cleared all stored accounts and credentials')
	} catch {
		// db doesn't exist yet
	}
}
