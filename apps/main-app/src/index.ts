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
	.get('/', ({ set }) => {
		// Build dynamic login URL for AT Protocol OAuth entryway
		// atproto.wisp.place will redirect to this endpoint with the saved handle
		const isLocalDev = Bun.env.LOCAL_DEV === 'true'
		const loginUrl = isLocalDev
			? 'http://127.0.0.1:8000/api/auth/login'
			: `${config.domain}/api/auth/login`
		const atprotoLoginUrl = `https://atproto.wisp.place/?next=${encodeURIComponent(loginUrl)}`

		set.headers['Content-Type'] = 'text/html; charset=utf-8'

		return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>wisp.place</title>
        <meta name="description" content="Host static websites directly in your AT Protocol account. Keep full ownership and control with fast CDN distribution. Built on Bluesky's decentralized network." />

        <!-- Open Graph / Facebook -->
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://wisp.place/" />
        <meta property="og:title" content="wisp.place - Decentralized Static Site Hosting" />
        <meta property="og:description" content="Host static websites directly in your AT Protocol account. Keep full ownership and control with fast CDN distribution." />
        <meta property="og:site_name" content="wisp.place" />

        <!-- Twitter -->
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:url" content="https://wisp.place/" />
        <meta name="twitter:title" content="wisp.place - Decentralized Static Site Hosting" />
        <meta name="twitter:description" content="Host static websites directly in your AT Protocol account. Keep full ownership and control with fast CDN distribution." />

        <!-- Theme -->
        <meta name="theme-color" content="#7c3aed" />

        <link rel="icon" type="image/x-icon" href="./favicon.ico">
        <link rel="icon" type="image/png" sizes="32x32" href="./favicon-32x32.png">
        <link rel="icon" type="image/png" sizes="16x16" href="./favicon-16x16.png">
        <link rel="apple-touch-icon" sizes="180x180" href="./apple-touch-icon.png">
        <link rel="manifest" href="./site.webmanifest">

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
            href="https://fonts.googleapis.com/css2?family=Fira+Mono:wght@400;500;700&display=swap"
            rel="stylesheet"
        />
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            :root {
                --bg: #ffffff;
                --text: #1a1a1a;
                --text-muted: #666;
                --link: #0066cc;
                --link-hover: #0052a3;
                --terminal-bg: #1a1a1a;
                --terminal-text: #e0e0e0;
                --terminal-cyan: #5fdfdf;
            }

            @media (prefers-color-scheme: dark) {
                :root {
                    --bg: #121212;
                    --text: #e0e0e0;
                    --text-muted: #888;
                    --link: #5fdfdf;
                    --link-hover: #7fffff;
                    --terminal-bg: #0a0a0a;
                    --terminal-text: #e0e0e0;
                }
            }

            body {
                font-family: "Fira Mono", monospace;
                font-weight: 400;
                font-style: normal;
                font-size: 18px;
                line-height: 1.6;
                padding: 60px 40px;
                max-width: 80%;
                color: var(--text);
                background: var(--bg);
                transition:
                    background 0.2s,
                    color 0.2s;
            }

            h1 {
                font-size: 1.1em;
                font-weight: normal;
                margin-bottom: 2em;
            }

            .cursor {
                display: inline-block;
                width: 2px;
                height: 1.1em;
                background: var(--text);
                margin-left: 2px;
                vertical-align: text-bottom;
                animation: blink 1s step-end infinite;
            }

            @keyframes blink {
                0%,
                100% {
                    opacity: 1;
                }
                50% {
                    opacity: 0;
                }
            }

            p {
                margin-bottom: 0.3em;
            }

            section {
                margin-bottom: 2.5em;
            }

            a {
                color: var(--link);
                text-decoration: underline;
                text-underline-offset: 2px;
            }

            a:hover {
                color: var(--link-hover);
            }

            .click-hint {
                color: var(--link);
                margin-left: 0.5em;
                display: inline-flex;
                align-items: center;
            }

            .click-hint .arrow {
                display: inline-block;
                width: 1.2em;
                text-align: center;
                animation: nudge 1.2s ease-in-out infinite;
            }

            @keyframes nudge {
                0%,
                100% {
                    transform: translateX(0);
                }
                50% {
                    transform: translateX(-4px);
                }
            }

            .terminal-section {
                margin-top: 2em;
            }

            .terminal-label {
                margin-bottom: 0.8em;
            }

            .cmd {
                font-family:
                    ui-monospace, "SF Mono", "Cascadia Code", "Source Code Pro",
                    Menlo, Consolas, monospace;
                font-size: 0.85em;
                background: var(--terminal-bg);
                color: var(--terminal-text);
                border-radius: 4px;
                padding: 12px 16px;
                display: table;
                white-space: nowrap;
                margin-bottom: 0.5em;
            }

            .cmd .highlight {
                color: var(--terminal-cyan);
            }

            .hosting-options {
                margin-top: 2.5em;
            }

            .hosting-options p {
                margin-bottom: 0.2em;
            }
        </style>
    </head>
    <body>
        <h1>wisp.place<span class="cursor"></span></h1>

        <section>
            <p>the easiest way to get static html going</p>
            <p>
                just drag n' drop into the dashboard with your
                <a href="${atprotoLoginUrl}">AT Protocol account</a>.
                <span class="click-hint"
                    ><span class="arrow">←</span> click me!</span
                >
            </p>
        </section>

        <section class="terminal-section">
            <p class="terminal-label">are you a terminal nerd?</p>
            <code class="cmd"
                >curl
                <span class="highlight"
                    >https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux</span
                >
                -o wisp-cli</code
            >
            <code class="cmd"
                >wisp-cli
                <span class="highlight">alice.bsky.social</span> --site
                MyBlog</code
            >
        </section>

        <div class="hosting-options">
            <p>host on our infrastructure for free</p>
            <p>
                or use wisp-cli to host on your own infra with seamless
                deployments
            </p>
            <p>need docs? <a href="https://docs.wisp.place">docs.wisp.place</a></p>
        </div>
    </body>
</html>`
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
	.get('/client-metadata.json', () => {
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
