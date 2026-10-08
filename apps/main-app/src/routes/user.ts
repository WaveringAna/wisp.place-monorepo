import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import {
	createCachedIdentityFetcher,
	createPinnedIdentityFetcher,
	getHandleForDid,
	type IdentityGetFetcher,
} from '@wispplace/atproto-utils'
import { createLogger } from '@wispplace/observability'
import { Elysia } from 'elysia'
import { eventualRead, getDomainsForDid, getSitesWithDomainsForDid } from '../lib/db'
import { backfillSitesFromPds } from '../lib/pds-backfill'
import { flagSitesNeedingAttention } from '../lib/site-attention'
import { requireAuth, SESSION_COOKIE_NAME } from '../lib/wisp-auth'

const logger = createLogger('main-app')
// Identity documents are remote, user-controlled data. Keep the pinned transport
// at the server boundary rather than allowing the identity helper to use global fetch.
const serverIdentityGet = createPinnedIdentityFetcher({ allowLoopback: true })
const presentationIdentityCache = createCachedIdentityFetcher(serverIdentityGet)
// Presentation may use a short stale fallback. Security and ownership callers
// receive the uncached pinned fetcher instead.
const presentationIdentityGet: IdentityGetFetcher = (url, options) =>
	presentationIdentityCache.get(url, { staleIfError: true, signal: options?.signal })

export const userRoutes = (
	client: NodeOAuthClient,
	cookieSecret: string,
	identityGet: IdentityGetFetcher = presentationIdentityGet,
) =>
	new Elysia({
		prefix: '/api/user',
		cookie: {
			secrets: cookieSecret,
			sign: [SESSION_COOKIE_NAME],
		},
	})
		.derive(async ({ cookie, request }) => {
			const auth = await requireAuth(client, cookie, request.headers.get('cookie'))
			return { auth }
		})
		/**
		 * GET /api/user/status
		 * Success: { did, hasSites, hasDomain, domain, sitesCount }
		 */
		.get('/status', async ({ auth }) => {
			try {
				// Presentation-only status may be briefly stale when a replica is configured.
				const { sites, domain } = await eventualRead.getUserStatus(auth.did)

				return {
					did: auth.did,
					hasSites: sites.length > 0,
					hasDomain: !!domain,
					domain: domain || null,
					sitesCount: sites.length,
				}
			} catch {
				logger.error('[User] Status error')
				throw new Error('Failed to get user status')
			}
		})
		/**
		 * GET /api/user/info
		 * Success: { did, handle, isSupporter }
		 */
		.get('/info', async ({ auth }) => {
			try {
				const [resolvedHandle, supporter] = await Promise.all([
					getHandleForDid(auth.did, identityGet).catch(() => {
						logger.warn('[User] Identity lookup failed')
						return null
					}),
					// This only controls the displayed badge. Domain-limit enforcement stays primary.
					eventualRead.getSupporterStatus(auth.did),
				])
				const handle = resolvedHandle ?? 'unknown'

				logger.debug('[User] isSupporter check', { did: auth.did, supporter })

				const response = {
					did: auth.did,
					handle,
					isSupporter: supporter,
				}
				logger.debug('[User] Returning info', response)
				return response
			} catch {
				logger.error('[User] Info error')
				throw new Error('Failed to get user info')
			}
		})
		/**
		 * GET /api/user/sites
		 * Success: { sites } — each site carries its own `domains` array, so the
		 * list view needs one request rather than one per site, and
		 * `needs_attention: true` when its repairs were dead-lettered.
		 * `?fresh=1` reads the primary, for a dashboard waiting on a deploy or delete it just made.
		 */
		.get('/sites', async ({ auth, query }) => {
			try {
				const read = query.fresh === '1' ? getSitesWithDomainsForDid : eventualRead.getSitesWithDomainsForDid
				const sites = await flagSitesNeedingAttention(await read(auth.did))
				return { sites }
			} catch {
				logger.error('[User] Sites error')
				throw new Error('Failed to get sites')
			}
		})
		/**
		 * GET /api/user/domains
		 * Success: { wispDomains: [{ domain, rkey }], customDomains }
		 * `?fresh=1` reads the primary: a replica can still lag a change the user just made.
		 */
		.get('/domains', async ({ auth, query }) => {
			try {
				const read = query.fresh === '1' ? getDomainsForDid : eventualRead.getDomainsForDid
				const { wispDomains, customDomains } = await read(auth.did)

				return {
					wispDomains: wispDomains.map((d) => ({
						domain: d.domain,
						rkey: d.rkey || null,
					})),
					customDomains,
				}
			} catch {
				logger.error('[User] Domains error')
				throw new Error('Failed to get domains')
			}
		})
		/**
		 * POST /api/user/sync
		 * Queues every place.wisp.fs record on the user's PDS that site_cache is
		 * missing or holds at an older CID for the firehose revalidation worker.
		 * Success: { success: true, synced, queued, errors }
		 */
		.post('/sync', async ({ auth }) => {
			try {
				const { found, queued } = await backfillSitesFromPds(auth.did, auth.session)
				return { success: true, synced: found, queued, errors: [] }
			} catch (err) {
				logger.error('[User] Sync error', err)
				throw new Error('Failed to sync sites from your PDS')
			}
		})
		/**
		 * GET /api/user/site/:rkey/domains
		 * Success: { rkey, domains }
		 */
		.get('/site/:rkey/domains', async ({ auth, params }) => {
			try {
				const { rkey } = params
				const domains = await eventualRead.getDomainsForSite(auth.did, rkey)

				return {
					rkey,
					domains,
				}
			} catch {
				logger.error('[User] Site domains error')
				throw new Error('Failed to get domains for site')
			}
		})
