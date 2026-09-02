// Fix for Elysia issue with Bun, (see https://github.com/oven-sh/bun/issues/12161)
process.getBuiltinModule = require

import { cors } from '@elysiajs/cors'
import { staticPlugin } from '@elysiajs/static'
import { closePinnedKeepAliveAgents } from '@wispplace/atproto-utils'
import { BASE_HOST, MAX_PUBLIC_UPLOAD_REQUEST_SIZE } from '@wispplace/constants'
import { createLogger, initializeGrafanaExporters, logCollector, redactSecretPath } from '@wispplace/observability'
import { observabilityMiddleware } from '@wispplace/observability/middleware/elysia'
import type { Context } from 'elysia'
import { Elysia } from 'elysia'
import { promptAdminSetup } from './lib/admin-auth'
import { csrfProtection } from './lib/csrf'
import {
	closeDatabase,
	connectionWarmingIntervalMs,
	getCookieSecret,
	getDatabaseReadHealth,
	getWebhookSecretEncryptionHealth,
	hasSeparateDatabaseReadPool,
	pruneAnalyticsData,
	warmPrimaryConnections,
} from './lib/db'
import { type DNSVerificationLogLevel, DNSVerificationWorker } from './lib/dns-verification-worker'
import { startPeriodicSingleFlightTask, stopServerWithGracePeriod } from './lib/lifecycle'
import {
	cleanupExpiredSessions,
	closeOAuthLockDatabase,
	createClientMetadata,
	getCurrentKeys,
	getOAuthClient,
	rotateKeysIfNeeded,
	warmOAuthLockConnection,
} from './lib/oauth-client'
import { startPrivateSiteReaper } from './lib/private-site-reaper'
import { pruneHandoffs, pruneSessions } from './lib/private-sites-db'
import { getPublicUploadRequestGateStats } from './lib/public-upload-gate'
import { getPublicUploadLifecycleStats, stopAndDrainPublicUploads } from './lib/public-upload-lifecycle'
import { closeRedisClient, getConnectedRedisClient } from './lib/redis'
import { requestBodyAdmission } from './lib/request-body-admission'
import { ensureServiceIdentityKeypair } from './lib/service-identity'
import { closeSiteUploadLockDatabase } from './lib/site-upload-lock'
import type { Config } from './lib/types'
import { SESSION_COOKIE_NAME } from './lib/wisp-auth'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { domainRoutes } from './routes/domain'
import { privateRedeemRoutes } from './routes/private-redeem'
import { privateSiteApiRoutes } from './routes/private-site-api'
import { secretRoutes } from './routes/secret'
import { siteRoutes } from './routes/site'
import { userRoutes } from './routes/user'
import { webhookRoutes } from './routes/webhook'
import { wispRoutes } from './routes/wisp'
import { xrpcRoutes } from './routes/xrpc'

// Initialize Grafana exporters if configured
initializeGrafanaExporters({
	serviceName: 'main-app',
	serviceVersion: '1.0.50',
})

const logger = createLogger('main-app')
const isLocalDev = Bun.env.LOCAL_DEV === 'true'
const oauthAuthorizationServer = Bun.env.OAUTH_AUTHORIZATION_SERVER ?? 'https://atproto.wisp.place'
const defaultServiceDid = isLocalDev ? 'did:web:localhost' : 'did:web:wisp.place'
const serviceDid = Bun.env.SERVICE_DID ?? defaultServiceDid
const parsedServiceIds = (Bun.env.SERVICE_IDS ?? '')
	.split(',')
	.map((id) => id.trim())
	.filter((id) => id.length > 0 && id.startsWith('#'))
const didServiceIds = parsedServiceIds.length > 0 ? Array.from(new Set(parsedServiceIds)) : ['#wisp_xrpc']
const serverPort = Number(Bun.env.PORT ?? (isLocalDev ? '8000' : '80'))

const databaseReadHealth = await getDatabaseReadHealth()
logger.info('[Server] Startup config', {
	isLocalDev,
	port: serverPort,
	separateDatabaseReadPoolConfigured: hasSeparateDatabaseReadPool,
	databaseReadEndpointMode: databaseReadHealth.mode,
	databaseReadFallbackToPrimary: databaseReadHealth.usingPrimaryFallback,
})

