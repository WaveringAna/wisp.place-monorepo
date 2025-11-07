import { Elysia } from 'elysia'
import type { Context } from 'elysia'
import { cors } from '@elysiajs/cors'
import { staticPlugin } from '@elysiajs/static'

import type { Config } from './lib/types'
import { BASE_HOST } from './lib/constants'
import {
	createClientMetadata,
	getOAuthClient,
	getCurrentKeys,
	cleanupExpiredSessions,
	rotateKeysIfNeeded
} from './lib/oauth-client'
import { authRoutes } from './routes/auth'
import { wispRoutes } from './routes/wisp'
import { domainRoutes } from './routes/domain'
import { userRoutes } from './routes/user'
import { siteRoutes } from './routes/site'
import { csrfProtection } from './lib/csrf'
import { DNSVerificationWorker } from './lib/dns-verification-worker'
import { logger, logCollector, observabilityMiddleware } from './lib/observability'
import { promptAdminSetup } from './lib/admin-auth'
import { adminRoutes } from './routes/admin'

const config: Config = {
	domain: (Bun.env.DOMAIN ?? `https://${BASE_HOST}`) as Config['domain'],
	clientName: Bun.env.CLIENT_NAME ?? 'PDS-View'
}

// Initialize admin setup (prompt if no admin exists)
await promptAdminSetup()

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
const dnsVerifier = new DNSVerificationWorker(
	10 * 60 * 1000, // 10 minutes
	(msg, data) => {
		logCollector.info(`[DNS Verifier] ${msg}`, 'main-app', data ? { data } : undefined)
	}
)

dnsVerifier.start()
logger.info('DNS Verifier Started - checking custom domains every 10 minutes')

export const app = new Elysia({
		serve: {
			maxPayloadLength: 1024 * 1024 * 128 * 3,
			development: Bun.env.NODE_ENV !== 'production' ? true : false,
			id: Bun.env.NODE_ENV !== 'production' ? undefined : null,
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
	.use(authRoutes(client))
	.use(wispRoutes(client))
	.use(domainRoutes(client))
	.use(userRoutes(client))
	.use(siteRoutes(client))
	.use(adminRoutes())
	.use(
		await staticPlugin({
			prefix: '/'
		})
	)
	.get('/client-metadata.json', () => {
		return createClientMetadata(config)
	})
	.get('/jwks.json', async () => {
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
	.use(cors({
		origin: config.domain,
		credentials: true,
		methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'X-Forwarded-Host'],
		exposeHeaders: ['Content-Type'],
		maxAge: 86400 // 24 hours
	}))
	.listen(8000)

console.log(
	`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
)
