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

		return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
    <meta name="theme-color" content="#000000" />

    <link rel="icon" type="image/x-icon" href="./favicon.ico">
    <link rel="icon" type="image/png" sizes="32x32" href="./favicon-32x32.png">
    <link rel="icon" type="image/png" sizes="16x16" href="./favicon-16x16.png">
    <link rel="apple-touch-icon" sizes="180x180" href="./apple-touch-icon.png">
    <link rel="manifest" href="./site.webmanifest">

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fira+Mono:wght@400;500;700&display=swap" rel="stylesheet">

    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --bg: #fafafa;
            --text: #000;
            --text-muted: #666;
            --text-subtle: #999;
            --border: #ddd;
            --cta-bg: #000;
            --cta-text: #fff;
            --cta-hover-bg: #fff;
            --cta-hover-text: #000;
            --code-bg: #000;
            --code-text: #0f0;
            --link: #000;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #0a0a0a;
                --text: #fafafa;
                --text-muted: #999;
                --text-subtle: #666;
                --border: #333;
                --cta-bg: #fff;
                --cta-text: #000;
                --cta-hover-bg: #0a0a0a;
                --cta-hover-text: #fff;
                --code-bg: #111;
                --code-text: #0f0;
                --link: #fff;
            }
        }

        body {
            font-family: "Fira Mono", monospace;
            font-weight: 400;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            padding-top: 6rem;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 0 2rem;
            width: 100%;
        }

        main {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .hero {
            text-align: center;
            padding: 4rem 0;
        }

        h1 {
            font-size: 5rem;
            font-weight: 700;
            margin-bottom: 4rem;
            letter-spacing: -0.02em;
            color: #4a4a4a;
            text-shadow:
                1px 1px 0 #fff,
                -1px -1px 0 #2a2a2a,
                2px 2px 3px rgba(0, 0, 0, 0.3);
        }

        @media (prefers-color-scheme: dark) {
            h1 {
                color: #888;
                text-shadow:
                    1px 1px 0 #222,
                    -1px -1px 0 #000,
                    2px 2px 3px rgba(0, 0, 0, 0.5);
            }
        }

        h1::after {
            content: '_';
            animation: blink 1s infinite;
        }

        @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
        }

        .cta {
            display: inline-block;
            background: var(--cta-bg);
            color: var(--cta-text);
            padding: 2rem 4rem;
            font-size: 1.5rem;
            text-decoration: none;
            border: 3px solid var(--cta-bg);
            transition: all 0.1s;
            font-weight: 700;
            margin-bottom: 3rem;
        }

        .cta:hover {
            background: var(--cta-hover-bg);
            color: var(--cta-hover-text);
            border-color: var(--cta-bg);
        }

        .tagline {
            font-size: 1.2rem;
            color: var(--text-muted);
            margin-bottom: 6rem;
        }

        .secondary {
            border-top: 1px solid var(--border);
            padding-top: 3rem;
            margin-top: 4rem;
        }

        .secondary h2 {
            font-size: 1rem;
            margin-bottom: 1.5rem;
            font-weight: 700;
            text-transform: lowercase;
        }

        .code-block {
            background: var(--code-bg);
            color: var(--code-text);
            padding: 1.5rem;
            margin: 1rem 0;
            font-size: 0.9rem;
            overflow-x: auto;
        }

        .code-block code {
            font-family: "Fira Mono", monospace;
        }

        .secondary p {
            color: var(--text-muted);
            margin-bottom: 1rem;
            font-size: 0.95rem;
        }

        .secondary a {
            color: var(--link);
            text-decoration: none;
            border-bottom: 1px solid var(--link);
        }

        .secondary a:hover {
            border-bottom: 2px solid var(--link);
        }

        footer {
            border-top: 1px solid var(--border);
            padding: 3rem 0;
            text-align: center;
            margin-top: 6rem;
        }

        .quote {
            font-size: 0.85rem;
            color: var(--text-subtle);
            font-style: italic;
        }

        .links {
            margin-top: 2rem;
            font-size: 0.85rem;
        }

        .links a {
            color: var(--text-muted);
            text-decoration: none;
            margin: 0 1rem;
        }

        .links a:hover {
            color: var(--text);
        }

        @media (max-width: 768px) {
            h1 {
                font-size: 3rem;
            }

            .cta {
                padding: 1.5rem 3rem;
                font-size: 1.2rem;
            }

            .tagline {
                font-size: 1rem;
            }
        }
    </style>
</head>
<body>
    <main>
        <div class="container">
            <div class="hero">
                <h1>wisp.place</h1>

                <a href="${atprotoLoginUrl}" class="cta">SIGN IN WITH AT PROTOCOL</a>

                <p class="tagline">Drop files. They're live.</p>

                <div class="secondary">
                    <h2>are you a terminal nerd?</h2>
                    <div class="code-block">
                        <code>curl https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli</code>
                    </div>
                    <div class="code-block">
                        <code>wisp-cli alice.bsky.social --site MyBlog</code>
                    </div>
                    <p>host on our infrastructure for free<br>
                    or use wisp-cli to host on your own infra with seamless deployments</p>
                    <p>need docs? <a href="https://docs.wisp.place">docs.wisp.place</a></p>
                </div>
            </div>
        </div>
    </main>

    <footer>
        <div class="container">
            <p class="quote">"The easiest way to get static HTML going."</p>
            <div class="links">
                <a href="https://docs.wisp.place">docs</a>
            </div>
        </div>
    </footer>
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
