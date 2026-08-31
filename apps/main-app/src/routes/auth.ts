import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { createLogger } from '@wispplace/observability'
import { Elysia } from 'elysia'
import { getDomainByDid, getSitesByDid } from '../lib/db'
import {
	authorizeWisp,
	authorizeWispLegacy,
	isLegacyScopeState,
	missingGrantedCapabilities,
	unmarkLegacyScopeState,
} from '../lib/oauth-authorize'
import { authenticateRequest, SESSION_COOKIE_NAME } from '../lib/wisp-auth'
import { resolvePrivateShareState } from './private-redeem'

const logger = createLogger('main-app')

export const authRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		cookie: {
			secrets: cookieSecret,
			sign: [SESSION_COOKIE_NAME],
		},
	})
		/**
		 * GET /api/auth/login
		 * 302 redirect to the AT Protocol OAuth authorize URL.
		 * On error, redirects to /?error=missing_handle or /?error=auth_failed.
		 */
		.get('/api/auth/login', async (c) => {
			// GET endpoint for initiating OAuth via atproto.wisp.place entryway
			// Accepts: login_hint (handle) or pds (server)
			try {
				const query = c.query as { login_hint?: string; pds?: string }
				const handle = query.login_hint || ''
				const pds = query.pds || ''

				// Use login_hint if provided, otherwise use PDS URL
				const identifier = handle || (pds ? `https://${pds}` : '')

				if (!identifier) {
					logger.error('Login attempt with no login_hint or pds')
					return c.redirect('/?error=missing_handle')
				}

				logger.info('Login attempt via entryway', { identifier })
				const state = crypto.randomUUID()
				const url = await authorizeWisp(client, identifier, { state })
				logger.info('Authorization URL generated', { identifier })

				// Redirect to the OAuth authorization URL
				return c.redirect(url.toString())
			} catch (err) {
				logger.error('Login error', err)
				return c.redirect('/?error=auth_failed')
			}
		})
		/**
		 * POST /api/auth/signin
		 * Success: { url } where url is the OAuth authorize URL.
		 * Failure: { error, details }.
		 */
		.post('/api/auth/signin', async (c) => {
			let handle = 'unknown'
			try {
				const body = c.body as { handle: string }
				handle = body.handle
				logger.info('Sign-in attempt', { handle })
				const state = crypto.randomUUID()
				const url = await authorizeWisp(client, handle, { state })
				logger.info('Authorization URL generated', { handle })
				return { url: url.toString() }
			} catch (err) {
				logger.error('Signin error', err, { handle })
				c.set.status = 401
				return { error: 'Authentication failed', details: 'Unable to start authentication' }
			}
		})
		/**
		 * GET /api/auth/callback
		 * 302 redirect to /onboarding (new users) or /editor (existing users).
		 * On error, redirects to /?error=auth_failed.
		 */
		.get('/api/auth/callback', async (c) => {
			try {
				const params = new URLSearchParams(c.query)

				// client.callback() validates the state parameter internally
				// It will throw an error if state validation fails (CSRF protection)
				const { session, state } = await client.callback(params)

				if (!session) {
					logger.error('[Auth] OAuth callback failed: no session returned')
					c.cookie[SESSION_COOKIE_NAME].remove()
					return c.redirect('/?error=auth_failed')
				}

				const cookieSession = c.cookie
				cookieSession[SESSION_COOKIE_NAME].set({
					value: session.did,
					httpOnly: true,
					secure: process.env.NODE_ENV === 'production',
					sameSite: 'lax',
					path: '/',
					maxAge: 30 * 24 * 60 * 60, // 30 days
				})

				// An authorization server that predates permission sets accepts the
				// `include:place.wisp.*` values and then drops them, leaving a session
				// that can not write records. Retry once with the granular expansion.
				const missing = await missingGrantedCapabilities(session)
				if (missing.length > 0) {
					if (!isLegacyScopeState(state)) {
						logger.warn('[Auth] Permission sets were not granted, retrying with granular scopes', {
							did: session.did,
							missing,
						})
						const retryUrl = await authorizeWispLegacy(client, session.did, state)
						return c.redirect(retryUrl.toString())
					}
					logger.error('[Auth] Session is missing required permissions', { did: session.did, missing })
				}

				// Revalidate the OAuth state token before returning a share visitor to its site.
				const redeem = await resolvePrivateShareState(unmarkLegacyScopeState(state), session.did)
				if (redeem) {
					return c.redirect(redeem.url ?? '/private/denied')
				}

				// Check if user has any cached sites or a claimed domain
				const sites = await getSitesByDid(session.did)
				const domain = await getDomainByDid(session.did)

				// If no sites and no domain, redirect to onboarding
				if (sites.length === 0 && !domain) {
					return c.redirect('/onboarding')
				}

				return c.redirect('/editor')
			} catch (err) {
				// This catches state validation failures and other OAuth errors
				logger.error('[Auth] OAuth callback error', err)
				c.cookie[SESSION_COOKIE_NAME].remove()
				return c.redirect('/?error=auth_failed')
			}
		})
		/**
		 * POST /api/auth/logout
		 * Success: { success: true }
		 * Failure: { error: 'Logout failed' }
		 */
		.post('/api/auth/logout', async (c) => {
			try {
				const cookieSession = c.cookie
				const did = cookieSession[SESSION_COOKIE_NAME]?.value

				// Clear the session cookie
				cookieSession[SESSION_COOKIE_NAME].remove()

				// If we have a DID, try to revoke the OAuth session
				if (did && typeof did === 'string') {
					try {
						await client.revoke(did)
						logger.debug('[Auth] Revoked OAuth session for', did as any)
					} catch (err) {
						logger.error('[Auth] Failed to revoke session', err)
						// Continue with logout even if revoke fails
					}
				}

				return { success: true }
			} catch (err) {
				logger.error('[Auth] Logout error', err)
				c.set.status = 500
				return { error: 'Logout failed' }
			}
		})
		/**
		 * GET /api/auth/status
		 * Authenticated: { authenticated: true, did }
		 * Not authenticated: { authenticated: false }
		 */
		.get('/api/auth/status', async (c) => {
			try {
				const auth = await authenticateRequest(client, c.cookie, c.request.headers.get('cookie'))

				if (!auth) {
					c.cookie[SESSION_COOKIE_NAME].remove()
					return { authenticated: false }
				}

				return {
					authenticated: true,
					did: auth.did,
				}
			} catch (err) {
				logger.error('[Auth] Status check error', err)
				c.cookie[SESSION_COOKIE_NAME].remove()
				return { authenticated: false }
			}
		})
