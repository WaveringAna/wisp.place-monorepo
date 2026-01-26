// Fix for Elysia issue with Bun, (see https://github.com/oven-sh/bun/issues/12161)
process.getBuiltinModule = require;

import { Elysia } from 'elysia'
import type { Context } from 'elysia'
import { cors } from '@elysiajs/cors'
import { staticPlugin } from '@elysiajs/static'

import type { Config } from './lib/types'
import { BASE_HOST } from '@wisp/constants'
import {
	createClientMetadata,
	getOAuthClient,
	getCurrentKeys,
	cleanupExpiredSessions,
	rotateKeysIfNeeded
} from './lib/oauth-client'
import { getCookieSecret, closeDatabase } from './lib/db'
import { authRoutes } from './routes/auth'
import { wispRoutes } from './routes/wisp'
import { domainRoutes } from './routes/domain'
import { userRoutes } from './routes/user'
import { siteRoutes } from './routes/site'
import { csrfProtection } from './lib/csrf'
import { DNSVerificationWorker } from './lib/dns-verification-worker'
import { createLogger, logCollector, initializeGrafanaExporters } from '@wisp/observability'
import { observabilityMiddleware } from '@wisp/observability/middleware/elysia'
import { promptAdminSetup } from './lib/admin-auth'
import { adminRoutes } from './routes/admin'

// Initialize Grafana exporters if configured
initializeGrafanaExporters({
	serviceName: 'main-app',
	serviceVersion: '1.0.50'
})

const logger = createLogger('main-app')

const config: Config = {
	domain: (Bun.env.DOMAIN ?? `https://${BASE_HOST}`) as Config['domain'],
	clientName: Bun.env.CLIENT_NAME ?? 'PDS-View'
}

// Initialize admin setup (prompt if no admin exists)
await promptAdminSetup()

// Get or generate cookie signing secret
const cookieSecret = await getCookieSecret()

const client = await getOAuthClient(config)

// Periodic maintenance: cleanup expired sessions and rotate keys
// Run every hour
const runMaintenance = async () => {
	console.log('[Maintenance] Running periodic maintenance...')
	await cleanupExpiredSessions()
	await rotateKeysIfNeeded()
}

// Run maintenance on startup
runMaintenance()

// Schedule maintenance to run every hour
setInterval(runMaintenance, 60 * 60 * 1000)

// Start DNS verification worker (runs every 10 minutes)
// Can be disabled via DISABLE_DNS_WORKER=true environment variable
const dnsVerifier = new DNSVerificationWorker(
	10 * 60 * 1000, // 10 minutes
	(msg, data) => {
		logCollector.info(`[DNS Verifier] ${msg}`, 'main-app', data ? { data } : undefined)
	}
)

if (Bun.env.DISABLE_DNS_WORKER !== 'true') {
	dnsVerifier.start()
	logger.info('DNS Verifier Started - checking custom domains every 10 minutes')
} else {
	logger.info('DNS Verifier disabled via DISABLE_DNS_WORKER environment variable')
}

export const app = new Elysia({
		serve: {
			maxRequestBodySize: 1024 * 1024 * 128 * 3,
			development: Bun.env.NODE_ENV !== 'production' ? true : false,
			id: Bun.env.NODE_ENV !== 'production' ? undefined : null,
		},
		cookie: {
			secrets: cookieSecret,
			sign: ['did']
		}
	})
	// Observability middleware
	.onBeforeHandle(observabilityMiddleware('main-app').beforeHandle)
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
	.onError(observabilityMiddleware('main-app').onError)
	.use(csrfProtection())
	.get('/', async ({ set }) => {
		// Build dynamic login URL for AT Protocol OAuth entryway
		const isLocalDev = Bun.env.LOCAL_DEV === 'true'
		const loginUrl = isLocalDev
			? 'http://127.0.0.1:8000/api/auth/login'
			: `${config.domain}/api/auth/login`
		const atprotoLoginUrl = `https://atproto.wisp.place/?next=${encodeURIComponent(loginUrl)}`

		set.headers['Content-Type'] = 'text/html; charset=utf-8'

		const html = await Bun.file('./apps/main-app/public/landingpage.html').text()
		return html.replaceAll('{{ATPROTO_LOGIN_URL}}', atprotoLoginUrl)
	})
	.use(authRoutes(client, cookieSecret))
	.use(wispRoutes(client, cookieSecret))
	.use(domainRoutes(client, cookieSecret))
	.use(userRoutes(client, cookieSecret))
	.use(siteRoutes(client, cookieSecret))
	.use(adminRoutes(cookieSecret))
	.use(
		await staticPlugin({
			assets: './apps/main-app/public',
			prefix: '/'
		})
	)
	.get('/oauth-client-metadata.json', () => {
		return createClientMetadata(config)
	})
	.get('/jwks.json', async ({ set }) => {
		// Prevent caching to ensure clients always get fresh keys after rotation
		set.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
		set.headers['Pragma'] = 'no-cache'
		set.headers['Expires'] = '0'

		const keys = await getCurrentKeys()
		if (!keys.length) return { keys: [] }

		return {
			keys: keys.map((k) => {
				const jwk = k.publicJwk ?? k
				const { ...pub } = jwk
				return pub
			})
		}
	})
	.get('/api/health', () => {
		const dnsVerifierHealth = dnsVerifier.getHealth()
		return {
			status: 'ok',
			timestamp: new Date().toISOString(),
			dnsVerifier: dnsVerifierHealth
		}
	})
	.get('/api/screenshots', async () => {
		const fs = await import('fs/promises')

		try {
			const screenshotsDir = './apps/main-app/public/screenshots'
			const files = await fs.readdir(screenshotsDir)
			const screenshots = files.filter(file => file.endsWith('.png'))
			return { screenshots }
		} catch (error) {
			return { screenshots: [] }
		}
	})
	.get('/api/admin/test', () => {
		return { message: 'Admin routes test works!' }
	})
	.post('/api/admin/verify-dns', async () => {
		try {
			await dnsVerifier.trigger()
			return {
				success: true,
				message: 'DNS verification triggered'
			}
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error)
			}
		}
	})
	.get('/.well-known/atproto-did', ({ set }) => {
		// Return plain text DID for AT Protocol domain verification
		set.headers['Content-Type'] = 'text/plain'
		return 'did:plc:7puq73yz2hkvbcpdhnsze2qw'
	})
	.use(cors({
		origin: config.domain,
		credentials: true,
		methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'X-Forwarded-Host'],
		exposeHeaders: ['Content-Type'],
		maxAge: 86400 // 24 hours
	}))
	.listen({
		port: 8000,
		hostname: '0.0.0.0'
	})

console.log(
	`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
)

// Graceful shutdown
process.on('SIGINT', async () => {
	console.log('\n🛑 Shutting down...')
	dnsVerifier.stop()
	await closeDatabase()
	process.exit(0)
})

process.on('SIGTERM', async () => {
	console.log('\n🛑 Shutting down...')
	dnsVerifier.stop()
	await closeDatabase()
	process.exit(0)
})
