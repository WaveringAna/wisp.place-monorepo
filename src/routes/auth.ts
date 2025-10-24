import { Elysia } from 'elysia'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { getSitesByDid, getDomainByDid } from '../lib/db'
import { syncSitesFromPDS } from '../lib/sync-sites'

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
		const params = new URLSearchParams(c.query)
		const { session } = await client.callback(params)
		if (!session) return { error: 'Authentication failed' }

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
	})