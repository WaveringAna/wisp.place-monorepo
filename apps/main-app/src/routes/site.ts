import { Agent } from '@atproto/api'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { walkOwnedSubfs } from '@wispplace/atproto-utils'
import { createLogger } from '@wispplace/observability'
import { Elysia } from 'elysia'
import { requireAuth, SESSION_COOKIE_NAME } from '../lib/wisp-auth'

const logger = createLogger('main-app')

export const siteRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/site',
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
		 * DELETE /api/site/:rkey
		 * Success: { success: true, message }
		 * Failure: { success: false, error }
		 */
		.delete('/:rkey', async ({ params, auth, set }) => {
			const { rkey } = params

			if (!rkey) {
				set.status = 400
				return {
					success: false,
					error: 'Site rkey is required',
				}
			}

			try {
				// Create agent with OAuth session
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))

				// First, find the site's own subfs records, including chunks that
				// hang off a parent subfs record
				let subfsRkeys: string[] = []
				try {
					const existingRecord = await agent.com.atproto.repo.getRecord({
						repo: auth.did,
						collection: 'place.wisp.fs',
						rkey: rkey,
					})

					if (
						existingRecord.data.value &&
						typeof existingRecord.data.value === 'object' &&
						'root' in existingRecord.data.value
					) {
						const manifest = existingRecord.data.value as any
						subfsRkeys = await walkOwnedSubfs(manifest.root, auth.did, async (subRkey) => {
							try {
								const record = await agent.com.atproto.repo.getRecord({
									repo: auth.did,
									collection: 'place.wisp.subfs',
									rkey: subRkey,
								})
								return (record.data.value as any)?.root ?? null
							} catch {
								return null
							}
						})

						if (subfsRkeys.length > 0) {
							logger.info(`[Site] Found ${subfsRkeys.length} subfs records associated with ${rkey}`)
						}
					}
				} catch (err) {
					// Record might not exist, continue with deletion.
					logger.warn('[Site] Could not fetch site record for subfs cleanup; continuing', { error: err })
				}

				// Delete the main record from AT Protocol
				try {
					await agent.com.atproto.repo.deleteRecord({
						repo: auth.did,
						collection: 'place.wisp.fs',
						rkey: rkey,
					})
					logger.info(`[Site] Deleted site ${rkey} from PDS for ${auth.did}`)
				} catch (err) {
					logger.error(`[Site] Failed to delete site ${rkey} from PDS`, err)
					throw new Error('Failed to delete site from AT Protocol')
				}

				// Delete associated subfs records
				if (subfsRkeys.length > 0) {
					logger.info(`[Site] Deleting ${subfsRkeys.length} associated subfs records for ${rkey}`)

					await Promise.all(
						subfsRkeys.map(async (subRkey) => {
							try {
								await agent.com.atproto.repo.deleteRecord({
									repo: auth.did,
									collection: 'place.wisp.subfs',
									rkey: subRkey,
								})

								logger.info(`[Site] Deleted subfs record: ${subRkey}`)
							} catch (err) {
								// Log but don't fail if subfs deletion fails.
								logger.error('[Site] Failed to delete subfs record', err, { rkey: subRkey })
							}
						}),
					)

					logger.info(`[Site] Deleted ${subfsRkeys.length} subfs records for ${rkey}`)
				}

				logger.info(`[Site] Successfully deleted site ${rkey} for ${auth.did}`)

				return {
					success: true,
					message: 'Site deleted successfully',
				}
			} catch (err) {
				logger.error('[Site] Delete error', err)
				set.status = 500
				return {
					success: false,
					error: 'Failed to delete site',
				}
			}
		})
		/**
		 * GET /api/site/:rkey/settings
		 * Success: place.wisp.settings record or default settings object.
		 * Failure: { success: false, error }
		 */
		.get('/:rkey/settings', async ({ params, auth, set }) => {
			const { rkey } = params

			if (!rkey) {
				set.status = 400
				return {
					success: false,
					error: 'Site rkey is required',
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
						rkey: rkey,
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
							directoryListing: false,
						}
					}
					throw err
				}

				// Default settings
				return {
					indexFiles: ['index.html'],
					cleanUrls: false,
					directoryListing: false,
				}
			} catch (err) {
				logger.error('[Site] Get settings error', err)
				set.status = 500
				return {
					success: false,
					error: 'Failed to fetch settings',
				}
			}
		})
		/**
		 * POST /api/site/:rkey/settings
		 * Success: { success: true, uri, cid }
		 * Failure: { success: false, error }
		 */
		.post('/:rkey/settings', async ({ params, body, auth, set }) => {
			const { rkey } = params

			if (!rkey) {
				set.status = 400
				return {
					success: false,
					error: 'Site rkey is required',
				}
			}

			// Validate settings
			const settings = body as any

			// Ensure mutual exclusivity of routing modes
			const modes = [settings.spaMode, settings.directoryListing, settings.custom404].filter(Boolean)

			if (modes.length > 1) {
				set.status = 400
				return {
					success: false,
					error: 'Only one of spaMode, directoryListing, or custom404 can be enabled',
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
						...settings,
					},
				})

				logger.info(`[Site] Saved settings for ${rkey} (${auth.did})`)

				return {
					success: true,
					uri: record.data.uri,
					cid: record.data.cid,
				}
			} catch (err) {
				logger.error('[Site] Save settings error', err)
				set.status = 500
				return {
					success: false,
					error: 'Failed to save settings',
				}
			}
		})
