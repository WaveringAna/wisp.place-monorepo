// Admin API routes

import { createLogger } from '@wispplace/observability'
import { Elysia, t } from 'elysia'
import { adminAuth, requireAdmin } from '../lib/admin-auth'
import { addSupporter, eventualRead, getAdminDatabaseReport, removeSupporter } from '../lib/db'
import { SlingshotHandleResolver } from '../lib/slingshot-handle-resolver'

const logger = createLogger('main-app')

export const adminRoutes = (cookieSecret: string) =>
	new Elysia({
		prefix: '/api/admin',
		cookie: {
			secrets: cookieSecret,
			sign: ['admin_session'],
		},
	})
		// Login
		/**
		 * POST /api/admin/login
		 * Success: { success: true } with admin_session cookie set.
		 * Failure (401): { error: 'Invalid credentials' }
		 */
		.post(
			'/login',
			async ({ body, cookie, set }) => {
				const { username, password } = body

				const valid = await adminAuth.verify(username, password)
				if (!valid) {
					set.status = 401
					return { error: 'Invalid credentials' }
				}

				const sessionId = adminAuth.createSession(username)

				// Set cookie
				cookie.admin_session.set({
					value: sessionId,
					httpOnly: true,
					secure: process.env.NODE_ENV === 'production',
					sameSite: 'lax',
					maxAge: 24 * 60 * 60, // 24 hours
				})

				return { success: true }
			},
			{
				body: t.Object({
					username: t.String(),
					password: t.String(),
				}),
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)

		// Logout
		/**
		 * POST /api/admin/logout
		 * Success: { success: true } and clears admin_session cookie.
		 */
		.post(
			'/logout',
			({ cookie }) => {
				const sessionId = cookie.admin_session?.value
				if (sessionId && typeof sessionId === 'string') {
					adminAuth.deleteSession(sessionId)
				}
				cookie.admin_session.remove()
				return { success: true }
			},
			{
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)

		// Check auth status
		/**
		 * GET /api/admin/status
		 * Authenticated: { authenticated: true, username }
		 * Not authenticated: { authenticated: false }
		 */
		.get(
			'/status',
			({ cookie }) => {
				const sessionId = cookie.admin_session?.value
				if (!sessionId || typeof sessionId !== 'string') {
					return { authenticated: false }
				}

				const session = adminAuth.verifySession(sessionId)
				if (!session) {
					return { authenticated: false }
				}

				return {
					authenticated: true,
					username: session.username,
				}
			},
			{
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)

		// Get database stats (protected)
		/**
		 * GET /api/admin/database
		 * Success: { stats, recentSites, recentDomains, siteCacheStats }
		 * Failure (500): { error, message }
		 */
		.get(
			'/database',
			async ({ cookie, set }) => {
				const check = requireAdmin({ cookie, set })
				if (check) return check

				try {
					// Includes cache/configuration metadata, so this report stays primary.
					return await getAdminDatabaseReport()
				} catch (error) {
					logger.error('[Admin] Failed to fetch database stats', error)
					set.status = 500
					return {
						error: 'Failed to fetch database stats',
						message: 'Unable to retrieve database stats',
					}
				}
			},
			{
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)

		// Get sites listing (protected)
		/**
		 * GET /api/admin/sites
		 * Success: { sites, customDomains }
		 * Failure (500): { error, message }
		 */
		.get(
			'/sites',
			async ({ query, cookie, set }) => {
				const check = requireAdmin({ cookie, set })
				if (check) return check

				const limit = query.limit ? parseInt(query.limit as string, 10) : 50
				const offset = query.offset ? parseInt(query.offset as string, 10) : 0

				try {
					// Reporting only: this explicitly permits a lagging local replica.
					return await eventualRead.getAdminSites(limit, offset)
				} catch (error) {
					logger.error('[Admin] Failed to fetch sites', error)
					set.status = 500
					return {
						error: 'Failed to fetch sites',
						message: 'Unable to retrieve sites',
					}
				}
			},
			{
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)

		// Get firehose worker status (protected)
		/**
		 * GET /api/admin/firehose
		 * Success: firehose health data from firehose-service
		 * Failure (503|500): { error, message }
		 */
		.get(
			'/firehose',
			async ({ cookie, set }) => {
				const check = requireAdmin({ cookie, set })
				if (check) return check

				try {
					const firehoseServiceUrl =
						process.env.FIREHOSE_SERVICE_URL || `http://localhost:${process.env.FIREHOSE_PORT || '3002'}`
					const response = await fetch(`${firehoseServiceUrl}/health`)

					if (response.ok) {
						const data = await response.json()
						return data
					} else {
						set.status = 503
						return {
							error: 'Failed to fetch firehose status',
							message: 'Firehose service unavailable',
						}
					}
				} catch (error) {
					logger.error('[Admin] Failed to fetch firehose status', error)
					set.status = 500
					return {
						error: 'Failed to fetch firehose status',
						message: 'Firehose service unavailable',
					}
				}
			},
			{
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)

		// Get system health (protected)
		/**
		 * GET /api/admin/health
		 * Success: { uptime, memory, timestamp }
		 * Unauthorized (401): { error: 'Unauthorized' }
		 */
		.get(
			'/health',
			({ cookie, set }) => {
				const check = requireAdmin({ cookie, set })
				if (check) return check

				const uptime = process.uptime()
				const memory = process.memoryUsage()

				return {
					uptime: Math.floor(uptime),
					memory: {
						heapUsed: Math.round(memory.heapUsed / 1024 / 1024), // MB
						heapTotal: Math.round(memory.heapTotal / 1024 / 1024), // MB
						rss: Math.round(memory.rss / 1024 / 1024), // MB
					},
					timestamp: new Date().toISOString(),
				}
			},
			{
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)

		// Get all supporters (protected)
		/**
		 * GET /api/admin/supporters
		 * Success: { supporters }
		 * Unauthorized (401): { error: 'Unauthorized' }
		 */
		.get(
			'/supporters',
			async ({ cookie, set }) => {
				const check = requireAdmin({ cookie, set })
				if (check) return check

				try {
					// This is an admin report. Supporter checks used for domain limits stay primary.
					const supporters = await eventualRead.getAdminSupporters()
					return { supporters }
				} catch (error) {
					logger.error('[Admin] Failed to fetch supporters', error)
					set.status = 500
					return {
						error: 'Failed to fetch supporters',
						message: 'Unable to retrieve supporters',
					}
				}
			},
			{
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)

		// Add supporter (protected)
		/**
		 * POST /api/admin/supporters
		 * Body: { identifier } - can be a handle or DID
		 * Success: { success: true, did }
		 * Failure (400): { error, message }
		 */
		.post(
			'/supporters',
			async ({ body, cookie, set }) => {
				const check = requireAdmin({ cookie, set })
				if (check) return check

				try {
					const { identifier } = body
					let did = identifier.trim()

					// If it's not a DID, treat it as a handle and resolve it
					if (!did.startsWith('did:')) {
						const handleResolver = new SlingshotHandleResolver()
						const resolvedDid = await handleResolver.resolve(did)

						if (!resolvedDid) {
							set.status = 400
							return {
								error: 'Invalid handle',
								message: `Could not resolve handle: ${did}`,
							}
						}

						did = resolvedDid
					}

					// Add to supporters table
					await addSupporter(did)

					return {
						success: true,
						did,
					}
				} catch (error) {
					logger.error('[Admin] Failed to add supporter', error)
					set.status = 500
					return {
						error: 'Failed to add supporter',
						message: 'Unable to add supporter',
					}
				}
			},
			{
				body: t.Object({
					identifier: t.String(),
				}),
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)

		// Remove supporter (protected)
		/**
		 * DELETE /api/admin/supporters/:did
		 * Success: { success: true }
		 * Unauthorized (401): { error: 'Unauthorized' }
		 */
		.delete(
			'/supporters/:did',
			async ({ params, cookie, set }) => {
				const check = requireAdmin({ cookie, set })
				if (check) return check

				try {
					const { did } = params
					await removeSupporter(did)

					return { success: true }
				} catch (error) {
					logger.error('[Admin] Failed to remove supporter', error)
					set.status = 500
					return {
						error: 'Failed to remove supporter',
						message: 'Unable to remove supporter',
					}
				}
			},
			{
				cookie: t.Cookie(
					{
						admin_session: t.Optional(t.String()),
					},
					{
						secrets: cookieSecret,
						sign: ['admin_session'],
					},
				),
			},
		)