const config: Config = {
	domain: (Bun.env.DOMAIN ?? `https://${BASE_HOST}`) as Config['domain'],
	clientName: Bun.env.CLIENT_NAME ?? 'PDS-View',
}

// Initialize admin setup (prompt if no admin exists)
await promptAdminSetup()

// Establish Redis early for durable domain-cache invalidation, without blocking startup.
void getConnectedRedisClient().catch(() => {
	logger.error('[Redis] Initial connection failed')
})

// Get or generate cookie signing secret
const cookieSecret = await getCookieSecret()
const serviceIdentity = await ensureServiceIdentityKeypair(
	Bun.env.SERVICE_PUBLIC_KEY_MULTIBASE ?? null,
	Bun.env.SERVICE_PRIVATE_KEY_MULTIBASE ?? null,
)
const servicePublicKeyMultibase = serviceIdentity.publicKeyMultibase

const client = await getOAuthClient(config)

// Periodic maintenance runs immediately, then hourly. Slow passes share one
// single-flight task so they cannot overlap with later interval ticks.
const runMaintenance = async (): Promise<void> => {
	console.log('[Maintenance] Running periodic maintenance...')
	await cleanupExpiredSessions()
	await rotateKeysIfNeeded()
	await pruneHandoffs()
	await pruneSessions()
	await pruneAnalyticsData()
}

const maintenance = startPeriodicSingleFlightTask(runMaintenance, 60 * 60 * 1000, () =>
	logger.error('[Maintenance] Periodic maintenance failed'),
)

// Keeping a connection open is not an optimisation here so much as removing a
// fixed cost: a cold primary connection from a remote region costs more than
// every query in a sign-in put together.
//
// Warming is best effort. Missing a cycle only means the next request pays to
// establish its own connection, which is what happened before this existed, so
// a single miss is not worth an error line. Sustained failure is, because it
// means the primary is unreachable.
const CONNECTION_WARMING_ALARM_AFTER = 5
let consecutiveWarmingFailures = 0

const connectionWarming = startPeriodicSingleFlightTask(
	async () => {
		try {
			await Promise.all([warmPrimaryConnections(), warmOAuthLockConnection()])
			consecutiveWarmingFailures = 0
		} catch (err) {
			consecutiveWarmingFailures += 1
			// Driver errors can carry a connection URL, so only the class is logged.
			const detail = {
				consecutiveFailures: consecutiveWarmingFailures,
				errorName: err instanceof Error ? err.name : 'unknown',
			}
			if (consecutiveWarmingFailures >= CONNECTION_WARMING_ALARM_AFTER) {
				logger.error('[Database] Connection warming has failed repeatedly', detail)
			} else {
				logger.debug('[Database] Connection warming missed a cycle', detail)
			}
		}
	},
	connectionWarmingIntervalMs,
	// The task above handles its own failures, so this only catches a bug in it.
	() => logger.error('[Database] Connection warming task crashed'),
)

const privateSiteReaper = startPrivateSiteReaper()

// Start DNS verification worker (runs every 10 minutes)
// Can be disabled via DISABLE_DNS_WORKER=true environment variable
const dnsVerifier = new DNSVerificationWorker(
	10 * 60 * 1000, // 10 minutes
	(msg, data, level: DNSVerificationLogLevel = 'info') => {
		const context = data ? { data } : undefined
		if (level === 'error') {
			logCollector.error(`[DNS Verifier] ${msg}`, 'main-app', undefined, context)
		} else if (level === 'warn') {
			logCollector.warn(`[DNS Verifier] ${msg}`, 'main-app', context)
		} else {
			logCollector.info(`[DNS Verifier] ${msg}`, 'main-app', context)
		}
	},
)

if (Bun.env.DISABLE_DNS_WORKER !== 'true') {
	dnsVerifier.start()
	logger.info('DNS Verifier Started - checking custom domains every 10 minutes')
} else {
	logger.info('DNS Verifier disabled via DISABLE_DNS_WORKER environment variable')
}

