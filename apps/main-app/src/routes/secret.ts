import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { createLogger } from '@wispplace/observability'
import { Elysia, t } from 'elysia'
import { createWebhookSecret, deleteWebhookSecret, listWebhookSecrets, rotateWebhookSecret } from '../lib/db'
import { requireAuth, SESSION_COOKIE_NAME } from '../lib/wisp-auth'

const logger = createLogger('main-app')

export const secretRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/secret',
		cookie: { secrets: cookieSecret, sign: [SESSION_COOKIE_NAME] },
	})
		.derive(async ({ cookie, request }) => {
			const auth = await requireAuth(client, cookie, request.headers.get('cookie'))
			return { auth }
		})
		/**
		 * GET /api/secret
		 * Lists signing secrets (names + metadata only, never tokens) for the authenticated user.
		 */
		.get('/', async ({ auth, set }) => {
			try {
				const secrets = await listWebhookSecrets(auth.did)
				return { success: true, secrets }
			} catch (err) {
				logger.error('[Secret] List error', err)
				set.status = 500
				return { success: false, error: 'Failed to list secrets' }
			}
		})
		/**
		 * POST /api/secret
		 * Creates a new signing secret. Returns the token once — it is not stored in plaintext.
		 */
		.post(
			'/',
			async ({ body, auth, set }) => {
				try {
					const { token, createdAt } = await createWebhookSecret(auth.did, body.name)
					logger.info(`[Secret] Created secret "${body.name}" for ${auth.did}`)
					return { success: true, name: body.name, token, createdAt }
				} catch (err) {
					const msg = err instanceof Error ? err.message : ''
					if (msg === 'already_exists') {
						set.status = 409
						return { success: false, error: 'A secret with that name already exists' }
					}
					logger.error('[Secret] Create error', err)
					set.status = 500
					return { success: false, error: 'Failed to create secret' }
				}
			},
			{
				body: t.Object({
					name: t.String({ minLength: 1 }),
				}),
			},
		)
		/**
		 * DELETE /api/secret/:name
		 * Deletes a signing secret by name.
		 */
		.delete('/:name', async ({ params, auth, set }) => {
			try {
				const deleted = await deleteWebhookSecret(auth.did, params.name)
				if (!deleted) {
					set.status = 404
					return { success: false, error: 'Secret not found' }
				}
				logger.info(`[Secret] Deleted secret "${params.name}" for ${auth.did}`)
				return { success: true }
			} catch (err) {
				logger.error('[Secret] Delete error', err)
				set.status = 500
				return { success: false, error: 'Failed to delete secret' }
			}
		})
		/**
		 * POST /api/secret/:name/rotate
		 * Rotates a signing secret, returning the new token once.
		 */
		.post('/:name/rotate', async ({ params, auth, set }) => {
			try {
				const result = await rotateWebhookSecret(auth.did, params.name)
				if (!result) {
					set.status = 404
					return { success: false, error: 'Secret not found' }
				}
				logger.info(`[Secret] Rotated secret "${params.name}" for ${auth.did}`)
				return { success: true, name: params.name, token: result.token, rotatedAt: result.rotatedAt }
			} catch (err) {
				logger.error('[Secret] Rotate error', err)
				set.status = 500
				return { success: false, error: 'Failed to rotate secret' }
			}
		})
