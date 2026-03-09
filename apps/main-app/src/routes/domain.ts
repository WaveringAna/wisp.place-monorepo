import { createHash } from 'node:crypto'
import { Agent } from '@atproto/api'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { createLogger } from '@wispplace/observability'
import { Elysia } from 'elysia'
import {
	claimCustomDomain,
	claimDomain,
	deleteCustomDomain,
	deleteWispDomain,
	getCustomDomainById,
	getCustomDomainInfo,
	getDomainByDid,
	isDomainAvailable,
	isDomainRegistered,
	updateCustomDomainRkey,
	updateCustomDomainVerification,
	updateDomain,
	updateWispDomainSite,
} from '../lib/db'
import { verifyCustomDomain } from '../lib/dns-verify'
import { extractWispHandle, isValidHandle, normalizeDomain, toDomain, validateCustomDomain } from '../lib/domain-utils'
import { requireAuth } from '../lib/wisp-auth'

const logger = createLogger('main-app')

export const domainRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/domain',
		cookie: {
			secrets: cookieSecret,
			sign: ['did'],
		},
	})
		// Public endpoints (no auth required)
		/**
		 * GET /api/domain/check
		 * Success: { available, domain } or { available: false, reason: 'invalid' }.
		 * Failure: { available: false }.
		 */
		.get('/check', async ({ query }) => {
			try {
				const handle = (query.handle || '').trim().toLowerCase()

				if (!isValidHandle(handle)) {
					return {
						available: false,
						reason: 'invalid',
					}
				}

				const available = await isDomainAvailable(handle)
				return {
					available,
					domain: toDomain(handle),
				}
			} catch (err) {
				logger.error('[Domain] Check error', err)
				return {
					available: false,
				}
			}
		})
		/**
		 * GET /api/domain/registered
		 * 200: { registered: true, type: 'wisp' | 'custom', domain, did, rkey, verified? }
		 * 404: { registered: false }
		 * 400: { error: 'Domain parameter required' }
		 */
		.get('/registered', async ({ query, set }) => {
			try {
				const domain = normalizeDomain(String(query.domain || ''))

				if (!domain) {
					set.status = 400
					return { error: 'Domain parameter required' }
				}

				const result = await isDomainRegistered(domain)

				// For Caddy on-demand TLS: 200 = allow, 404 = deny
				if (result.registered) {
					set.status = 200
					return result
				} else {
					set.status = 404
					return { registered: false }
				}
			} catch (err) {
				logger.error('[Domain] Registered check error', err)
				set.status = 500
				return { error: 'Failed to check domain' }
			}
		})
		// Authenticated endpoints (require auth)
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
		/**
		 * POST /api/domain/claim
		 * Success: { success: true, domain }
		 */
		.post('/claim', async ({ body, auth, set }) => {
			try {
				const { handle } = body as { handle?: string }
				const normalizedHandle = (handle || '').trim().toLowerCase()

				if (!isValidHandle(normalizedHandle)) {
					set.status = 400
					throw new Error('Invalid handle')
				}

				// Check if user already has 3 domains (handled in claimDomain)
				// claim in DB
				let domain: string
				try {
					domain = await claimDomain(auth.did, normalizedHandle)
				} catch (err) {
					const message = err instanceof Error ? err.message : 'Unknown error'
					if (message === 'domain_limit_reached') {
						set.status = 400
						throw new Error('Domain limit reached: You can only claim up to 3 wisp.place domains')
					}
					set.status = 409
					throw new Error('Handle taken or error claiming domain')
				}

				// write place.wisp.domain record with unique rkey
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
				const rkey = normalizedHandle // Use handle as rkey for uniqueness
				await agent.com.atproto.repo.putRecord({
					repo: auth.did,
					collection: 'place.wisp.domain',
					rkey,
					record: {
						$type: 'place.wisp.domain',
						domain,
						createdAt: new Date().toISOString(),
					} as any,
					validate: false,
				})

				return { success: true, domain }
			} catch (err) {
				logger.error('[Domain] Claim error', err)
				throw new Error(`Failed to claim: ${err instanceof Error ? err.message : 'Unknown error'}`)
			}
		})
		/**
		 * POST /api/domain/update
		 * Success: { success: true, domain }
		 */
		.post('/update', async ({ body, auth, set }) => {
			try {
				const { handle } = body as { handle?: string }
				const normalizedHandle = (handle || '').trim().toLowerCase()

				if (!isValidHandle(normalizedHandle)) {
					set.status = 400
					throw new Error('Invalid handle')
				}

				const desiredDomain = toDomain(normalizedHandle)
				const current = await getDomainByDid(auth.did)

				if (current === desiredDomain) {
					return { success: true, domain: current }
				}

				let domain: string
				try {
					domain = await updateDomain(auth.did, normalizedHandle)
				} catch (_err) {
					set.status = 409
					throw new Error('Handle taken')
				}

				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
				await agent.com.atproto.repo.putRecord({
					repo: auth.did,
					collection: 'place.wisp.domain',
					rkey: 'self',
					record: {
						$type: 'place.wisp.domain',
						domain,
						createdAt: new Date().toISOString(),
					} as any,
					validate: false,
				})

				return { success: true, domain }
			} catch (err) {
				logger.error('[Domain] Update error', err)
				throw new Error(`Failed to update: ${err instanceof Error ? err.message : 'Unknown error'}`)
			}
		})
		/**
		 * POST /api/domain/custom/add
		 * Success: { success: true, id, domain, verified: false }
		 */
		.post('/custom/add', async ({ body, auth, set }) => {
			try {
				const { domain } = body as { domain: string }
				const domainLower = normalizeDomain(domain || '')

				const domainError = validateCustomDomain(domainLower)
				if (domainError) {
					set.status = 400
					throw new Error(`Invalid domain: ${domainError}`)
				}

				// Verified claims are DID-locked. Pending claims can be reclaimed.
				const existing = await getCustomDomainInfo(domainLower)
				if (existing?.verified && existing.did !== auth.did) {
					set.status = 409
					throw new Error('Domain already claimed')
				}

				if (existing && existing.did === auth.did) {
					return {
						success: true,
						id: existing.id,
						domain: domainLower,
						verified: Boolean(existing.verified),
					}
				}

				// Create hash for ID
				const hash = createHash('sha256').update(`${auth.did}:${domainLower}`).digest('hex').substring(0, 16)

				// Store in database only
				await claimCustomDomain(auth.did, domainLower, hash)

				return {
					success: true,
					id: hash,
					domain: domainLower,
					verified: false,
				}
			} catch (err) {
				logger.error('[Domain] Custom domain add error', err)
				throw new Error(`Failed to add domain: ${err instanceof Error ? err.message : 'Unknown error'}`)
			}
		})
		/**
		 * POST /api/domain/custom/verify
		 * Success: { success: true, verified, error, found }
		 */
		.post('/custom/verify', async ({ body, auth, set }) => {
			try {
				const { id } = body as { id: string }

				// Get domain from database
				const domainInfo = await getCustomDomainById(id)
				if (!domainInfo) {
					set.status = 404
					throw new Error('Domain not found')
				}

				// Verify DNS records (TXT + CNAME)
				logger.debug(`[Domain] Verifying custom domain: ${domainInfo.domain}`)
				const result = await verifyCustomDomain(domainInfo.domain, auth.did, id)

				// Update verification status in database
				await updateCustomDomainVerification(id, result.verified)

				return {
					success: true,
					verified: result.verified,
					error: result.error,
					warning: result.warning,
					found: result.found,
				}
			} catch (err) {
				logger.error('[Domain] Custom domain verify error', err)
				throw new Error(`Failed to verify domain: ${err instanceof Error ? err.message : 'Unknown error'}`)
			}
		})
		/**
		 * DELETE /api/domain/custom/:id
		 * Success: { success: true }
		 */
		.delete('/custom/:id', async ({ params, auth, set }) => {
			try {
				const { id } = params

				// Verify ownership before deleting
				const domainInfo = await getCustomDomainById(id)
				if (!domainInfo) {
					set.status = 404
					throw new Error('Domain not found')
				}

				if (domainInfo.did !== auth.did) {
					set.status = 403
					throw new Error('Unauthorized: You do not own this domain')
				}

				// Delete from database
				await deleteCustomDomain(id)

				return { success: true }
			} catch (err) {
				logger.error('[Domain] Custom domain delete error', err)
				throw new Error(`Failed to delete domain: ${err instanceof Error ? err.message : 'Unknown error'}`)
			}
		})
		/**
		 * POST /api/domain/wisp/map-site
		 * Success: { success: true }
		 */
		.post('/wisp/map-site', async ({ body, auth, set }) => {
			try {
				const { domain, siteRkey } = body as { domain: string; siteRkey: string | null }

				if (!domain) {
					set.status = 400
					throw new Error('Domain parameter required')
				}

				// Verify domain belongs to user
				const domainLower = normalizeDomain(domain)
				const info = await isDomainRegistered(domainLower)

				if (!info.registered || info.type !== 'wisp') {
					set.status = 404
					throw new Error('Domain not found')
				}

				if (info.did !== auth.did) {
					set.status = 403
					throw new Error('Unauthorized: You do not own this domain')
				}

				// Update wisp.place domain to point to this site
				await updateWispDomainSite(domainLower, siteRkey)

				return { success: true }
			} catch (err) {
				logger.error('[Domain] Wisp domain map error', err)
				throw new Error(`Failed to map site: ${err instanceof Error ? err.message : 'Unknown error'}`)
			}
		})
		/**
		 * DELETE /api/domain/wisp/:domain
		 * Success: { success: true }
		 */
		.delete('/wisp/:domain', async ({ params, auth, set }) => {
			try {
				const { domain } = params

				// Verify domain belongs to user
				const domainLower = normalizeDomain(domain)
				const info = await isDomainRegistered(domainLower)

				if (!info.registered || info.type !== 'wisp') {
					set.status = 404
					throw new Error('Domain not found')
				}

				if (info.did !== auth.did) {
					set.status = 403
					throw new Error('Unauthorized: You do not own this domain')
				}

				// Delete from database
				await deleteWispDomain(domainLower)

				// Delete from PDS
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
				const handle = extractWispHandle(domainLower)
				if (!handle) {
					set.status = 400
					throw new Error('Invalid wisp domain')
				}
				try {
					await agent.com.atproto.repo.deleteRecord({
						repo: auth.did,
						collection: 'place.wisp.domain',
						rkey: handle,
					})
				} catch (err) {
					// Record might not exist in PDS, continue anyway
					logger.warn('[Domain] Could not delete wisp domain from PDS', err as any)
				}

				return { success: true }
			} catch (err) {
				logger.error('[Domain] Wisp domain delete error', err)
				throw new Error(`Failed to delete domain: ${err instanceof Error ? err.message : 'Unknown error'}`)
			}
		})
		/**
		 * POST /api/domain/custom/:id/map-site
		 * Success: { success: true }
		 */
		.post('/custom/:id/map-site', async ({ params, body, auth, set }) => {
			try {
				const { id } = params
				const { siteRkey } = body as { siteRkey: string | null }

				// Verify ownership before updating
				const domainInfo = await getCustomDomainById(id)
				if (!domainInfo) {
					set.status = 404
					throw new Error('Domain not found')
				}

				if (domainInfo.did !== auth.did) {
					set.status = 403
					throw new Error('Unauthorized: You do not own this domain')
				}

				// Update custom domain to point to this site
				await updateCustomDomainRkey(id, siteRkey)

				return { success: true }
			} catch (err) {
				logger.error('[Domain] Custom domain map error', err)
				throw new Error(`Failed to map site: ${err instanceof Error ? err.message : 'Unknown error'}`)
			}
		})
