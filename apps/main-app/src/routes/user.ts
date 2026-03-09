import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { getHandleForDid } from '@wispplace/atproto-utils'
import { createLogger } from '@wispplace/observability'
import { Elysia } from 'elysia'
import {
	getAllWispDomains,
	getCustomDomainsByDid,
	getDomainByDid,
	getDomainsBySite,
	getSitesByDid,
	isSupporter,
} from '../lib/db'
import { syncSitesFromPDS } from '../lib/sync-sites'
import { requireAuth } from '../lib/wisp-auth'

const logger = createLogger('main-app')

export const userRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/user',
		cookie: {
			secrets: cookieSecret,
			sign: ['did'],
		},
	})
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
		/**
		 * GET /api/user/status
		 * Success: { did, hasSites, hasDomain, domain, sitesCount }
		 */
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
					sitesCount: sites.length,
				}
			} catch (err) {
				logger.error('[User] Status error', err)
				throw new Error('Failed to get user status')
			}
		})
		/**
		 * GET /api/user/info
		 * Success: { did, handle, isSupporter }
		 */
		.get('/info', async ({ auth }) => {
			try {
				let handle = 'unknown'
				try {
					const resolvedHandle = await getHandleForDid(auth.did)
					if (resolvedHandle) {
						handle = resolvedHandle
					}
				} catch (err) {
					logger.error('[User] Failed to resolve DID', err)
				}

				// Check if user is a supporter
				const supporter = await isSupporter(auth.did)
				logger.debug('[User] isSupporter check', { did: auth.did, supporter })

				const response = {
					did: auth.did,
					handle,
					isSupporter: supporter,
				}
				logger.debug('[User] Returning info', response)
				return response
			} catch (err) {
				logger.error('[User] Info error', err)
				throw new Error('Failed to get user info')
			}
		})
		/**
		 * GET /api/user/sites
		 * Success: { sites }
		 */
		.get('/sites', async ({ auth }) => {
			try {
				const sites = await getSitesByDid(auth.did)
				return { sites }
			} catch (err) {
				logger.error('[User] Sites error', err)
				throw new Error('Failed to get sites')
			}
		})
		/**
		 * GET /api/user/domains
		 * Success: { wispDomains: [{ domain, rkey }], customDomains }
		 */
		.get('/domains', async ({ auth }) => {
			try {
				// Get all wisp.place subdomains with mappings (up to 3)
				const wispDomains = await getAllWispDomains(auth.did)

				// Get custom domains
				const customDomains = await getCustomDomainsByDid(auth.did)

				return {
					wispDomains: wispDomains.map((d) => ({
						domain: d.domain,
						rkey: d.rkey || null,
					})),
					customDomains,
				}
			} catch (err) {
				logger.error('[User] Domains error', err)
				throw new Error('Failed to get domains')
			}
		})
		/**
		 * POST /api/user/sync
		 * Success: { success: true, synced, errors }
		 */
		.post('/sync', async ({ auth }) => {
			try {
				logger.debug('[User] Manual sync requested for', { did: auth.did })
				const result = await syncSitesFromPDS(auth.did, auth.session)

				return {
					success: true,
					synced: result.synced,
					errors: result.errors,
				}
			} catch (err) {
				logger.error('[User] Sync error', err)
				throw new Error('Failed to sync sites')
			}
		})
		/**
		 * GET /api/user/site/:rkey/domains
		 * Success: { rkey, domains }
		 */
		.get('/site/:rkey/domains', async ({ auth, params }) => {
			try {
				const { rkey } = params
				const domains = await getDomainsBySite(auth.did, rkey)

				return {
					rkey,
					domains,
				}
			} catch (err) {
				logger.error('[User] Site domains error', err)
				throw new Error('Failed to get domains for site')
			}
		})
