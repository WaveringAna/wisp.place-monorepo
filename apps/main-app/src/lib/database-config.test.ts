import { describe, expect, test } from 'bun:test'
import {
	DEFAULT_DATABASE_URL,
	MAX_DATABASE_URL_LENGTH,
	normalizePostgresUrl,
	resolveDatabaseConfiguration,
	TEST_DATABASE_NAME,
} from './database-config'

const developmentEnvironment = { NODE_ENV: 'development' } as const
const testDatabaseUrl = `postgres://postgres:postgres@127.0.0.1:5432/${TEST_DATABASE_NAME}`
const testEnvironment = { NODE_ENV: 'test', TEST_DATABASE_URL: testDatabaseUrl } as const

const expectedDefaultConfiguration = (primaryUrl: string, readUrl: string, hasSeparateReadPool: boolean) => ({
	primaryUrl,
	readUrl,
	hasSeparateReadPool,
	isProduction: false,
	requiresProductionSafety: false,
	primaryPool: {
		max: 10,
		idleTimeoutSeconds: 30,
		connectionTimeoutSeconds: 5,
	},
	readPool: {
		max: 4,
		idleTimeoutSeconds: 30,
		connectionTimeoutSeconds: 5,
	},
	readProbeTimeoutMs: 1_500,
	readQueryTimeoutMs: 3_000,
	readMaxReplayLagMs: 2_000,
	readReceiverFreshnessMs: 30_000,
	readProbeIntervalMs: 5_000,
	readCircuitCooldownMs: 5_000,
})

