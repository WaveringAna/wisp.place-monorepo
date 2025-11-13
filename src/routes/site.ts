import { Elysia } from 'elysia'
import { requireAuth } from '../lib/wisp-auth'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Agent } from '@atproto/api'
import { deleteSite } from '../lib/db'
import { logger } from '../lib/logger'

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

				// Delete the record from AT Protocol
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
