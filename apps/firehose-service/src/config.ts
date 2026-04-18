/**
 * Environment configuration for firehose-service
 */

export const config = {
	// Database
	databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp',

	// Firehose
	firehoseService: process.env.FIREHOSE_SERVICE || 'wss://bsky.network',
	firehoseServiceSecondary: process.env.FIREHOSE_SERVICE_SECONDARY || undefined,
	firehoseMaxConcurrency: parseInt(process.env.FIREHOSE_MAX_CONCURRENCY || '5', 10),

	// S3 storage (write destination)
	s3Bucket: process.env.S3_BUCKET || '',
	s3Region: process.env.S3_REGION || 'us-east-1',
	s3Endpoint: process.env.S3_ENDPOINT,
	s3ForcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
	s3Prefix: process.env.S3_PREFIX || 'sites/',
	awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
	awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,

	// Health check server
	healthPort: parseInt(process.env.HEALTH_PORT || '3001', 10),

	// Redis revalidation queue
	redisUrl: process.env.REDIS_URL,
	revalidateStream: process.env.WISP_REVALIDATE_STREAM || 'wisp:revalidate',
	revalidateGroup: process.env.WISP_REVALIDATE_GROUP || 'firehose-service',

	// Leader election (for distributed HA deployments)
	leaderElection: process.env.LEADER_ELECTION === 'true',
	leaderTtlMs: parseInt(process.env.LEADER_TTL_MS || '30000', 10),
	leaderRenewIntervalMs: parseInt(process.env.LEADER_RENEW_INTERVAL_MS || '10000', 10),
	leaderPollIntervalMs: parseInt(process.env.LEADER_POLL_INTERVAL_MS || '5000', 10),
	cursorSaveIntervalMs: parseInt(process.env.CURSOR_SAVE_INTERVAL_MS || '5000', 10),

	// Mode
	isDbFillOnly: process.argv.includes('--db-fill-only') || process.env.DB_FILL_ONLY === 'true',
	isBackfill:
		process.argv.includes('--backfill') ||
		process.argv.includes('--db-fill-only') ||
		process.env.BACKFILL === 'true' ||
		process.env.DB_FILL_ONLY === 'true',
	backfillConcurrency: parseInt(process.env.BACKFILL_CONCURRENCY || '5', 10),
} as const
