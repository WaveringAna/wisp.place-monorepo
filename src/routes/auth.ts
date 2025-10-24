import { Elysia } from 'elysia'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { getSitesByDid, getDomainByDid } from '../lib/db'
import { syncSitesFromPDS } from '../lib/sync-sites'
import { authenticateRequest } from '../lib/wisp-auth'

export const authRoutes = (client: NodeOAuthClient) => new Elysia()
	.post('/api/auth/signin', async (c) => {
		try {
			const { handle } = await c.request.json()
			const state = crypto.randomUUID()
			const url = await client.authorize(handle, { state })
			return { url: url.toString() }
		} catch (err) {
			console.error('Signin error', err)
			return  { error: 'Authentication failed' }
		}
	})
	.get('/api/auth/callback', async (c) => {
		try {
			const params = new URLSearchParams(c.query)

			// client.callback() validates the state parameter internally
			// It will throw an error if state validation fails (CSRF protection)
			const { session } = await client.callback(params)

			if (!session) {
				console.error('[Auth] OAuth callback failed: no session returned')
				return c.redirect('/?error=auth_failed')
			}

			const cookieSession = c.cookie
			cookieSession.did.value = session.did

			// Sync sites from PDS to database cache
			console.log('[Auth] Syncing sites from PDS for', session.did)
			try {
				const syncResult = await syncSitesFromPDS(session.did, session)
				console.log(`[Auth] Sync complete: ${syncResult.synced} sites synced`)
				if (syncResult.errors.length > 0) {
					console.warn('[Auth] Sync errors:', syncResult.errors)
				}
			} catch (err) {
				console.error('[Auth] Failed to sync sites:', err)
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
			console.error('[Auth] OAuth callback error:', err)
			return c.redirect('/?error=auth_failed')
		}
	})
	.post('/api/auth/logout', async (c) => {
		try {
			const cookieSession = c.cookie
			const did = cookieSession.did?.value

			// Clear the session cookie
			cookieSession.did.value = ''
			cookieSession.did.maxAge = 0

			// If we have a DID, try to revoke the OAuth session
			if (did && typeof did === 'string') {
				try {
					await client.revoke(did)
					console.log('[Auth] Revoked OAuth session for', did)
				} catch (err) {
					console.error('[Auth] Failed to revoke session:', err)
					// Continue with logout even if revoke fails
				}
			}

			return { success: true }
		} catch (err) {
			console.error('[Auth] Logout error:', err)
			return { error: 'Logout failed' }
		}
	})
	.get('/api/auth/status', async (c) => {
		try {
			const auth = await authenticateRequest(client, c.cookie)

			if (!auth) {
				return { authenticated: false }
			}

			return {
				authenticated: true,
				did: auth.did
			}
		} catch (err) {
			console.error('[Auth] Status check error:', err)
			return { authenticated: false }
		}
	})