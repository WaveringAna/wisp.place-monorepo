import { Elysia, t } from 'elysia'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { getSitesByDid, getDomainByDid, getCookieSecret } from '../lib/db'
import { syncSitesFromPDS } from '../lib/sync-sites'
import { authenticateRequest } from '../lib/wisp-auth'
import { logger } from '../lib/observability'

export const authRoutes = (client: NodeOAuthClient, cookieSecret: string) => new Elysia({
		cookie: {
			secrets: cookieSecret,
			sign: ['did']
		}
	})
	.post('/api/auth/signin', async (c) => {
		let handle = 'unknown'
		try {
			const body = c.body as { handle: string }
			handle = body.handle
			logger.info('Sign-in attempt', { handle })
			const state = crypto.randomUUID()
			const url = await client.authorize(handle, { state })
			logger.info('Authorization URL generated', { handle })
			return { url: url.toString() }
		} catch (err) {
			logger.error('Signin error', err, { handle })
			console.error('[Auth] Full error:', err)
			return  { error: 'Authentication failed', details: err instanceof Error ? err.message : String(err) }
		}
	})
	.get('/api/auth/callback', async (c) => {
		try {
			const params = new URLSearchParams(c.query)

			// client.callback() validates the state parameter internally
			// It will throw an error if state validation fails (CSRF protection)
			const { session } = await client.callback(params)

			if (!session) {
				logger.error('[Auth] OAuth callback failed: no session returned')
				c.cookie.did.remove()
				return c.redirect('/?error=auth_failed')
			}

			const cookieSession = c.cookie
			cookieSession.did.set({
				value: session.did,
				httpOnly: true,
				secure: process.env.NODE_ENV === 'production',
				sameSite: 'lax',
				maxAge: 30 * 24 * 60 * 60 // 30 days
			})

			// Sync sites from PDS to database cache
			logger.debug('[Auth] Syncing sites from PDS for', session.did as any)
			try {
				const syncResult = await syncSitesFromPDS(session.did, session)
				logger.debug(`[Auth] Sync complete: ${syncResult.synced} sites synced`)
				if (syncResult.errors.length > 0) {
					logger.debug('[Auth] Sync errors:', syncResult.errors)
				}
			} catch (err) {
				logger.error('[Auth] Failed to sync sites', err)
				// Don't fail auth if sync fails, just log it
			}

			// Check if user has any sites or domain
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
			c.cookie.did.remove()
			return c.redirect('/?error=auth_failed')
		}
	})
	.post('/api/auth/logout', async (c) => {
		try {
			const cookieSession = c.cookie
			const did = cookieSession.did?.value

			// Clear the session cookie
			cookieSession.did.remove()

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
			return { error: 'Logout failed' }
		}
	})
	.get('/api/auth/status', async (c) => {
		try {
			const auth = await authenticateRequest(client, c.cookie)

			if (!auth) {
				c.cookie.did.remove()
				return { authenticated: false }
			}

			return {
				authenticated: true,
				did: auth.did
			}
		} catch (err) {
			logger.error('[Auth] Status check error', err)
			c.cookie.did.remove()
			return { authenticated: false }
		}
	})
