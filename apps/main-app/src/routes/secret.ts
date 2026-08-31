import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { isValidWebhookSecretId, WEBHOOK_SECRET_ENCRYPTION_ERROR } from '@wispplace/atproto-utils'
import { createLogger } from '@wispplace/observability'
import { Elysia, t } from 'elysia'
import { createWebhookSecret, deleteWebhookSecret, listWebhookSecrets, rotateWebhookSecret } from '../lib/db'
import { requireAuth, SESSION_COOKIE_NAME } from '../lib/wisp-auth'

const logger = createLogger('main-app')
const isWebhookSecretEncryptionUnavailable = (error: unknown): boolean =>
	error instanceof Error && error.message === WEBHOOK_SECRET_ENCRYPTION_ERROR

const invalidSecretNameResponse = { success: false, error: 'Invalid secret name' }

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
			} catch {
				logger.error('[Secret] List failed')
				set.status = 500
				return { success: false, error: 'Failed to list secrets' }
			}
		})
		/**
		 * POST /api/secret
		 * Creates a new signing secret. Returns the token once; the database keeps only an encrypted envelope.
		 */
		.post(
			'/',
			async ({ body, auth, set }) => {
				if (!isValidWebhookSecretId(body.name)) {
					set.status = 400
					return invalidSecretNameResponse
				}
				try {
					const { token, createdAt } = await createWebhookSecret(auth.did, body.name)
					logger.info(`[Secret] Created secret "${body.name}" for ${auth.did}`)
					return { success: true, name: body.name, token, createdAt }
				} catch (error) {
					const message = error instanceof Error ? error.message : ''
					if (message === 'already_exists') {
						set.status = 409
						return { success: false, error: 'A secret with that name already exists' }
					}
					if (isWebhookSecretEncryptionUnavailable(error)) {
						set.status = 503
						return { success: false, error: WEBHOOK_SECRET_ENCRYPTION_ERROR }
					}
					logger.error('[Secret] Create failed')
					set.status = 500
					return { success: false, error: 'Failed to create secret' }
				}
			},
			{
				body: t.Object({
					// Canonical size/character validation is performed in the handler so
					// every invalid name receives the same generic 400 response.
					name: t.String(),
				}),
			},
		)
		/**
		 * DELETE /api/secret/:name
		 * Deletes a signing secret by name.
		 */
		.delete('/:name', async ({ params, auth, set }) => {
			if (!isValidWebhookSecretId(params.name)) {
				set.status = 400
				return invalidSecretNameResponse
			}
			try {
				const deleted = await deleteWebhookSecret(auth.did, params.name)
				if (!deleted) {
					set.status = 404
					return { success: false, error: 'Secret not found' }
				}
				logger.info(`[Secret] Deleted secret "${params.name}" for ${auth.did}`)
				return { success: true }
			} catch {
				logger.error('[Secret] Delete failed')
				set.status = 500
				return { success: false, error: 'Failed to delete secret' }
			}
		})
		/**
		 * POST /api/secret/:name/rotate
		 * Rotates a signing secret, returning the new token once.
		 */
		.post('/:name/rotate', async ({ params, auth, set }) => {
			if (!isValidWebhookSecretId(params.name)) {
				set.status = 400
				return invalidSecretNameResponse
			}
			try {
				const result = await rotateWebhookSecret(auth.did, params.name)
				if (!result) {
					set.status = 404
					return { success: false, error: 'Secret not found' }
				}
				logger.info(`[Secret] Rotated secret "${params.name}" for ${auth.did}`)
				return { success: true, name: params.name, token: result.token, rotatedAt: result.rotatedAt }
			} catch (error) {
				if (isWebhookSecretEncryptionUnavailable(error)) {
					set.status = 503
					return { success: false, error: WEBHOOK_SECRET_ENCRYPTION_ERROR }
				}
				logger.error('[Secret] Rotate failed')
				set.status = 500
				return { success: false, error: 'Failed to rotate secret' }
			}
		})
