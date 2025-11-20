import { Elysia } from 'elysia'
import { requireAuth } from '../lib/wisp-auth'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Agent } from '@atproto/api'
import { deleteSite } from '../lib/db'
import { logger } from '../lib/logger'
import { extractSubfsUris } from '../lib/wisp-utils'

export const siteRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/site',
		cookie: {
			secrets: cookieSecret,
			sign: ['did']
		}
	})
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
		.delete('/:rkey', async ({ params, auth }) => {
			const { rkey } = params

			if (!rkey) {
				return {
					success: false,
					error: 'Site rkey is required'
				}
			}

			try {
				// Create agent with OAuth session
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))

				// First, fetch the site record to find any subfs references
				let subfsUris: Array<{ uri: string; path: string }> = [];
				try {
					const existingRecord = await agent.com.atproto.repo.getRecord({
						repo: auth.did,
						collection: 'place.wisp.fs',
						rkey: rkey
					});

					if (existingRecord.data.value && typeof existingRecord.data.value === 'object' && 'root' in existingRecord.data.value) {
						const manifest = existingRecord.data.value as any;
						subfsUris = extractSubfsUris(manifest.root);

						if (subfsUris.length > 0) {
							console.log(`Found ${subfsUris.length} subfs records to delete`);
							logger.info(`[Site] Found ${subfsUris.length} subfs records associated with ${rkey}`);
						}
					}
				} catch (err) {
					// Record might not exist, continue with deletion
					console.log('Could not fetch site record for subfs cleanup, continuing...');
				}

				// Delete the main record from AT Protocol
				try {
					await agent.com.atproto.repo.deleteRecord({
						repo: auth.did,
						collection: 'place.wisp.fs',
						rkey: rkey
					})
					logger.info(`[Site] Deleted site ${rkey} from PDS for ${auth.did}`)
				} catch (err) {
					logger.error(`[Site] Failed to delete site ${rkey} from PDS`, err)
					throw new Error('Failed to delete site from AT Protocol')
				}

				// Delete associated subfs records
				if (subfsUris.length > 0) {
					console.log(`Deleting ${subfsUris.length} associated subfs records...`);

					await Promise.all(
						subfsUris.map(async ({ uri }) => {
							try {
								// Parse URI: at://did/collection/rkey
								const parts = uri.replace('at://', '').split('/');
								const subRkey = parts[2];

								await agent.com.atproto.repo.deleteRecord({
									repo: auth.did,
									collection: 'place.wisp.subfs',
									rkey: subRkey
								});

								console.log(`  🗑️  Deleted subfs: ${uri}`);
								logger.info(`[Site] Deleted subfs record: ${uri}`);
							} catch (err: any) {
								// Log but don't fail if subfs deletion fails
								console.warn(`Failed to delete subfs ${uri}:`, err?.message);
								logger.warn(`[Site] Failed to delete subfs ${uri}`, err);
							}
						})
					);

					logger.info(`[Site] Deleted ${subfsUris.length} subfs records for ${rkey}`);
				}

				// Delete from database
				const result = await deleteSite(auth.did, rkey)
				if (!result.success) {
					throw new Error('Failed to delete site from database')
				}

				logger.info(`[Site] Successfully deleted site ${rkey} for ${auth.did}`)

				return {
					success: true,
					message: 'Site deleted successfully'
				}
			} catch (err) {
				logger.error('[Site] Delete error', err)
				return {
					success: false,
					error: err instanceof Error ? err.message : 'Failed to delete site'
				}
			}
		})
		.get('/:rkey/settings', async ({ params, auth }) => {
			const { rkey } = params

			if (!rkey) {
				return {
					success: false,
					error: 'Site rkey is required'
				}
			}

			try {
				// Create agent with OAuth session
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))

				// Fetch settings record
				try {
					const record = await agent.com.atproto.repo.getRecord({
						repo: auth.did,
						collection: 'place.wisp.settings',
						rkey: rkey
					})

					if (record.data.value) {
						return record.data.value
					}
				} catch (err: any) {
					// Record doesn't exist, return defaults
					if (err?.error === 'RecordNotFound') {
						return {
							indexFiles: ['index.html'],
							cleanUrls: false,
							directoryListing: false
						}
					}
					throw err
				}

				// Default settings
				return {
					indexFiles: ['index.html'],
					cleanUrls: false,
					directoryListing: false
				}
			} catch (err) {
				logger.error('[Site] Get settings error', err)
				return {
					success: false,
					error: err instanceof Error ? err.message : 'Failed to fetch settings'
				}
			}
		})
		.post('/:rkey/settings', async ({ params, body, auth }) => {
			const { rkey } = params

			if (!rkey) {
				return {
					success: false,
					error: 'Site rkey is required'
				}
			}

			// Validate settings
			const settings = body as any

			// Ensure mutual exclusivity of routing modes
			const modes = [
				settings.spaMode,
				settings.directoryListing,
				settings.custom404
			].filter(Boolean)

			if (modes.length > 1) {
				return {
					success: false,
					error: 'Only one of spaMode, directoryListing, or custom404 can be enabled'
				}
			}

			try {
				// Create agent with OAuth session
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))

				// Create or update settings record
				const record = await agent.com.atproto.repo.putRecord({
					repo: auth.did,
					collection: 'place.wisp.settings',
					rkey: rkey,
					record: {
						$type: 'place.wisp.settings',
						...settings
					}
				})

				logger.info(`[Site] Saved settings for ${rkey} (${auth.did})`)

				return {
					success: true,
					uri: record.data.uri,
					cid: record.data.cid
				}
			} catch (err) {
				logger.error('[Site] Save settings error', err)
				return {
					success: false,
					error: err instanceof Error ? err.message : 'Failed to save settings'
				}
			}
		})
