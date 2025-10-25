import { Elysia } from 'elysia'
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
import { csrfProtection } from './lib/csrf'
import { DNSVerificationWorker } from './lib/dns-verification-worker'
import { logger } from './lib/logger'

const config: Config = {
	domain: (Bun.env.DOMAIN ?? `https://${BASE_HOST}`) as `https://${string}`,
	clientName: Bun.env.CLIENT_NAME ?? 'PDS-View'
}

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

// Start DNS verification worker (runs every hour)
const dnsVerifier = new DNSVerificationWorker(
	60 * 60 * 1000, // 1 hour
	(msg, data) => {
		logger.info('[DNS Verifier]', msg, data || '')
	}
)

dnsVerifier.start()
logger.info('[DNS Verifier] Started - checking custom domains every hour')

export const app = new Elysia()
	// Security headers middleware
	.onAfterHandle(({ set }) => {
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
	.use(
		await staticPlugin({
			prefix: '/'
		})
	)
	.use(csrfProtection())
	.use(authRoutes(client))
	.use(wispRoutes(client))
	.use(domainRoutes(client))
	.use(userRoutes(client))
	.get('/client-metadata.json', (c) => {
		return createClientMetadata(config)
	})
	.get('/jwks.json', async (c) => {
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
