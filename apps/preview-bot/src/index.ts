import { AtpAgent } from '@atproto/api'
import { getPdsForDid } from '@wispplace/atproto-utils'
import { createLogger } from '@wispplace/observability'
import { safeFetch } from '@wispplace/safe-fetch'
import postgres from 'postgres'
import { resolveConfig } from './config'
import { createHandler } from './handler'
import { createHttpPorts } from './ports-http'
import { createRateLimiter } from './rate-limit'

const logger = createLogger('preview-bot')
const config = resolveConfig(process.env)

logger.info('Resolving bot identity and PDS', { handle: config.botHandle })

const allowLocalhost = process.env.NODE_ENV === 'development' && process.env.WISP_ALLOW_LOCALHOST_FETCH === '1'
const fetchForIdentity = (url: string, options?: { signal?: AbortSignal; byteBudget?: unknown }) =>
	safeFetch(url, { signal: options?.signal, allowLocalhost })

// Resolve handle -> DID via the PDS handle resolver or default PLC.
const tempAgent = new AtpAgent({
	service: process.env.WISP_HANDLE_RESOLVER_URL ? 'http://localhost:3300' : 'https://bsky.social',
})
let did: string
let pdsEndpoint: string

try {
	const resolveRes = await tempAgent.resolveHandle({ handle: config.botHandle })
	did = resolveRes.data.did
	const resolvedPds = await getPdsForDid(did, fetchForIdentity, allowLocalhost ? { allowLoopback: true } : undefined)
	if (!resolvedPds) throw new Error(`Could not resolve PDS endpoint for DID ${did}`)
	pdsEndpoint = resolvedPds
} catch (error) {
	logger.error('Failed to resolve bot identity', error instanceof Error ? error : new Error(String(error)))
	process.exit(1)
}

logger.info('Authenticating bot session with PDS', { did, pds: pdsEndpoint })
const agent = new AtpAgent({ service: pdsEndpoint })
try {
	await agent.login({ identifier: did, password: config.botPassword })
} catch (error) {
	logger.error('Failed to authenticate bot', error instanceof Error ? error : new Error(String(error)))
	process.exit(1)
}

const sql = postgres(config.databaseUrl, { max: 5, idle_timeout: 20 })

const ports = createHttpPorts({
	sql,
	baseHost: config.baseHost,
	appviewHost: config.appviewHost,
	bot: { agent, did },
})

const handler = createHandler({
	ports,
	config: { previewHost: config.previewHost },
	clientKey: (req) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'direct',
	perClient: createRateLimiter({ capacity: 60, refillPerSecond: 1, maxKeys: 10_000 }),
	perOwner: createRateLimiter({ capacity: 20, refillPerSecond: 0.2, maxKeys: 10_000 }),
	log: (event, fields) => logger.info(`[preview-bot] ${event}`, fields),
})

const server = Bun.serve({
	port: config.port,
	fetch: handler,
})

logger.info(`preview-bot listening on :${server.port}`, { previewHost: config.previewHost, baseHost: config.baseHost })

const shutdown = async () => {
	logger.info('Shutting down preview-bot...')
	server.stop()
	await sql.end()
	process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
