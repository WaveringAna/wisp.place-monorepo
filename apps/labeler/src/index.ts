import { createLogger } from '@wispplace/observability'
import postgres from 'postgres'
import { resolveLabelerConfig } from './config'
import { loadSigningKey } from './labels'
import { startModeration } from './moderation/service'
import { createLabeler } from './server'
import { createPostgresLabelStore, migrateLabelStore } from './store'

const logger = createLogger('labeler')
const config = resolveLabelerConfig(process.env)
const sql = postgres(config.databaseUrl, { max: 8, idle_timeout: 30, onnotice: () => {} })
await migrateLabelStore(sql)

const keypair = await loadSigningKey(config.signingKeyHex)
const labeler = createLabeler({
	did: config.did,
	keypair,
	store: createPostgresLabelStore(sql, config.did),
	values: config.values,
	adminToken: config.adminToken,
})

const moderation = config.moderation
	? await startModeration({ sql, config: config.moderation, labelerDid: config.did, emitLabel: labeler.emit })
	: null

const server = Bun.serve({
	hostname: config.host,
	port: config.port,
	...(moderation ? { routes: moderation.routes } : {}),
	fetch: labeler.fetch,
	websocket: labeler.websocket,
	development: false,
	error(error) {
		logger.error('Request failed', error)
		return Response.json({ error: 'InternalServerError', message: 'Internal server error' }, { status: 500 })
	},
})

logger.info(`Labeler ${config.did} listening on ${server.hostname}:${server.port}`, {
	values: config.values,
	moderation: config.moderation ? config.moderation.publicUrl : 'off',
})

async function shutdown() {
	moderation?.stop()
	await server.stop()
	await sql.end({ timeout: 5 })
	process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
