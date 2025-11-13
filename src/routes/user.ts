import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/wisp-auth'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Agent } from '@atproto/api'
import { getSitesByDid, getDomainByDid, getCustomDomainsByDid, getWispDomainInfo, getDomainsBySite, getAllWispDomains } from '../lib/db'
import { syncSitesFromPDS } from '../lib/sync-sites'
import { logger } from '../lib/logger'

export const userRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/user',
		cookie: {
			secrets: cookieSecret,
			sign: ['did']
		}
	})
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
		.get('/status', async ({ auth }) => {
			try {
				// Check if user has any sites
				const sites = await getSitesByDid(auth.did)

				// Check if user has claimed a domain
				const domain = await getDomainByDid(auth.did)

				return {
					did: auth.did,
					hasSites: sites.length > 0,
					hasDomain: !!domain,
					domain: domain || null,
					sitesCount: sites.length
				}
			} catch (err) {
				logger.error('[User] Status error', err)
				throw new Error('Failed to get user status')
			}
		})
		.get('/info', async ({ auth }) => {
			try {
				// Get user's handle from AT Protocol
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))

				let handle = 'unknown'
				try {
					const profile = await agent.getProfile({ actor: auth.did })
					handle = profile.data.handle
				} catch (err) {
					logger.error('[User] Failed to fetch profile', err)
				}

				return {
					did: auth.did,
					handle
				}
			} catch (err) {
				logger.error('[User] Info error', err)
				throw new Error('Failed to get user info')
			}
		})
		.get('/sites', async ({ auth }) => {
			try {
				const sites = await getSitesByDid(auth.did)
				return { sites }
			} catch (err) {
				logger.error('[User] Sites error', err)
				throw new Error('Failed to get sites')
			}
		})
		.get('/domains', async ({ auth }) => {
			try {
				// Get all wisp.place subdomains with mappings (up to 3)
				const wispDomains = await getAllWispDomains(auth.did)

				// Get custom domains
				const customDomains = await getCustomDomainsByDid(auth.did)

				return {
					wispDomains: wispDomains.map(d => ({
						domain: d.domain,
						rkey: d.rkey || null
					})),
					customDomains
				}
			} catch (err) {
				logger.error('[User] Domains error', err)
				throw new Error('Failed to get domains')
			}
		})
		.post('/sync', async ({ auth }) => {
			try {
				logger.debug('[User] Manual sync requested for', auth.did)
				const result = await syncSitesFromPDS(auth.did, auth.session)

				return {
					success: true,
					synced: result.synced,
					errors: result.errors
				}
			} catch (err) {
				logger.error('[User] Sync error', err)
				throw new Error('Failed to sync sites')
			}
		})
		.get('/site/:rkey/domains', async ({ auth, params }) => {
			try {
				const { rkey } = params
				const domains = await getDomainsBySite(auth.did, rkey)

				return {
					rkey,
					domains
				}
			} catch (err) {
				logger.error('[User] Site domains error', err)
				throw new Error('Failed to get domains for site')
			}
		})
