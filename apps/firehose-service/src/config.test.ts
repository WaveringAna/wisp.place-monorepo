import { describe, expect, test } from 'bun:test'
import { resolveConfig } from './config'

function developmentEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		DATABASE_URL: 'postgres://user:password@localhost:5432/wisp',
		NODE_ENV: 'test',
		FIREHOSE_ALLOW_DISK_STORAGE: 'true',
		...overrides,
	}
}

function productionEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		DATABASE_URL: 'postgres://user:password@db.example.invalid:5432/wisp',
		NODE_ENV: 'production',
		S3_BUCKET: 'wisp-sites',
		REDIS_URL: 'rediss://redis.example.invalid:6379/0',
		...overrides,
	}
}

describe('resolveConfig', () => {
	test('uses strict safe integer defaults and keeps leader renewal below TTL', () => {
		const config = resolveConfig(
			developmentEnv({
				HEALTH_PORT: '3001junk',
				FIREHOSE_MAX_CONCURRENCY: '999999',
				FIREHOSE_MAX_PENDING_EVENTS: 'not-a-number',
				FIREHOSE_DRAIN_GRACE_MS: '300001',
				WISP_REVALIDATE_DEDUPE_TTL_SECONDS: '-1',
				WISP_CACHE_INVALIDATION_STREAM_MAXLEN: '1e9',
				LEADER_TTL_MS: '1000',
				LEADER_RENEW_INTERVAL_MS: '1000',
				LEADER_POLL_INTERVAL_MS: '0',
				CURSOR_SAVE_INTERVAL_MS: 'NaN',
				BACKFILL_CONCURRENCY: '21',
			}),
		)

		expect(config.healthPort).toBe(3001)
		expect(config.firehoseMaxConcurrency).toBe(5)
		expect(config.firehoseMaxPendingEvents).toBe(10_000)
		expect(config.firehoseDrainGraceMs).toBe(30_000)
		expect(config.revalidateDedupeTtlSeconds).toBe(60)
		expect(config.cacheInvalidationStreamMaxLen).toBe(10_000)
		expect(config.leaderTtlMs).toBe(1_000)
		expect(config.leaderRenewIntervalMs).toBeLessThanOrEqual(Math.floor(config.leaderTtlMs / 4))
		expect(config.leaderPollIntervalMs).toBe(5_000)
		expect(config.cursorSaveIntervalMs).toBe(5_000)
		expect(config.backfillConcurrency).toBe(5)
	})

	test('fails closed for a missing production database URL without exposing a value', () => {
		let thrown: unknown
		try {
			resolveConfig({ NODE_ENV: 'production' })
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(Error)
		expect((thrown as Error).message).toBe('DATABASE_URL is required in production')
		expect((thrown as Error).message).not.toContain('postgres://')
	})

	test('requires durable shared storage and Redis in production', () => {
		const config = resolveConfig(productionEnv())
		expect(config.leaderElection).toBe(true)
		expect(config.s3Bucket).toBe('wisp-sites')
		expect(config.allowDiskStorage).toBe(false)

		expect(() => resolveConfig(productionEnv({ S3_BUCKET: undefined }))).toThrow('S3_BUCKET is required')
		expect(() => resolveConfig(productionEnv({ REDIS_URL: undefined }))).toThrow('REDIS_URL is required')
		expect(() => resolveConfig(productionEnv({ LEADER_ELECTION: 'false' }))).toThrow(
			'LEADER_ELECTION must be enabled in production',
		)
		expect(() => resolveConfig(productionEnv({ FIREHOSE_ALLOW_DISK_STORAGE: 'true' }))).toThrow(
			'FIREHOSE_ALLOW_DISK_STORAGE is only allowed in development or test',
		)
	})

	test('permits disk storage only with an explicit development or test flag', () => {
		expect(resolveConfig(developmentEnv()).allowDiskStorage).toBe(true)
		expect(() =>
			resolveConfig({
				DATABASE_URL: 'postgres://user:password@localhost:5432/wisp',
				NODE_ENV: 'development',
			}),
		).toThrow('S3_BUCKET is required')
		expect(() => resolveConfig(developmentEnv({ FIREHOSE_ALLOW_DISK_STORAGE: 'not-a-boolean' }))).toThrow(
			'Invalid FIREHOSE_ALLOW_DISK_STORAGE',
		)
	})

	test('validates S3 bucket, prefix, and coherent optional credentials', () => {
		expect(() => resolveConfig(developmentEnv({ S3_BUCKET: 'Invalid_Bucket' }))).toThrow('Invalid S3_BUCKET')
		expect(() => resolveConfig(developmentEnv({ S3_BUCKET: 'valid-bucket', S3_PREFIX: '../sites/' }))).toThrow(
			'Invalid S3_PREFIX',
		)
		expect(() =>
			resolveConfig(developmentEnv({ S3_BUCKET: 'valid-bucket', AWS_ACCESS_KEY_ID: 'access-only' })),
		).toThrow('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together')

		const ambientIam = resolveConfig(productionEnv())
		expect(ambientIam.awsAccessKeyId).toBeUndefined()
		expect(ambientIam.awsSecretAccessKey).toBeUndefined()
		const staticCredentials = resolveConfig(
			productionEnv({ AWS_ACCESS_KEY_ID: 'access-key', AWS_SECRET_ACCESS_KEY: 'secret-key' }),
		)
		expect(staticCredentials.awsAccessKeyId).toBe('access-key')
	})

	test('rejects relay secrets and insecure production relays without logging raw URLs', () => {
		for (const firehoseService of [
			'wss://user:secret@example.invalid',
			'wss://example.invalid/?token=secret',
			'http://example.invalid',
		]) {
			expect(() => resolveConfig(developmentEnv({ FIREHOSE_SERVICE: firehoseService }))).toThrow(
				'Invalid FIREHOSE_SERVICE',
			)
		}
		expect(() => resolveConfig(productionEnv({ FIREHOSE_SERVICE: 'ws://relay.example.invalid' }))).toThrow(
			'Invalid FIREHOSE_SERVICE',
		)
	})

	test('allows explicit localhost HTTP development endpoints but requires HTTPS otherwise', () => {
		const local = resolveConfig(
			developmentEnv({
				WISP_PLC_DIRECTORY_URL: 'http://localhost:2583',
				HYDRANT_URL: 'http://127.0.0.1:3000',
				S3_BUCKET: 'local-test-bucket',
				S3_ENDPOINT: 'http://localhost:9000',
				REDIS_URL: 'redis://:password@localhost:6379/0',
			}),
		)
		expect(local.plcDirectoryUrl).toBe('http://localhost:2583')
		expect(local.hydrantUrl).toBe('http://127.0.0.1:3000')
		expect(local.s3Endpoint).toBe('http://localhost:9000')

		expect(() => resolveConfig(developmentEnv({ WISP_PLC_DIRECTORY_URL: 'http://plc.example.invalid' }))).toThrow(
			'Invalid WISP_PLC_DIRECTORY_URL',
		)
		expect(() => resolveConfig(developmentEnv({ HYDRANT_URL: 'https://user:secret@example.invalid' }))).toThrow(
			'Invalid HYDRANT_URL',
		)
		expect(() => resolveConfig(developmentEnv({ S3_ENDPOINT: 'http://objects.example.invalid' }))).toThrow(
			'Invalid S3_ENDPOINT',
		)
	})

	test('rejects malformed Redis and S3 endpoint URLs without echoing them', () => {
		for (const overrides of [
			{ REDIS_URL: 'https://redis.example.invalid' },
			{ S3_ENDPOINT: 'ftp://objects.example.invalid' },
			{ S3_ENDPOINT: 'https://user:secret@objects.example.invalid' },
		]) {
			let message = ''
			try {
				resolveConfig(developmentEnv(overrides))
			} catch (error) {
				message = error instanceof Error ? error.message : ''
			}
			expect(message).toMatch(/^Invalid (REDIS_URL|S3_ENDPOINT)$/)
			expect(message).not.toContain('secret')
		}
	})

	test('bounds Redis stream and group names and derives CLI modes from supplied args', () => {
		expect(() => resolveConfig(developmentEnv({ WISP_REVALIDATE_STREAM: 'has whitespace' }))).toThrow(
			'Invalid WISP_REVALIDATE_STREAM',
		)
		expect(() => resolveConfig(developmentEnv({ WISP_REVALIDATE_GROUP: 'x'.repeat(129) }))).toThrow(
			'Invalid WISP_REVALIDATE_GROUP',
		)

		const config = resolveConfig(developmentEnv(), ['--db-fill-only'])
		expect(config.isDbFillOnly).toBe(true)
		expect(config.isBackfill).toBe(true)
	})
})
