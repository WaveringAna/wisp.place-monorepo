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
	countWispDomains,
	deleteWispDomain,
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
import { createLogger } from '@wisp/observability'

const logger = createLogger('main-app')

export const domainRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/domain',
		cookie: {
			secrets: cookieSecret,
			sign: ['did']
		}
	})
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
				logger.error('[Domain] Check error', err);
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
				logger.error('[Domain] Registered check error', err);
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

				// Check if user already has 3 domains (handled in claimDomain)
				// claim in DB
				let domain: string;
				try {
					domain = await claimDomain(auth.did, normalizedHandle);
				} catch (err) {
					const message = err instanceof Error ? err.message : 'Unknown error';
					if (message === 'domain_limit_reached') {
						throw new Error("Domain limit reached: You can only claim up to 3 wisp.place domains");
					}
					throw new Error("Handle taken or error claiming domain");
				}

				// write place.wisp.domain record with unique rkey
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init));
				const rkey = normalizedHandle; // Use handle as rkey for uniqueness
				await agent.com.atproto.repo.putRecord({
					repo: auth.did,
					collection: "place.wisp.domain",
					rkey,
					record: {
						$type: "place.wisp.domain",
						domain,
						createdAt: new Date().toISOString(),
					} as any,
					validate: false,
				});

				return { success: true, domain };
			} catch (err) {
				logger.error('[Domain] Claim error', err);
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
				logger.error('[Domain] Update error', err);
				throw new Error(`Failed to update: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.post('/custom/add', async ({ body, auth }) => {
			try {
				const { domain } = body as { domain: string };
				const domainLower = domain.toLowerCase().trim();

				// Enhanced domain validation
				// 1. Length check (RFC 1035: labels 1-63 chars, total max 253)
				if (!domainLower || domainLower.length < 3 || domainLower.length > 253) {
					throw new Error('Invalid domain: must be 3-253 characters');
				}

				// 2. Basic format validation
				// - Must contain at least one dot (require TLD)
				// - Valid characters: a-z, 0-9, hyphen, dot
				// - No consecutive dots, no leading/trailing dots or hyphens
				const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
				if (!domainPattern.test(domainLower)) {
					throw new Error('Invalid domain format');
				}

				// 3. Validate each label (part between dots)
				const labels = domainLower.split('.');
				for (const label of labels) {
					if (label.length === 0 || label.length > 63) {
						throw new Error('Invalid domain: label length must be 1-63 characters');
					}
					if (label.startsWith('-') || label.endsWith('-')) {
						throw new Error('Invalid domain: labels cannot start or end with hyphen');
					}
				}

				// 4. TLD validation (require valid TLD, block single-char TLDs and numeric TLDs)
				const tld = labels[labels.length - 1];
				if (tld.length < 2 || /^\d+$/.test(tld)) {
					throw new Error('Invalid domain: TLD must be at least 2 characters and not all numeric');
				}

				// 5. Homograph attack protection - block domains with mixed scripts or confusables
				// Block non-ASCII characters (Punycode domains should be pre-converted)
				if (!/^[a-z0-9.-]+$/.test(domainLower)) {
					throw new Error('Invalid domain: only ASCII alphanumeric, dots, and hyphens allowed');
				}

				// 6. Block localhost, internal IPs, and reserved domains
				const blockedDomains = [
					'localhost',
					'example.com',
					'example.org',
					'example.net',
					'test',
					'invalid',
					'local'
				];
				const blockedPatterns = [
					/^(?:10|127|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\./,  // Private IPs
					/^(?:\d{1,3}\.){3}\d{1,3}$/,  // Any IP address
				];

				if (blockedDomains.includes(domainLower)) {
					throw new Error('Invalid domain: reserved or blocked domain');
				}

				for (const pattern of blockedPatterns) {
					if (pattern.test(domainLower)) {
						throw new Error('Invalid domain: IP addresses not allowed');
					}
				}

				// Check if already exists and is verified
				const existing = await getCustomDomainInfo(domainLower);
				if (existing && existing.verified) {
					throw new Error('Domain already verified and claimed');
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
				logger.error('[Domain] Custom domain add error', err);
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
				logger.debug(`[Domain] Verifying custom domain: ${domainInfo.domain}`);
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
				logger.error('[Domain] Custom domain verify error', err);
				throw new Error(`Failed to verify domain: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.delete('/custom/:id', async ({ params, auth }) => {
			try {
				const { id } = params;

				// Verify ownership before deleting
				const domainInfo = await getCustomDomainById(id);
				if (!domainInfo) {
					throw new Error('Domain not found');
				}

				if (domainInfo.did !== auth.did) {
					throw new Error('Unauthorized: You do not own this domain');
				}

				// Delete from database
				await deleteCustomDomain(id);

				return { success: true };
			} catch (err) {
				logger.error('[Domain] Custom domain delete error', err);
				throw new Error(`Failed to delete domain: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.post('/wisp/map-site', async ({ body, auth }) => {
			try {
				const { domain, siteRkey } = body as { domain: string; siteRkey: string | null };

				if (!domain) {
					throw new Error('Domain parameter required');
				}

				// Update wisp.place domain to point to this site
				await updateWispDomainSite(domain, siteRkey);

				return { success: true };
			} catch (err) {
				logger.error('[Domain] Wisp domain map error', err);
				throw new Error(`Failed to map site: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.delete('/wisp/:domain', async ({ params, auth }) => {
			try {
				const { domain } = params;

				// Verify domain belongs to user
				const domainLower = domain.toLowerCase().trim();
				const info = await isDomainRegistered(domainLower);

				if (!info.registered || info.type !== 'wisp') {
					throw new Error('Domain not found');
				}

				if (info.did !== auth.did) {
					throw new Error('Unauthorized: You do not own this domain');
				}

				// Delete from database
				await deleteWispDomain(domainLower);

				// Delete from PDS
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init));
				const handle = domainLower.replace(`.${process.env.BASE_DOMAIN || 'wisp.place'}`, '');
				try {
					await agent.com.atproto.repo.deleteRecord({
						repo: auth.did,
						collection: "place.wisp.domain",
						rkey: handle,
					});
				} catch (err) {
					// Record might not exist in PDS, continue anyway
					logger.warn('[Domain] Could not delete wisp domain from PDS', err as any);
				}

				return { success: true };
			} catch (err) {
				logger.error('[Domain] Wisp domain delete error', err);
				throw new Error(`Failed to delete domain: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		})
		.post('/custom/:id/map-site', async ({ params, body, auth }) => {
			try {
				const { id } = params;
				const { siteRkey } = body as { siteRkey: string | null };

				// Verify ownership before updating
				const domainInfo = await getCustomDomainById(id);
				if (!domainInfo) {
					throw new Error('Domain not found');
				}

				if (domainInfo.did !== auth.did) {
					throw new Error('Unauthorized: You do not own this domain');
				}

				// Update custom domain to point to this site
				await updateCustomDomainRkey(id, siteRkey);

				return { success: true };
			} catch (err) {
				logger.error('[Domain] Custom domain map error', err);
				throw new Error(`Failed to map site: ${err instanceof Error ? err.message : 'Unknown error'}`);
			}
		});