export const app = new Elysia({
	serve: {
		maxRequestBodySize: MAX_PUBLIC_UPLOAD_REQUEST_SIZE,
		development: Bun.env.NODE_ENV !== 'production',
		id: Bun.env.NODE_ENV !== 'production' ? undefined : null,
	},
	cookie: {
		secrets: cookieSecret,
		sign: [SESSION_COOKIE_NAME],
	},
})
	// Observability middleware
	.onBeforeHandle(observabilityMiddleware('main-app').beforeHandle)
	.onRequest(({ request }) => {
		const admissionError = requestBodyAdmission.admit(request)
		if (admissionError) return admissionError
		if (isLocalDev) {
			const pathname = redactSecretPath(new URL(request.url).pathname)
			if (pathname.startsWith('/xrpc/')) {
				console.log('[Server] Incoming /xrpc request', {
					method: request.method,
					path: pathname,
				})
			}
		}
	})
	.onAfterResponse(({ request }) => {
		requestBodyAdmission.release(request)
	})
	.onAfterHandle((ctx: Context) => {
		observabilityMiddleware('main-app').afterHandle(ctx)
		// Security headers middleware
		const { set } = ctx
		// Prevent clickjacking attacks
		set.headers['X-Frame-Options'] = 'DENY'
		// Prevent MIME type sniffing
		set.headers['X-Content-Type-Options'] = 'nosniff'
		// Strict Transport Security (HSTS) - enforce HTTPS
		set.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
		// Referrer policy - limit referrer information
		set.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
		// Content Security Policy
		set.headers['Content-Security-Policy'] =
			"default-src 'self'; " +
			"script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
			"style-src 'self' 'unsafe-inline'; " +
			"img-src 'self' data: https:; " +
			"font-src 'self' data:; " +
			"connect-src 'self' https:; " +
			"frame-ancestors 'none'; " +
			"base-uri 'self'; " +
			"form-action 'self'"
		// Additional security headers
		set.headers['X-XSS-Protection'] = '1; mode=block'
		set.headers['Permissions-Policy'] = 'geolocation=(), microphone=(), camera=()'
	})
	.onError((context) => {
		requestBodyAdmission.release(context.request)
		// Call observability error handler first
		observabilityMiddleware('main-app').onError(context)

		const { error, set, code } = context as any

		// Determine appropriate status code
		let statusCode = 500
		let errorMessage = 'Internal server error'

		if (error instanceof Error) {
			errorMessage = error.message

			// Map common error patterns to status codes
			if (errorMessage.includes('not found') || errorMessage.includes('Not found')) {
				statusCode = 404
			} else if (errorMessage.includes('Unauthorized') || errorMessage.includes('unauthorized')) {
				statusCode = 401
			} else if (errorMessage.includes('Forbidden') || errorMessage.includes('forbidden')) {
				statusCode = 403
			} else if (
				errorMessage.includes('Invalid') ||
				errorMessage.includes('required') ||
				errorMessage.includes('validation') ||
				errorMessage.includes('bad request')
			) {
				statusCode = 400
			} else if ((error as any).status) {
				statusCode = (error as any).status
			}
		}

		// Handle Elysia error codes
		if (code === 'NOT_FOUND') {
			statusCode = 404
			errorMessage = 'Not found'
		} else if (code === 'VALIDATION') {
			statusCode = 400
			errorMessage = error instanceof Error ? error.message : 'Validation error'
		} else if (code === 'PARSE') {
			statusCode = 400
			errorMessage = 'Invalid request format'
		}

		set.status = statusCode
		set.headers['Content-Type'] = 'application/json'

		return {
			success: false,
			error: errorMessage,
			statusCode,
		}
	})
	// Private-site subdomains (<siteId>.priv.<host>) legitimately POST /private/redeem
	// to redeem audience-scoped shares. The middleware scopes this exception to that path.
	.onBeforeHandle(csrfProtection([`.${process.env.PRIVATE_HOST || `priv.${BASE_HOST}`}`]))
	.get('/', async ({ request, set }) => {
		// Build dynamic login URL for AT Protocol OAuth entryway
		const loginUrl = isLocalDev ? `${new URL(request.url).origin}/api/auth/login` : `${config.domain}/api/auth/login`
		const atprotoLoginUrl = `https://atproto.wisp.place/?next=${encodeURIComponent(loginUrl)}`

		set.headers['Content-Type'] = 'text/html; charset=utf-8'

		const html = await Bun.file('./apps/main-app/public/landingpage.html').text()
		return html.replaceAll('{{ATPROTO_LOGIN_URL}}', atprotoLoginUrl)
	})
	.get('/home', async ({ request, set }) => {
		// Same as / but without the auto-redirect script for signed-in users
		const loginUrl = isLocalDev ? `${new URL(request.url).origin}/api/auth/login` : `${config.domain}/api/auth/login`
		const atprotoLoginUrl = `https://atproto.wisp.place/?next=${encodeURIComponent(loginUrl)}`

		set.headers['Content-Type'] = 'text/html; charset=utf-8'

		const html = await Bun.file('./apps/main-app/public/landingpage.html').text()
		return html
			.replaceAll('{{ATPROTO_LOGIN_URL}}', atprotoLoginUrl)
			.replace(/<script>\s*\/\/ Check if user is already signed in[\s\S]*?<\/script>/, '')
	})
	.use(authRoutes(client, cookieSecret))
	.use(wispRoutes(client, cookieSecret))
	.use(domainRoutes(client, cookieSecret))
	.use(userRoutes(client, cookieSecret))
	.use(siteRoutes(client, cookieSecret))
	.use(privateRedeemRoutes(client, cookieSecret))
	.use(privateSiteApiRoutes(client, cookieSecret))
	.use(webhookRoutes(client, cookieSecret))
	.use(secretRoutes(client, cookieSecret))
	.use(adminRoutes(cookieSecret))
	.use(
		await staticPlugin({
			assets: './apps/main-app/public',
			prefix: '/',
			// Prevent dev-mode GET /* fallback from swallowing XRPC GET routes.
			alwaysStatic: true,
			staticLimit: 10000,
		}),
	)
	// Serve built assets from dist. The browser cannot execute the source TSX directly,
	// so the dev script builds the editor before starting the watcher as well.
	.use(
		await staticPlugin({
			assets: './apps/main-app/dist',
			prefix: '/dist',
		}),
	)
	.use(await staticPlugin({ assets: './apps/main-app/dist/editor', prefix: '/editor' }))
	// Serve built HTML for /editor in both dev and production.
	.use(
		new Elysia()
			.get('/editor', async ({ set }) => {
				set.headers['Content-Type'] = 'text/html; charset=utf-8'
				return await Bun.file('./apps/main-app/dist/editor/index.html').text()
			})
			.get('/editor/*', async ({ set }) => {
				set.headers['Content-Type'] = 'text/html; charset=utf-8'
				return await Bun.file('./apps/main-app/dist/editor/index.html').text()
			}),
	)
	// Keep XRPC after static in dev, since staticPlugin(prefix='/') installs GET /* fallback.
	.use(xrpcRoutes())
	// Production only: serve built admin assets
	.use(
		Bun.env.NODE_ENV === 'production'
			? await staticPlugin({
					assets: './apps/main-app/dist/admin',
					prefix: '/admin',
				})
			: (app) => app,
	)
	// Production only: serve built HTML for /admin
	.use(
		Bun.env.NODE_ENV === 'production'
			? new Elysia()
					.get('/admin', async ({ set }) => {
						set.headers['Content-Type'] = 'text/html; charset=utf-8'
						return await Bun.file('./apps/main-app/dist/admin/index.html').text()
					})
					.get('/admin/*', async ({ set }) => {
						set.headers['Content-Type'] = 'text/html; charset=utf-8'
						return await Bun.file('./apps/main-app/dist/admin/index.html').text()
					})
			: (app) => app,
	)
	.get('/acceptable-use', async ({ set }) => {
		set.headers['Content-Type'] = 'text/html; charset=utf-8'
		return await Bun.file('./apps/main-app/public/editor/acceptable-use.html').text()
	})
	.get('/editor/acceptable-use', async ({ set }) => {
		set.headers['Content-Type'] = 'text/html; charset=utf-8'
		return await Bun.file('./apps/main-app/public/editor/acceptable-use.html').text()
	})
	.get('/privacy', async ({ set }) => {
		set.headers['Content-Type'] = 'text/html; charset=utf-8'
		return await Bun.file('./apps/main-app/public/privacy.html').text()
	})
	.get('/onboarding', async ({ set }) => {
		set.headers['Content-Type'] = 'text/html; charset=utf-8'
		return await Bun.file('./apps/main-app/public/editor/onboarding.html').text()
	})
	.get('/editor/onboarding', async ({ set }) => {
		set.headers['Content-Type'] = 'text/html; charset=utf-8'
		return await Bun.file('./apps/main-app/public/editor/onboarding.html').text()
	})
	.get('/oauth-client-metadata.json', () => {
		logger.debug('[OAuth] Client metadata requested', {
			LOCAL_DEV: Bun.env.LOCAL_DEV,
			DOMAIN: Bun.env.DOMAIN,
			BASE_DOMAIN: Bun.env.BASE_DOMAIN,
			configDomain: config.domain,
		})
		const metadata = createClientMetadata(config)
		logger.debug('[OAuth] Returning metadata', {
			client_id: metadata.client_id,
			redirect_uris: metadata.redirect_uris,
		})
		return metadata
	})
	.get('/.well-known/oauth-protected-resource', ({ request }) => {
		const resource = new URL(request.url).origin

		return {
			resource,
			authorization_servers: [oauthAuthorizationServer],
			bearer_methods_supported: ['header'],
		}
	})
	.get('/.well-known/did.json', ({ request, set }) => {
		set.headers['Content-Type'] = 'application/did+json'

		const origin = new URL(request.url).origin
		const serviceEndpoint = Bun.env.SERVICE_ENDPOINT ?? origin.replace(/^http:/, 'https:')
		const contexts = ['https://www.w3.org/ns/did/v1']
		if (servicePublicKeyMultibase) {
			contexts.push('https://w3id.org/security/multikey/v1')
		}

		const services = didServiceIds.map((id) => ({
			id,
			type: 'AtprotoService',
			serviceEndpoint,
		}))

		const verificationMethod = servicePublicKeyMultibase
			? [
					{
						id: `${serviceDid}#atproto`,
						type: 'Multikey',
						controller: serviceDid,
						publicKeyMultibase: servicePublicKeyMultibase,
					},
				]
			: undefined

		return {
			'@context': contexts,
			id: serviceDid,
			verificationMethod,
			service: services,
		}
	})
	.get('/jwks.json', async ({ set }) => {
		// Prevent caching to ensure clients always get fresh keys after rotation
		set.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
		set.headers.Pragma = 'no-cache'
		set.headers.Expires = '0'

		const keys = await getCurrentKeys()
		if (!keys.length) return { keys: [] }

		return {
			keys: keys.map((k) => {
				const jwk = k.publicJwk ?? k
				const { ...pub } = jwk
				return pub
			}),
		}
	})
	.get('/api/health', async () => {
		const [databaseRead, dnsVerifierHealth] = await Promise.all([getDatabaseReadHealth(), dnsVerifier.getHealth()])
		const webhookSecretEncryption = getWebhookSecretEncryptionHealth()
		return {
			status: databaseRead.usingPrimaryFallback || webhookSecretEncryption.status === 'degraded' ? 'degraded' : 'ok',
			timestamp: new Date().toISOString(),
			database: {
				separateReadPoolConfigured: hasSeparateDatabaseReadPool,
				readEndpoint: databaseRead,
			},
			webhookSecretEncryption,
			publicUploads: {
				admission: getPublicUploadRequestGateStats(),
				lifecycle: getPublicUploadLifecycleStats(),
			},
			dnsVerifier: dnsVerifierHealth,
		}
	})
	.get('/api/screenshots', async () => {
		const fs = await import('node:fs/promises')

		const readScheme = async (scheme: 'light' | 'dark') => {
			try {
				const files = await fs.readdir(`./apps/main-app/public/screenshots/${scheme}`)
				return files.filter((file) => file.endsWith('.webp'))
			} catch {
				return []
			}
		}

		const [light, dark] = await Promise.all([readScheme('light'), readScheme('dark')])
		return { light, dark }
	})
	.get('/api/admin/test', () => {
		return { message: 'Admin routes test works!' }
	})
	.post('/api/admin/verify-dns', async () => {
		try {
			await dnsVerifier.trigger()
			return {
				success: true,
				message: 'DNS verification triggered',
			}
		} catch (error) {
			logger.error('[DNS Verifier] Manual verification trigger failed', error)
			return {
				success: false,
				error: 'Failed to trigger DNS verification',
			}
		}
	})
	.get('/.well-known/atproto-did', ({ set }) => {
		// Return plain text DID for AT Protocol domain verification
		set.headers['Content-Type'] = 'text/plain'
		return serviceDid
	})
	.use(
		cors({
			origin: isLocalDev
				? [
						config.domain,
						/^http:\/\/127\.0\.0\.1:\d+$/,
						/^http:\/\/localhost:\d+$/,
						/^https:\/\/127\.0\.0\.1:\d+$/,
						/^https:\/\/localhost:\d+$/,
					]
				: config.domain,
			credentials: true,
			methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
			allowedHeaders: [
				'Content-Type',
				'Authorization',
				'Origin',
				'X-Forwarded-Host',
				'DPoP',
				'dpop',
				'DPoP-Nonce',
				'dpop-nonce',
			],
			exposeHeaders: ['Content-Type', 'DPoP-Nonce', 'dpop-nonce'],
			maxAge: 86400, // 24 hours
		}),
	)
	.listen({
		port: serverPort,
		hostname: '0.0.0.0',
		// Bun rejects chunked/undeclared bodies above this hard ceiling before
		// Elysia invokes multipart parsing. Route admission is stricter per kind.
		maxRequestBodySize: MAX_PUBLIC_UPLOAD_REQUEST_SIZE,
	})

