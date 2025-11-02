// Admin API routes
import { Elysia, t } from 'elysia'
import { adminAuth, requireAdmin } from '../lib/admin-auth'
import { logCollector, errorTracker, metricsCollector } from '../lib/observability'
import { db } from '../lib/db'

export const adminRoutes = () =>
	new Elysia({ prefix: '/api/admin' })
		// Login
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
					maxAge: 24 * 60 * 60 // 24 hours
				})

				return { success: true }
			},
			{
				body: t.Object({
					username: t.String(),
					password: t.String()
				})
			}
		)

		// Logout
		.post('/logout', ({ cookie }) => {
			const sessionId = cookie.admin_session?.value
			if (sessionId && typeof sessionId === 'string') {
				adminAuth.deleteSession(sessionId)
			}
			cookie.admin_session.remove()
			return { success: true }
		})

		// Check auth status
		.get('/status', ({ cookie }) => {
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
				username: session.username
			}
		})

		// Get logs (protected)
		.get('/logs', async ({ query, cookie, set }) => {
			const check = requireAdmin({ cookie, set })
			if (check) return check

			const filter: any = {}

			if (query.level) filter.level = query.level
			if (query.service) filter.service = query.service
			if (query.search) filter.search = query.search
			if (query.eventType) filter.eventType = query.eventType
			if (query.limit) filter.limit = parseInt(query.limit as string)

			// Get logs from main app
			const mainLogs = logCollector.getLogs(filter)

			// Get logs from hosting service
			let hostingLogs: any[] = []
			try {
				const hostingPort = process.env.HOSTING_PORT || '3001'
				const params = new URLSearchParams()
				if (query.level) params.append('level', query.level as string)
				if (query.service) params.append('service', query.service as string)
				if (query.search) params.append('search', query.search as string)
				if (query.eventType) params.append('eventType', query.eventType as string)
				params.append('limit', String(filter.limit || 100))

				const response = await fetch(`http://localhost:${hostingPort}/__internal__/observability/logs?${params}`)
				if (response.ok) {
					const data = await response.json()
					hostingLogs = data.logs
				}
			} catch (err) {
				// Hosting service might not be running
			}

			// Merge and sort by timestamp
			const allLogs = [...mainLogs, ...hostingLogs].sort((a, b) =>
				new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
			)

			return { logs: allLogs.slice(0, filter.limit || 100) }
		})

		// Get errors (protected)
		.get('/errors', async ({ query, cookie, set }) => {
			const check = requireAdmin({ cookie, set })
			if (check) return check

			const filter: any = {}

			if (query.service) filter.service = query.service
			if (query.limit) filter.limit = parseInt(query.limit as string)

			// Get errors from main app
			const mainErrors = errorTracker.getErrors(filter)

			// Get errors from hosting service
			let hostingErrors: any[] = []
			try {
				const hostingPort = process.env.HOSTING_PORT || '3001'
				const params = new URLSearchParams()
				if (query.service) params.append('service', query.service as string)
				params.append('limit', String(filter.limit || 100))

				const response = await fetch(`http://localhost:${hostingPort}/__internal__/observability/errors?${params}`)
				if (response.ok) {
					const data = await response.json()
					hostingErrors = data.errors
				}
			} catch (err) {
				// Hosting service might not be running
			}

			// Merge and sort by last seen
			const allErrors = [...mainErrors, ...hostingErrors].sort((a, b) =>
				new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
			)

			return { errors: allErrors.slice(0, filter.limit || 100) }
		})

		// Get metrics (protected)
		.get('/metrics', async ({ query, cookie, set }) => {
			const check = requireAdmin({ cookie, set })
			if (check) return check

			const timeWindow = query.timeWindow
				? parseInt(query.timeWindow as string)
				: 3600000 // 1 hour default

			const mainAppStats = metricsCollector.getStats('main-app', timeWindow)
			const overallStats = metricsCollector.getStats(undefined, timeWindow)

			// Get hosting service stats from its own endpoint
			let hostingServiceStats = {
				totalRequests: 0,
				avgDuration: 0,
				p50Duration: 0,
				p95Duration: 0,
				p99Duration: 0,
				errorRate: 0,
				requestsPerMinute: 0
			}

			try {
				const hostingPort = process.env.HOSTING_PORT || '3001'
				const response = await fetch(`http://localhost:${hostingPort}/__internal__/observability/metrics?timeWindow=${timeWindow}`)
				if (response.ok) {
					const data = await response.json()
					hostingServiceStats = data.stats
				}
			} catch (err) {
				// Hosting service might not be running
			}

			return {
				overall: overallStats,
				mainApp: mainAppStats,
				hostingService: hostingServiceStats,
				timeWindow
			}
		})

		// Get database stats (protected)
		.get('/database', async ({ cookie, set }) => {
			const check = requireAdmin({ cookie, set })
			if (check) return check

			try {
				// Get total counts
				const allSitesResult = await db`SELECT COUNT(*) as count FROM sites`
				const wispSubdomainsResult = await db`SELECT COUNT(*) as count FROM domains WHERE domain LIKE '%.wisp.place'`
				const customDomainsResult = await db`SELECT COUNT(*) as count FROM custom_domains WHERE verified = true`

				// Get recent sites (including those without domains)
				const recentSites = await db`
					SELECT 
						s.did,
						s.rkey,
						s.display_name,
						s.created_at,
						d.domain as subdomain
					FROM sites s
					LEFT JOIN domains d ON s.did = d.did AND s.rkey = d.rkey AND d.domain LIKE '%.wisp.place'
					ORDER BY s.created_at DESC
					LIMIT 10
				`

				// Get recent domains
				const recentDomains = await db`SELECT domain, did, rkey, verified, created_at FROM custom_domains ORDER BY created_at DESC LIMIT 10`

				return {
					stats: {
						totalSites: allSitesResult[0].count,
						totalWispSubdomains: wispSubdomainsResult[0].count,
						totalCustomDomains: customDomainsResult[0].count
					},
					recentSites: recentSites,
					recentDomains: recentDomains
				}
			} catch (error) {
				set.status = 500
				return {
					error: 'Failed to fetch database stats',
					message: error instanceof Error ? error.message : String(error)
				}
			}
		})

		// Get sites listing (protected)
		.get('/sites', async ({ query, cookie, set }) => {
			const check = requireAdmin({ cookie, set })
			if (check) return check

			const limit = query.limit ? parseInt(query.limit as string) : 50
			const offset = query.offset ? parseInt(query.offset as string) : 0

			try {
				const sites = await db`
					SELECT 
						s.did,
						s.rkey,
						s.display_name,
						s.created_at,
						d.domain as subdomain
					FROM sites s
					LEFT JOIN domains d ON s.did = d.did AND s.rkey = d.rkey AND d.domain LIKE '%.wisp.place'
					ORDER BY s.created_at DESC
					LIMIT ${limit} OFFSET ${offset}
				`

				const customDomains = await db`
					SELECT
						domain,
						did,
						rkey,
						verified,
						created_at
					FROM custom_domains
					ORDER BY created_at DESC
					LIMIT ${limit} OFFSET ${offset}
				`

				return {
					sites: sites,
					customDomains: customDomains
				}
			} catch (error) {
				set.status = 500
				return {
					error: 'Failed to fetch sites',
					message: error instanceof Error ? error.message : String(error)
				}
			}
		})

		// Get system health (protected)
		.get('/health', ({ cookie, set }) => {
			const check = requireAdmin({ cookie, set })
			if (check) return check

			const uptime = process.uptime()
			const memory = process.memoryUsage()

			return {
				uptime: Math.floor(uptime),
				memory: {
					heapUsed: Math.round(memory.heapUsed / 1024 / 1024), // MB
					heapTotal: Math.round(memory.heapTotal / 1024 / 1024), // MB
					rss: Math.round(memory.rss / 1024 / 1024) // MB
				},
				timestamp: new Date().toISOString()
			}
		})

