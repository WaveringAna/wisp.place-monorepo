import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { createLogger } from '@wispplace/observability'
import { Elysia } from 'elysia'
import { eventualRead } from '../lib/db'
import {
	authorizeWisp,
	authorizeWispLegacy,
	grantedAddOns,
	isLegacyScopeState,
	isScopeAddOn,
	missingGrantedCapabilities,
	setupAddOn,
	setupState,
	setupTab,
	stateValue,
	unmarkLegacyScopeState,
} from '../lib/oauth-authorize'
import { backfillSitesFromPds } from '../lib/pds-backfill'
import { authenticateRequest, invalidateSessionCache, SESSION_COOKIE_NAME } from '../lib/wisp-auth'
import { resolvePrivateShareState } from './private-redeem'

const logger = createLogger('main-app')

/** A custom domain id, as carried through `state` back into the dashboard's url. */
const DOMAIN_ID = /^[\w-]{1,64}$/

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
		 * Accepts login_hint (handle or DID) or pds (server host), and
		 * prompt=create to open the server's sign-up page instead of its login.
		 * On error, redirects to /?error=missing_handle or /?error=auth_failed.
		 */
		.get('/api/auth/login', async (c) => {
			try {
				const query = c.query as { login_hint?: string; pds?: string; prompt?: string }
				const handle = query.login_hint || ''
				const pds = query.pds || ''
				const prompt = query.prompt === 'create' ? 'create' : undefined

				// Use login_hint if provided, otherwise use PDS URL
				const identifier = handle || (pds ? `https://${pds}` : '')

				if (!identifier) {
					logger.error('Login attempt with no login_hint or pds')
					return c.redirect('/?error=missing_handle')
				}

				logger.info('Login attempt', { identifier, prompt })
				const state = crypto.randomUUID()
				const url = await authorizeWisp(client, identifier, prompt ? { state, prompt } : { state })
				logger.info('Authorization URL generated', { identifier })

				return c.redirect(url.toString())
			} catch (err) {
				logger.error('Login error', err)
				return c.redirect('/?error=auth_failed')
			}
		})
		/**
		 * GET /api/auth/setup/:addOn
		 * Signs the current user in again, also asking for an add-on permission
		 * (`ci`: secrets on tangled spindles, `marque`: their marque.at dns), and
		 * lands back on the dashboard tab that needed it. `?domain=<id>` reopens
		 * that custom domain's dns dialog.
		 */
		.get('/api/auth/setup/:addOn', async (c) => {
			const { addOn } = c.params
			if (!isScopeAddOn(addOn)) return c.redirect('/editor')
			const auth = await authenticateRequest(client, c.cookie, c.request.headers.get('cookie'))
			if (!auth) return c.redirect('/')
			const domain = (c.query as { domain?: string }).domain
			const extra: Record<string, string> = domain && DOMAIN_ID.test(domain) ? { domain } : {}
			try {
				const state = setupState(addOn, await grantedAddOns(auth.session), extra)
				const url = await authorizeWisp(client, auth.did, { state })
				return c.redirect(url.toString())
			} catch (err) {
				logger.error('[Auth] Add-on authorization failed', err, { addOn })
				return c.redirect(`/editor?error=setup_failed#${setupTab(addOn)}`)
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

				// A new grant supersedes whatever this node last restored for the DID.
				invalidateSessionCache(session.did)

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

				const addOn = setupAddOn(state)
				if (addOn) {
					const domain = stateValue(state, 'domain')
					const query = domain && DOMAIN_ID.test(domain) ? `?dns=${domain}` : ''
					return c.redirect(`/editor${query}#${setupTab(addOn)}`)
				}

				// Revalidate the OAuth state token before returning a share visitor to its site.
				const redeem = await resolvePrivateShareState(unmarkLegacyScopeState(state), session.did)
				if (redeem) {
					return c.redirect(redeem.url ?? '/private/denied')
				}

				// Sites deployed while the firehose was not watching (or before this
				// account first signed in) only reach site_cache once revalidated.
				const backfill = backfillSitesFromPds(session.did, session).catch((err) => {
					logger.error('[Auth] PDS backfill failed', err)
					return null
				})

				// Which page to land on is presentation, not authorization, so it reads
				// the local replica. Both lookups used to go to the primary, which from
				// a distant region cost two more round trips on the sign-in path than
				// the choice of redirect is worth.
				const { sites, domain } = await eventualRead.getUserStatus(session.did)
				if (sites.length > 0 || domain) return c.redirect('/editor')

				// Nothing cached yet: only a PDS with no sites at all means a new user.
				const found = (await backfill)?.found ?? 0
				return c.redirect(found > 0 ? '/editor' : '/onboarding')
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
					// Drop the cached session first: a concurrent request must not be
					// handed a session this logout is about to revoke.
					invalidateSessionCache(did)
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
