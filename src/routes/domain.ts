import { Elysia } from 'elysia'
import { requireAuth, type AuthenticatedContext } from '../lib/wisp-auth'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Agent } from '@atproto/api'
import {
	claimDomain,
	getDomainByDid,
	isDomainAvailable,
	isDomainRegistered,
	isValidHandle,
	toDomain,
	updateDomain,
	getCustomDomainInfo,
	getCustomDomainById,
	claimCustomDomain,
	deleteCustomDomain,
	updateCustomDomainVerification,
	updateWispDomainSite,
	updateCustomDomainRkey
} from '../lib/db'
import { createHash } from 'crypto'
import { verifyCustomDomain } from '../lib/dns-verify'

export const domainRoutes = (client: NodeOAuthClient) =>
	new Elysia({ prefix: '/api/domain' })
		// Public endpoints (no auth required)
		.get('/check', async ({ query }) => {
			try {
				const handle = (query.handle || "")
					.trim()
					.toLowerCase();

				if (!isValidHandle(handle)) {
					return {
						available: false,
						reason: "invalid"
					};
				}

				const available = await isDomainAvailable(handle);
				return {
					available,
					domain: toDomain(handle)
				};
			} catch (err) {
				console.error("domain/check error", err);
				return {
					available: false
				};
			}
		})
		.get('/registered', async ({ query, set }) => {
			try {
				const domain = (query.domain || "").trim().toLowerCase();

				if (!domain) {
					set.status = 400;
					return { error: 'Domain parameter required' };
				}

				const result = await isDomainRegistered(domain);

				// For Caddy on-demand TLS: 200 = allow, 404 = deny
				if (result.registered) {
					set.status = 200;
					return result;
				} else {
					set.status = 404;
					return { registered: false };
				}
			} catch (err) {
				console.error("domain/registered error", err);
				set.status = 500;
				return { error: 'Failed to check domain' };
			}
		})
		// Authenticated endpoints (require auth)
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
		.post('/claim', async ({ body, auth }) => {
			try {
				const { handle } = body as { handle?: string };
				const normalizedHandle = (handle || "").trim().toLowerCase();
				
				if (!isValidHandle(normalizedHandle)) {
					throw new Error("Invalid handle");
				}

				// ensure user hasn't already claimed
				const existing = await getDomainByDid(auth.did);
				if (existing) {
					throw new Error("Already claimed");
				}

				// claim in DB
				let domain: string;
				try {
					domain = await claimDomain(auth.did, normalizedHandle);
				} catch (err) {
					throw new Error("Handle taken");
				}

				// write place.wisp.domain record rkey = self
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init));
				await agent.com.atproto.repo.putRecord({
					repo: auth.did,
					collection: "place.wisp.domain",
					rkey: "self",
					record: {
						$type: "place.wisp.domain",
						domain,
						createdAt: new Date().toISOString(),
					} as any,
					validate: false,
				});

				return { success: true, domain };
			} catch (err) {
				console.error("domain/claim error", err);
				throw new Error(`Failed to claim: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.post('/update', async ({ body, auth }) => {
			try {
				const { handle } = body as { handle?: string };
				const normalizedHandle = (handle || "").trim().toLowerCase();
				
				if (!isValidHandle(normalizedHandle)) {
					throw new Error("Invalid handle");
				}

				const desiredDomain = toDomain(normalizedHandle);
				const current = await getDomainByDid(auth.did);
				
				if (current === desiredDomain) {
					return { success: true, domain: current };
				}

				let domain: string;
				try {
					domain = await updateDomain(auth.did, normalizedHandle);
				} catch (err) {
					throw new Error("Handle taken");
				}

				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init));
				await agent.com.atproto.repo.putRecord({
					repo: auth.did,
					collection: "place.wisp.domain",
					rkey: "self",
					record: {
						$type: "place.wisp.domain",
						domain,
						createdAt: new Date().toISOString(),
					} as any,
					validate: false,
				});

				return { success: true, domain };
			} catch (err) {
				console.error("domain/update error", err);
				throw new Error(`Failed to update: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.post('/custom/add', async ({ body, auth }) => {
			try {
				const { domain } = body as { domain: string };
				const domainLower = domain.toLowerCase().trim();

				// Basic validation
				if (!domainLower || domainLower.length < 3) {
					throw new Error('Invalid domain');
				}

				// Check if already exists
				const existing = await getCustomDomainInfo(domainLower);
				if (existing) {
					throw new Error('Domain already claimed');
				}

				// Create hash for ID
				const hash = createHash('sha256').update(`${auth.did}:${domainLower}`).digest('hex').substring(0, 16);

				// Store in database only
				await claimCustomDomain(auth.did, domainLower, hash);

				return {
					success: true,
					id: hash,
					domain: domainLower,
					verified: false
				};
			} catch (err) {
				console.error('custom domain add error', err);
				throw new Error(`Failed to add domain: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.post('/custom/verify', async ({ body, auth }) => {
			try {
				const { id } = body as { id: string };

				// Get domain from database
				const domainInfo = await getCustomDomainById(id);
				if (!domainInfo) {
					throw new Error('Domain not found');
				}

				// Verify DNS records (TXT + CNAME)
				console.log(`Verifying custom domain: ${domainInfo.domain}`);
				const result = await verifyCustomDomain(domainInfo.domain, auth.did, id);

				// Update verification status in database
				await updateCustomDomainVerification(id, result.verified);

				return {
					success: true,
					verified: result.verified,
					error: result.error,
					found: result.found
				};
			} catch (err) {
				console.error('custom domain verify error', err);
				throw new Error(`Failed to verify domain: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.delete('/custom/:id', async ({ params, auth }) => {
			try {
				const { id } = params;

				// Delete from database
				await deleteCustomDomain(id);

				return { success: true };
			} catch (err) {
				console.error('custom domain delete error', err);
				throw new Error(`Failed to delete domain: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.post('/wisp/map-site', async ({ body, auth }) => {
			try {
				const { siteRkey } = body as { siteRkey: string | null };

				// Update wisp.place domain to point to this site
				await updateWispDomainSite(auth.did, siteRkey);

				return { success: true };
			} catch (err) {
				console.error('wisp domain map error', err);
				throw new Error(`Failed to map site: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.post('/custom/:id/map-site', async ({ params, body, auth }) => {
			try {
				const { id } = params;
				const { siteRkey } = body as { siteRkey: string | null };

				// Update custom domain to point to this site
				await updateCustomDomainRkey(id, siteRkey || 'self');

				return { success: true };
			} catch (err) {
				console.error('custom domain map error', err);
				throw new Error(`Failed to map site: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		});