console.log(`🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`)

// Graceful shutdown
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000
let shutdownPromise: Promise<void> | undefined

const shutdown = (): void => {
	if (shutdownPromise) return

	shutdownPromise = (async () => {
		console.log('\n🛑 Shutting down...')

		// Stop periodic scheduling now. The returned promises wait for only the
		// already-active maintenance and reaper passes.
		const backgroundTasks = [
			{ name: 'connection warming', promise: connectionWarming.stop() },
			{ name: 'maintenance', promise: maintenance.stop() },
			{ name: 'private-site reaper', promise: privateSiteReaper.stop() },
			{ name: 'public uploads', promise: stopAndDrainPublicUploads(GRACEFUL_SHUTDOWN_TIMEOUT_MS) },
		]
		try {
			dnsVerifier.stop()
		} catch {
			logger.error('[DNS Verifier] Shutdown failed')
		}

		// app.stop() first stops new requests and waits for in-flight work. Force
		// active connections closed only if that grace period expires.
		try {
			const result = await stopServerWithGracePeriod(app, GRACEFUL_SHUTDOWN_TIMEOUT_MS)
			if (result === 'forced') logger.warn('[Server] Graceful shutdown timed out; active requests were closed')
		} catch {
			logger.error('[Server] Graceful shutdown failed; forcing active requests closed')
			try {
				await app.stop(true)
			} catch {
				logger.error('[Server] Forced shutdown failed')
			}
		}

		const backgroundResults = await Promise.allSettled(backgroundTasks.map(({ promise }) => promise))
		for (const [index, result] of backgroundResults.entries()) {
			if (result.status === 'rejected') {
				logger.error(`${backgroundTasks[index]?.name ?? 'background task'} shutdown failed`)
			}
		}

		const clientTasks = [
			{ name: 'Redis', promise: Promise.resolve().then(() => closeRedisClient()) },
			{
				name: 'pinned HTTP connection pool',
				promise: Promise.resolve().then(() => closePinnedKeepAliveAgents()),
			},
			{ name: 'OAuth lock database', promise: closeOAuthLockDatabase() },
			{ name: 'site upload lock database', promise: closeSiteUploadLockDatabase() },
			{ name: 'database', promise: closeDatabase() },
		]
		const clientResults = await Promise.allSettled(clientTasks.map(({ promise }) => promise))
		for (const [index, result] of clientResults.entries()) {
			if (result.status === 'rejected') {
				logger.error(`${clientTasks[index]?.name ?? 'client'} shutdown failed`)
			}
		}

		process.exit(0)
	})()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
