import { existsSync, mkdirSync } from 'node:fs'
import { createLogger, initializeGrafanaExporters, shutdownGrafanaExporters } from '@wispplace/observability'
import { startCacheInvalidationSubscriber, stopCacheInvalidationSubscriber } from './lib/cache-invalidation'
import { cache } from './lib/cache-manager'
import { closeDatabase } from './lib/db'
import { closePrivateSitesDatabase } from './lib/private-sites-db'
import { closeRevalidateQueue } from './lib/revalidate-queue'
import { siteAnalytics } from './lib/site-analytics'
import { getStorageConfig, storage } from './lib/storage'
import app from './server'
import { onceAsync, stopHttpServerWithGrace } from './shutdown'

const logger = createLogger('hosting-service')

// Initialize Grafana exporters if configured
initializeGrafanaExporters({
	serviceName: 'hosting-service',
	serviceVersion: '1.0.0',
})

const DEFAULT_PORT = 3001
const DEFAULT_BOOTSTRAP_HOT_LIMIT = 100
const MAX_BOOTSTRAP_HOT_LIMIT = 10_000
const HTTP_SHUTDOWN_GRACE_PERIOD_MS = 10_000

function parseBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
	const normalized = value?.trim()
	if (!normalized) return fallback
	const parsed = Number(normalized)
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

const PORT = parseBoundedInteger(process.env.PORT, DEFAULT_PORT, 0, 65_535)
const CACHE_DIR = process.env.CACHE_DIR || './cache/sites'

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
	mkdirSync(CACHE_DIR, { recursive: true })
	logger.info('Created cache directory')
}

// Start in-memory cache cleanup
cache.startCleanup()
siteAnalytics.start()

// Start cache invalidation subscriber (listens for firehose-service updates via Redis pub/sub)
startCacheInvalidationSubscriber()

// Optional: Bootstrap hot cache from warm tier on startup
const BOOTSTRAP_HOT_ON_STARTUP = process.env.BOOTSTRAP_HOT_ON_STARTUP === 'true'
const BOOTSTRAP_HOT_LIMIT = parseBoundedInteger(
	process.env.BOOTSTRAP_HOT_LIMIT,
	DEFAULT_BOOTSTRAP_HOT_LIMIT,
	1,
	MAX_BOOTSTRAP_HOT_LIMIT,
)

if (BOOTSTRAP_HOT_ON_STARTUP) {
	logger.info(`Bootstrapping hot cache (top ${BOOTSTRAP_HOT_LIMIT} items)...`)
	storage
		.bootstrapHot(BOOTSTRAP_HOT_LIMIT)
		.then((loaded: number) => {
			logger.info(`Bootstrapped ${loaded} items into hot cache`)
		})
		.catch(() => {
			logger.error('Hot cache bootstrap failed')
		})
}

// Start HTTP server with Bun's native server
const server = Bun.serve({
	fetch: app.fetch,
	port: PORT,
})

// Log only safe storage mode and capacity fields. Bucket names, endpoints, and
// prefixes can reveal deployment topology and are intentionally not emitted.
const storageConfig = getStorageConfig()
logger.info('Hosting storage configured', {
	coldStorageMode: storageConfig.coldStorageMode,
	diskSourceAllowed: storageConfig.diskSourceAllowed,
	hotCacheCount: storageConfig.hotCacheCount,
	hotCacheSize: storageConfig.hotCacheSize,
	s3EndpointConfigured: storageConfig.s3EndpointConfigured,
	warmCacheSize: storageConfig.warmCacheSize,
	warmEvictionPolicy: storageConfig.warmEvictionPolicy,
})

// Graceful shutdown. The shared promise makes SIGINT/SIGTERM races idempotent.
const shutdown = onceAsync(async (signal: 'SIGINT' | 'SIGTERM') => {
	logger.info('Shutting down...', { signal })

	// Stop the listener first. Keep backing services available until active work
	// drains, then terminate any request that exceeded the bounded grace period.
	const httpStop = await stopHttpServerWithGrace(server, HTTP_SHUTDOWN_GRACE_PERIOD_MS)
	if (httpStop.forced) logger.warn('HTTP server did not stop gracefully; forced active connections closed')
	if (httpStop.gracefulStopFailed) logger.error('HTTP server graceful stop failed')
	if (httpStop.forceStopFailed) logger.error('HTTP server force stop failed')

	cache.stopCleanup()
	const tasks = [
		{ name: 'cache invalidation subscriber', promise: stopCacheInvalidationSubscriber() },
		{ name: 'revalidation queue', promise: closeRevalidateQueue() },
		{ name: 'analytics', promise: siteAnalytics.stop() },
	]
	const results = await Promise.allSettled(tasks.map(({ promise }) => promise))

	for (const [index, result] of results.entries()) {
		if (result.status === 'rejected') {
			// Shutdown errors can include connection strings, so log only the component name.
			logger.error(`${tasks[index]?.name ?? 'component'} shutdown failed`)
		}
	}

	// Analytics must finish its final shared-database flush before either pool closes.
	const [privateSitesDatabaseResult, databaseResult] = await Promise.allSettled([
		closePrivateSitesDatabase(),
		closeDatabase(),
	])
	if (privateSitesDatabaseResult?.status === 'rejected') logger.error('private sites database shutdown failed')
	if (databaseResult?.status === 'rejected') logger.error('database shutdown failed')

	const [observabilityResult] = await Promise.allSettled([shutdownGrafanaExporters()])
	if (observabilityResult?.status === 'rejected') logger.error('observability exporter shutdown failed')

	process.exit(0)
})

process.once('SIGINT', () => {
	void shutdown('SIGINT')
})
process.once('SIGTERM', () => {
	void shutdown('SIGTERM')
})
