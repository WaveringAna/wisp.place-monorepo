import { Elysia } from 'elysia'
import { requireAuth, type AuthenticatedContext } from '../lib/wisp-auth'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Agent } from '@atproto/api'
import {
	claimDomain,
	getDomainByDid,
	isDomainAvailable,
	isValidHandle,
	toDomain,
	updateDomain,
} from '../lib/db'

export const domainRoutes = (client: NodeOAuthClient) =>
	new Elysia({ prefix: '/api/domain' })
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
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
		});