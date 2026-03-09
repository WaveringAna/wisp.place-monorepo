import { Agent } from '@atproto/api'
import { TID } from '@atproto/common-web'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { createLogger } from '@wispplace/observability'
import { Elysia, t } from 'elysia'
import { db } from '../lib/db'
import { requireAuth } from '../lib/wisp-auth'

const logger = createLogger('main-app')

export const webhookRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/webhook',
		cookie: { secrets: cookieSecret, sign: ['did'] },
	})
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
		/**
		 * POST /api/webhook
		 * Creates a place.wisp.v2.wh record in the user's PDS.
		 * The webhook service will pick it up from the firehose.
		 * Success: { success: true, rkey, uri }
		 */
		.post(
			'/',
			async ({ body, auth, set }) => {
				try {
					const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
					const rkey = TID.nextStr()
					const record = {
						$type: 'place.wisp.v2.wh',
						scope: {
							aturi: body.scopeAturi,
							...(body.backlinks ? { backlinks: true } : {}),
						},
						url: body.url,
						...(body.events && body.events.length > 0 ? { events: body.events } : {}),
						...(body.secret ? { secret: body.secret } : {}),
						enabled: body.enabled ?? true,
						createdAt: new Date().toISOString(),
					}

					const result = await agent.com.atproto.repo.putRecord({
						repo: auth.did,
						collection: 'place.wisp.v2.wh',
						rkey,
						record,
					})

					logger.info(`[Webhook] Created webhook ${rkey} for ${auth.did} → ${body.url}`)

					return { success: true, rkey, uri: result.data.uri }
				} catch (err) {
					logger.error('[Webhook] Create error', err)
					set.status = 500
					return { success: false, error: err instanceof Error ? err.message : 'Failed to create webhook' }
				}
			},
			{
				body: t.Object({
					scopeAturi: t.String(),
					url: t.String(),
					backlinks: t.Optional(t.Boolean()),
					events: t.Optional(t.Array(t.Union([t.Literal('create'), t.Literal('update'), t.Literal('delete')]))),
					secret: t.Optional(t.String()),
					enabled: t.Optional(t.Boolean()),
				}),
			},
		)
		/**
		 * DELETE /api/webhook/:rkey
		 * Deletes a place.wisp.v2.wh record from the user's PDS.
		 */
		.delete('/:rkey', async ({ params, auth, set }) => {
			try {
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
				await agent.com.atproto.repo.deleteRecord({
					repo: auth.did,
					collection: 'place.wisp.v2.wh',
					rkey: params.rkey,
				})
				logger.info(`[Webhook] Deleted webhook ${params.rkey} for ${auth.did}`)
				return { success: true }
			} catch (err) {
				logger.error('[Webhook] Delete error', err)
				set.status = 500
				return { success: false, error: err instanceof Error ? err.message : 'Failed to delete webhook' }
			}
		})
		/**
		 * GET /api/webhook
		 * Lists the user's place.wisp.v2.wh records from their PDS.
		 */
		.get('/', async ({ auth, set }) => {
			try {
				const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
				const result = await agent.com.atproto.repo.listRecords({
					repo: auth.did,
					collection: 'place.wisp.v2.wh',
					limit: 100,
				})
				return { success: true, records: result.data.records }
			} catch (err) {
				logger.error('[Webhook] List error', err)
				set.status = 500
				return { success: false, error: err instanceof Error ? err.message : 'Failed to list webhooks' }
			}
		})
		/**
		 * GET /api/webhook/events
		 * Returns the 100 most recent delivery events for the authenticated user from the shared DB.
		 */
		.get('/events', async ({ auth, set }) => {
			try {
				const rows = await db<
					Array<{
						rkey: string
						url: string
						event_kind: string
						event_did: string
						event_collection: string
						event_rkey: string
						cid: string | null
						status: string
						delivered_at: string
					}>
				>`
					SELECT rkey, url, event_kind, event_did, event_collection, event_rkey, cid, status, delivered_at
					FROM webhook_event_logs
					WHERE owner_did = ${auth.did}
					ORDER BY delivered_at DESC
					LIMIT 100
				`
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
			} catch (err) {
				logger.error('[Webhook] Events list error', err)
				set.status = 500
				return { success: false, error: 'Failed to fetch events' }
			}
		})