describe('resolveDatabaseConfiguration', () => {
	test('uses DATABASE_URL for both clients when no read URL is configured outside test mode', () => {
		expect(
			resolveDatabaseConfiguration({ ...developmentEnvironment, DATABASE_URL: 'postgres://primary/wisp' }),
		).toEqual(expectedDefaultConfiguration('postgres://primary/wisp', 'postgres://primary/wisp', false))
	})

	test('falls back to the primary for an empty read URL', () => {
		expect(
			resolveDatabaseConfiguration({
				...developmentEnvironment,
				DATABASE_URL: 'postgres://primary/wisp',
				DATABASE_READ_URL: '   ',
			}),
		).toEqual(expectedDefaultConfiguration('postgres://primary/wisp', 'postgres://primary/wisp', false))
	})

	test('does not create a second pool for equivalent normalized URLs', () => {
		const configuration = resolveDatabaseConfiguration({
			...developmentEnvironment,
			DATABASE_URL: 'postgresql://reader:password@LOCALHOST:5432/wisp?b=2&a=1',
			DATABASE_READ_URL: 'postgres://reader:password@localhost/wisp?a=1&b=2',
		})

		expect(configuration.hasSeparateReadPool).toBe(false)
		expect(normalizePostgresUrl(configuration.primaryUrl)).toBe(normalizePostgresUrl(configuration.readUrl))
	})

	test('only configures a separate read pool for a different normalized URL', () => {
		const configuration = resolveDatabaseConfiguration({
			...developmentEnvironment,
			DATABASE_URL: 'postgres://primary/wisp',
			DATABASE_READ_URL: 'postgres://replica/wisp',
		})

		expect(configuration).toEqual(
			expectedDefaultConfiguration('postgres://primary/wisp', 'postgres://replica/wisp', true),
		)
	})

	test('uses the local default only in development mode', () => {
		expect(resolveDatabaseConfiguration(developmentEnvironment)).toEqual(
			expectedDefaultConfiguration(DEFAULT_DATABASE_URL, DEFAULT_DATABASE_URL, false),
		)
	})

	test('requires a dedicated TEST_DATABASE_URL and ignores production endpoints in test mode', () => {
		const configuration = resolveDatabaseConfiguration({
			...testEnvironment,
			DATABASE_URL: 'postgres://writer@production.example/wisp?sslmode=verify-full',
			DATABASE_READ_URL: 'postgres://reader@production.example/wisp?sslmode=verify-full',
		})

		expect(configuration).toEqual(expectedDefaultConfiguration(testDatabaseUrl, testDatabaseUrl, false))
		expect(() => resolveDatabaseConfiguration({ NODE_ENV: 'test' })).toThrow(
			'TEST_DATABASE_URL is required for database access when NODE_ENV=test',
		)
	})

	test('rejects a non-disposable TEST_DATABASE_URL before it can connect', () => {
		expect(() =>
			resolveDatabaseConfiguration({
				NODE_ENV: 'test',
				TEST_DATABASE_URL: `postgres://postgres@db.example/${TEST_DATABASE_NAME}`,
			}),
		).toThrow(`TEST_DATABASE_URL must target the local ${TEST_DATABASE_NAME} database`)
		expect(() =>
			resolveDatabaseConfiguration({
				NODE_ENV: 'test',
				TEST_DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/wisp',
			}),
		).toThrow(`TEST_DATABASE_URL must target the local ${TEST_DATABASE_NAME} database`)
		expect(() =>
			resolveDatabaseConfiguration({
				NODE_ENV: 'test',
				TEST_DATABASE_URL: `${testDatabaseUrl}?host=production.example`,
			}),
		).toThrow(`TEST_DATABASE_URL must target the local ${TEST_DATABASE_NAME} database`)
	})

	test('rejects a missing primary URL when NODE_ENV is missing or mistyped', () => {
		const expected = 'DATABASE_URL is required unless NODE_ENV is explicitly development or test'
		expect(() => resolveDatabaseConfiguration({})).toThrow(expected)
		expect(() => resolveDatabaseConfiguration({ NODE_ENV: 'developement' })).toThrow(expected)
		expect(() => resolveDatabaseConfiguration({ NODE_ENV: 'production' })).toThrow(expected)
		expect(() =>
			resolveDatabaseConfiguration({
				NODE_ENV: 'production',
				TEST_DATABASE_URL: testDatabaseUrl,
			}),
		).toThrow(expected)
	})

	test('applies production-safe transport rules to unknown environments', () => {
		expect(() =>
			resolveDatabaseConfiguration({
				NODE_ENV: 'staging',
				DATABASE_URL: 'postgres://writer@db.example/wisp',
			}),
		).toThrow('DATABASE_URL must set sslmode=require, verify-ca, or verify-full')

		const secure = resolveDatabaseConfiguration({
			NODE_ENV: 'staging',
			DATABASE_URL: 'postgres://writer@db.example/wisp?sslmode=verify-full',
		})
		expect(secure.isProduction).toBe(false)
		expect(secure.requiresProductionSafety).toBe(true)
	})

	test('rejects malformed URLs without exposing their credentials', () => {
		const secret = 'top-secret-password'
		try {
			resolveDatabaseConfiguration({
				...developmentEnvironment,
				DATABASE_URL: `postgres://reader:${secret}@[::1/wisp`,
			})
			throw new Error('expected malformed URL failure')
		} catch (error) {
			expect((error as Error).message).toContain('DATABASE_URL')
			expect((error as Error).message).not.toContain(secret)
		}
	})

	test('bounds database URL and pool configuration sizes', () => {
		expect(() =>
			resolveDatabaseConfiguration({
				...developmentEnvironment,
				DATABASE_URL: `postgres://localhost/${'a'.repeat(MAX_DATABASE_URL_LENGTH)}`,
			}),
		).toThrow('DATABASE_URL exceeds the maximum allowed length')
		expect(() =>
			resolveDatabaseConfiguration({
				...developmentEnvironment,
				DATABASE_URL: 'postgres://primary/wisp',
				DATABASE_POOL_MAX: '21',
			}),
		).toThrow('DATABASE_POOL_MAX must be an integer between 1 and 20')
		expect(() =>
			resolveDatabaseConfiguration({
				...developmentEnvironment,
				DATABASE_URL: 'postgres://primary/wisp',
				DATABASE_READ_RECEIVER_FRESHNESS_MS: '999',
			}),
		).toThrow('DATABASE_READ_RECEIVER_FRESHNESS_MS must be an integer between 1000 and 300000')
	})

	test('requires an explicit TLS policy for non-loopback production endpoints', () => {
		expect(() =>
			resolveDatabaseConfiguration({
				NODE_ENV: 'production',
				DATABASE_URL: 'postgres://writer@db.example/wisp',
			}),
		).toThrow('DATABASE_URL must set sslmode=require, verify-ca, or verify-full')

		const secure = resolveDatabaseConfiguration({
			NODE_ENV: 'production',
			DATABASE_URL: 'postgres://writer@db.example/wisp?sslmode=verify-full',
		})
		expect(secure.isProduction).toBe(true)
		expect(secure.requiresProductionSafety).toBe(true)
		expect(secure.hasSeparateReadPool).toBe(false)
	})

	test('allows a documented private-network transport exception in production', () => {
		const configuration = resolveDatabaseConfiguration({
			NODE_ENV: 'production',
			DATABASE_URL: 'postgres://writer@postgres.internal/wisp',
			DATABASE_ALLOW_INSECURE_PRIVATE_NETWORK: 'true',
		})
		expect(configuration.isProduction).toBe(true)
		expect(configuration.requiresProductionSafety).toBe(true)
	})
})
