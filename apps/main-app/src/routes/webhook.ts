import { Agent } from '@atproto/api'
import { TID } from '@atproto/common-web'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { MAX_WEBHOOK_SECRET_ID_LENGTH, WEBHOOK_SECRET_ID_PATTERN } from '@wispplace/atproto-utils'
import { createLogger } from '@wispplace/observability'
import { Elysia, t } from 'elysia'
import { consumeWebhookMutationRateLimit, getWebhookEventHistory, withWebhookOwnerMutationLock } from '../lib/db'
import {
	isWebhookOwnerAtCapacity,
	MAX_WEBHOOK_LIST_LIMIT,
	MAX_WEBHOOKS_PER_OWNER,
	normalizeWebhookListLimit,
	validateWebhookCreateInput,
} from '../lib/webhook-policy'
import { requireAuth, SESSION_COOKIE_NAME } from '../lib/wisp-auth'

const logger = createLogger('main-app')
const allowLoopbackWebhookDevelopment =
	process.env.NODE_ENV === 'development' && process.env.WISP_ALLOW_LOCALHOST_FETCH === '1'

type WebhookRequestErrorKind = 'limit_reached' | 'rate_limited'

class WebhookRequestError extends Error {
	constructor(readonly kind: WebhookRequestErrorKind) {
		super(kind)
	}
}

const createWebhookAgent = (fetchHandler: (pathname: string, init?: RequestInit) => Promise<Response>) =>
	new Agent((url, init) => fetchHandler(url, init))

const createResponseError = (kind: WebhookRequestErrorKind) =>
	kind === 'rate_limited' ? 'Webhook mutation rate limit exceeded' : 'Webhook limit reached'

export const webhookRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/webhook',
		cookie: { secrets: cookieSecret, sign: [SESSION_COOKIE_NAME] },
	})
		.derive(async ({ cookie, request }) => {
			const auth = await requireAuth(client, cookie, request.headers.get('cookie'))
			return { auth }
		})
		/**
		 * POST /api/webhook
		 * Creates a validated place.wisp.v2.wh record in the user's PDS.
		 */
		.post(
			'/',
			async ({ body, auth, set }) => {
				const validated = validateWebhookCreateInput(
					{ ...body, enabled: body.enabled ?? true },
					{ allowLoopbackDev: allowLoopbackWebhookDevelopment },
				)
				if (!validated.ok) {
					set.status = 400
					return { success: false, error: 'Invalid webhook request' }
				}

				try {
					return await withWebhookOwnerMutationLock(auth.did, async () => {
						if (!(await consumeWebhookMutationRateLimit(auth.did, 'create'))) {
							throw new WebhookRequestError('rate_limited')
						}

						const agent = createWebhookAgent(auth.session.fetchHandler)
						// Fetch one more than the cap while holding the primary owner lock.
						// Direct PDS writes still bypass this best-effort API protection and
						// are enforced independently by firehose intake.
						const existing = await agent.com.atproto.repo.listRecords({
							repo: auth.did,
							collection: 'place.wisp.v2.wh',
							limit: MAX_WEBHOOKS_PER_OWNER + 1,
						})
						if (isWebhookOwnerAtCapacity(existing.data.records.length)) {
							throw new WebhookRequestError('limit_reached')
						}

						const rkey = TID.nextStr()
						const result = await agent.com.atproto.repo.putRecord({
							repo: auth.did,
							collection: 'place.wisp.v2.wh',
							rkey,
							record: validated.record,
						})

						// Never include the endpoint or secret-bearing record in logs.
						logger.info(`[Webhook] Created webhook ${rkey} for ${auth.did}`)
						return { success: true, rkey, uri: result.data.uri }
					})
				} catch (error) {
					if (error instanceof WebhookRequestError) {
						set.status = 429
						return { success: false, error: createResponseError(error.kind) }
					}
					logger.error('[Webhook] Create failed')
					set.status = 500
					return { success: false, error: 'Failed to create webhook' }
				}
			},
			{
				body: t.Object({
					scopeAturi: t.String({ minLength: 1, maxLength: 2_048 }),
					url: t.String({ minLength: 1, maxLength: 2_048 }),
					backlinks: t.Optional(t.Boolean()),
					events: t.Optional(
						t.Array(t.Union([t.Literal('create'), t.Literal('update'), t.Literal('delete')]), {
							maxItems: 3,
							uniqueItems: true,
						}),
					),
					secret: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
					secretId: t.Optional(
						t.String({
							minLength: 1,
							maxLength: MAX_WEBHOOK_SECRET_ID_LENGTH,
							pattern: WEBHOOK_SECRET_ID_PATTERN,
						}),
					),
					enabled: t.Optional(t.Boolean()),
				}),
			},
		)
		/** DELETE /api/webhook/:rkey */
		.delete(
			'/:rkey',
			async ({ params, auth, set }) => {
				try {
					return await withWebhookOwnerMutationLock(auth.did, async () => {
						if (!(await consumeWebhookMutationRateLimit(auth.did, 'delete'))) {
							throw new WebhookRequestError('rate_limited')
						}
						const agent = createWebhookAgent(auth.session.fetchHandler)
						await agent.com.atproto.repo.deleteRecord({
							repo: auth.did,
							collection: 'place.wisp.v2.wh',
							rkey: params.rkey,
						})
						logger.info(`[Webhook] Deleted webhook ${params.rkey} for ${auth.did}`)
						return { success: true }
					})
				} catch (error) {
					if (error instanceof WebhookRequestError) {
						set.status = 429
						return { success: false, error: createResponseError(error.kind) }
					}
					logger.error('[Webhook] Delete failed')
					set.status = 500
					return { success: false, error: 'Failed to delete webhook' }
				}
			},
			{ params: t.Object({ rkey: t.String({ minLength: 1, maxLength: 512 }) }) },
		)
		/** GET /api/webhook with bounded cursor pagination. */
		.get(
			'/',
			async ({ auth, query, set }) => {
				try {
					const agent = createWebhookAgent(auth.session.fetchHandler)
					const result = await agent.com.atproto.repo.listRecords({
						repo: auth.did,
						collection: 'place.wisp.v2.wh',
						limit: normalizeWebhookListLimit(query.limit),
						...(query.cursor === undefined ? {} : { cursor: query.cursor }),
					})
					return {
						success: true,
						records: result.data.records,
						...(result.data.cursor === undefined ? {} : { cursor: result.data.cursor }),
					}
				} catch {
					logger.error('[Webhook] List failed')
					set.status = 500
					return { success: false, error: 'Failed to list webhooks' }
				}
			},
			{
				query: t.Object({
					cursor: t.Optional(t.String({ minLength: 1, maxLength: 1_024 })),
					limit: t.Optional(t.Numeric({ minimum: 1, maximum: MAX_WEBHOOK_LIST_LIMIT })),
				}),
			},
		)
		/** GET /api/webhook/events: owner-visible delivery history stays on primary. */
		.get('/events', async ({ auth, set }) => {
			try {
				const rows = await getWebhookEventHistory(auth.did)
				const events = rows.map((r) => ({
					ownerDid: auth.did,
					rkey: r.rkey,
					url: r.url,
					eventKind: r.event_kind,
					eventDid: r.event_did,
					eventCollection: r.event_collection,
					eventRkey: r.event_rkey,
					cid: r.cid ?? undefined,
					status: r.status,
					deliveredAt: r.delivered_at,
				}))
				return { success: true, events }
			} catch {
				logger.error('[Webhook] Events list failed')
				set.status = 500
				return { success: false, error: 'Failed to fetch events' }
			}
		})
