import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
import { parseServiceDid } from './wisp-service.ts'

const REQUIRED_BASE_SCOPE = 'atproto'
const REPO_BLOB_SCOPES = [
	'repo:place.wisp.fs',
	'repo:place.wisp.subfs',
	'repo:place.wisp.settings',
	'blob:*/*',
] as const

// Default session store path
const DEFAULT_STORE_PATH = join(homedir(), '.wisp', 'oauth-session.json')

// Loopback server config
const LOOPBACK_PORT = 4000
const LOOPBACK_HOST = '127.0.0.1'

interface StoredData {
	states: Record<string, NodeSavedState>
	sessions: Record<string, NodeSavedSession>
}

function ensureDir(filePath: string) {
	const dir = dirname(resolve(filePath))
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
}

function loadStore(storePath: string): StoredData {
	if (!existsSync(storePath)) {
		return { states: {}, sessions: {} }
	}
	try {
		const content = readFileSync(storePath, 'utf-8')
		return JSON.parse(content)
	} catch {
		return { states: {}, sessions: {} }
	}
}

function saveStore(storePath: string, data: StoredData) {
	ensureDir(storePath)
	writeFileSync(storePath, JSON.stringify(data, null, 2))
}

function createStateStore(storePath: string): NodeSavedStateStore {
	return {
		async set(key: string, state: NodeSavedState) {
			const data = loadStore(storePath)
			data.states[key] = state
			saveStore(storePath, data)
		},
		async get(key: string) {
			const data = loadStore(storePath)
			return data.states[key]
		},
		async del(key: string) {
			const data = loadStore(storePath)
			delete data.states[key]
			saveStore(storePath, data)
		},
	}
}

function createSessionStore(storePath: string): NodeSavedSessionStore {
	return {
		async set(sub: string, session: NodeSavedSession) {
			const data = loadStore(storePath)
			data.sessions[sub] = session
			saveStore(storePath, data)
		},
		async get(sub: string) {
			const data = loadStore(storePath)
			return data.sessions[sub]
		},
		async del(sub: string) {
			const data = loadStore(storePath)
			delete data.sessions[sub]
			saveStore(storePath, data)
		},
	}
}

export interface AuthOptions {
	storePath?: string
	appPassword?: string
	serviceDid?: string
	requiredLxms?: readonly string[]
	includeRepoBlobScopes?: boolean
	onStatus?: (message: string) => void
}

function buildOAuthScope(options: AuthOptions = {}): string {
	const requestedLxms = options.requiredLxms ?? []
	const rpcScopes = requestedLxms.map((lxm) => `rpc:${lxm}?aud=*`)
	if (options.serviceDid) {
		parseServiceDid(options.serviceDid)
	}

	const scopes = [REQUIRED_BASE_SCOPE]
	if (options.includeRepoBlobScopes !== false) {
		scopes.push(...REPO_BLOB_SCOPES)
	}
	scopes.push(...rpcScopes)

	return scopes.join(' ')
}

function normalizeScopeToken(scope: string): string {
	try {
		return decodeURIComponent(scope)
	} catch {
		return scope
	}
}

function findMissingScopes(grantedScope: string | undefined, requiredScope: string): string[] {
	const granted = new Set((grantedScope || '').split(/\s+/).filter(Boolean).map(normalizeScopeToken))
	const required = requiredScope.split(/\s+/).filter(Boolean).map(normalizeScopeToken)

	return required.filter((scope) => !granted.has(scope))
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
 * Authenticate with AT Protocol using OAuth loopback flow
 */
export async function authenticateOAuth(
	handle: string,
	options: AuthOptions = {},
): Promise<{ agent: Agent; did: string }> {
	const storePath = options.storePath || DEFAULT_STORE_PATH
	const oauthScope = buildOAuthScope(options)

	// Build loopback client metadata
	const redirectUri = `http://${LOOPBACK_HOST}:${LOOPBACK_PORT}/oauth/callback`
	const clientIdParams = new URLSearchParams()
	clientIdParams.append('redirect_uri', redirectUri)
	clientIdParams.append('scope', oauthScope)

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
			scope: oauthScope,
			dpop_bound_access_tokens: false,
		},
		stateStore: createStateStore(storePath),
		sessionStore: createSessionStore(storePath),
		requestLock: requestLocalLock,
	})

	// Try to restore existing session
	const data = loadStore(storePath)
	const existingSessions = Object.keys(data.sessions)

	// Check if we have a session for this handle's DID
	for (const sub of existingSessions) {
		try {
			const session = await client.restore(sub)
			if (session) {
				// Verify session is still valid
				const agent = new Agent(session)
				const profile = await agent.getProfile({ actor: sub })

				// Check if this is the handle we want
				if (profile.data.handle === handle || sub === handle) {
					const tokenInfo = await session.getTokenInfo(false)
					const missingScopes = findMissingScopes(tokenInfo.scope, oauthScope)
					if (missingScopes.length > 0) {
						continue
					}

					emitStatus(options, `Restored session for ${profile.data.handle}`)
					return { agent, did: sub }
				}
			}
		} catch {
			// Session invalid, continue
		}
	}

	// Start new OAuth flow
	emitStatus(options, `Starting OAuth flow for ${handle}...`)

	// Create loopback server to receive callback
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

			// Close server after receiving callback
			setTimeout(() => serverHandle?.close(), 100)

			resolve({ params })

			return c.html(successHtml)
		})

		app.all('*', (c) => c.text('Not found', 404))

		// Start server based on runtime
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

		// Timeout after 5 minutes
		timeoutHandle = setTimeout(
			() => {
				if (settled) {
					return
				}
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

	// Get authorization URL
	const authUrl = await client.authorize(handle, {
		scope: oauthScope,
	})

	// Open browser
	emitStatus(options, 'Opening browser for authentication...')
	emitStatus(options, `If browser does not open, visit: ${authUrl}`)
	await open(authUrl.toString())

	// Wait for callback
	const { params } = await callbackPromise

	// Handle callback
	const { session } = await client.callback(params)
	const tokenInfo = await session.getTokenInfo(false)
	const missingScopes = findMissingScopes(tokenInfo.scope, oauthScope)
	if (missingScopes.length > 0) {
		emitWarning(
			options,
			`OAuth token is missing requested scopes (${missingScopes.length}). First missing scope: ${missingScopes[0]}`,
		)
	}

	const agent = new Agent(session)
	const did = session.did

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
		// Resolve the handle to find the correct PDS
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
export async function authenticate(handle: string, options: AuthOptions = {}): Promise<{ agent: Agent; did: string }> {
	if (options.appPassword) {
		return authenticateAppPassword(handle, options.appPassword, undefined, options)
	}
	return authenticateOAuth(handle, options)
}

/**
 * Clear stored OAuth sessions
 */
export function clearSessions(storePath?: string) {
	const path = storePath || DEFAULT_STORE_PATH
	if (existsSync(path)) {
		unlinkSync(path)
		console.log('Cleared stored OAuth sessions')
	}
}
