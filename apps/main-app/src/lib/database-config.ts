export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/wisp'
export const MAX_DATABASE_URL_LENGTH = 2048
/** The only database name accepted by the destructive main-app integration test. */
export const TEST_DATABASE_NAME = 'wisp_main_app_test'

const DEFAULT_PRIMARY_POOL_MAX = 10
const DEFAULT_READ_POOL_MAX = 4
const DEFAULT_IDLE_TIMEOUT_SECONDS = 30
const DEFAULT_CONNECTION_TIMEOUT_SECONDS = 5
const DEFAULT_READ_PROBE_TIMEOUT_MS = 1_500
const DEFAULT_READ_QUERY_TIMEOUT_MS = 3_000
const DEFAULT_READ_MAX_REPLAY_LAG_MS = 2_000
const DEFAULT_READ_RECEIVER_FRESHNESS_MS = 30_000
const DEFAULT_READ_PROBE_INTERVAL_MS = 5_000
const DEFAULT_READ_CIRCUIT_COOLDOWN_MS = 5_000

export interface DatabaseEnvironment {
	DATABASE_ALLOW_INSECURE_PRIVATE_NETWORK?: string
	DATABASE_CONNECTION_TIMEOUT_SECONDS?: string
	DATABASE_IDLE_TIMEOUT_SECONDS?: string
	DATABASE_POOL_MAX?: string
	DATABASE_READ_CIRCUIT_COOLDOWN_MS?: string
	DATABASE_READ_MAX_REPLAY_LAG_MS?: string
	DATABASE_READ_RECEIVER_FRESHNESS_MS?: string
	DATABASE_READ_POOL_MAX?: string
	DATABASE_READ_PROBE_INTERVAL_MS?: string
	DATABASE_READ_PROBE_TIMEOUT_MS?: string
	DATABASE_READ_QUERY_TIMEOUT_MS?: string
	DATABASE_READ_URL?: string
	DATABASE_URL?: string
	/** Used only when NODE_ENV=test; it is never a production application endpoint. */
	TEST_DATABASE_URL?: string
	NODE_ENV?: string
}

export interface DatabasePoolConfiguration {
	max: number
	idleTimeoutSeconds: number
	connectionTimeoutSeconds: number
}

export interface DatabaseConfiguration {
	primaryUrl: string
	readUrl: string
	hasSeparateReadPool: boolean
	isProduction: boolean
	/** True outside the only explicit local modes: development and test. */
	requiresProductionSafety: boolean
	primaryPool: DatabasePoolConfiguration
	readPool: DatabasePoolConfiguration
	readProbeTimeoutMs: number
	readQueryTimeoutMs: number
	readMaxReplayLagMs: number
	readReceiverFreshnessMs: number
	readProbeIntervalMs: number
	readCircuitCooldownMs: number
}

type ParsedDatabaseUrl = {
	raw: string
	normalized: string
	url: URL
}

const nonEmpty = (value: string | undefined): string | undefined => value?.trim() || undefined

const parseBoundedInteger = (
	value: string | undefined,
	name: string,
	defaultValue: number,
	minimum: number,
	maximum: number,
): number => {
	const raw = nonEmpty(value)
	if (raw === undefined) return defaultValue
	if (!/^[0-9]+$/.test(raw)) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
	}

	const parsed = Number(raw)
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
	}

	return parsed
}

const isLoopbackHost = (hostname: string): boolean => {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
	return host.length === 0 || host === 'localhost' || host === '::1' || host.startsWith('127.')
}

const hasRequiredSslMode = (url: URL): boolean => {
	const sslMode = [...url.searchParams.entries()].find(([name]) => name.toLowerCase() === 'sslmode')?.[1]?.toLowerCase()
	return sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full'
}

const parsePostgresUrl = (value: string, variableName: string): ParsedDatabaseUrl => {
	if (value.length > MAX_DATABASE_URL_LENGTH) {
		throw new Error(`${variableName} exceeds the maximum allowed length`)
	}

	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error(`${variableName} must be a valid PostgreSQL URL`)
	}

	if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
		throw new Error(`${variableName} must use the postgres or postgresql scheme`)
	}
	if (url.hash.length > 0) {
		throw new Error(`${variableName} must not include a URL fragment`)
	}

	// Compare endpoints in a canonical form so aliases such as postgres/postgresql,
	// host casing, the default port, and query-string ordering do not create a pool.
	url.protocol = 'postgres:'
	url.hostname = url.hostname.toLowerCase()
	if (url.port === '5432') url.port = ''
	url.searchParams.sort()

	return { raw: value, normalized: url.toString(), url }
}

const assertDisposableTestDatabase = (parsed: ParsedDatabaseUrl): void => {
	// Test migrations mutate the public schema. Restrict them to the documented
	// loopback-only disposable database so TEST_DATABASE_URL cannot target a
	// deployed endpoint through DATABASE_URL, DATABASE_READ_URL, or a query
	// parameter interpreted as a connection override by a database driver.
	if (
		parsed.url.hostname.length === 0 ||
		!isLoopbackHost(parsed.url.hostname) ||
		parsed.url.pathname !== `/${TEST_DATABASE_NAME}` ||
		parsed.url.search.length > 0
	) {
		throw new Error(`TEST_DATABASE_URL must target the local ${TEST_DATABASE_NAME} database`)
	}
}

/** Exposed for focused configuration tests; it never opens a database connection. */
export const normalizePostgresUrl = (value: string, variableName = 'DATABASE_URL'): string =>
	parsePostgresUrl(value.trim(), variableName).normalized

const validateProductionSafeTransport = (
	parsed: ParsedDatabaseUrl,
	variableName: string,
	environment: DatabaseEnvironment,
): void => {
	if (isLoopbackHost(parsed.url.hostname)) return
	if (nonEmpty(environment.DATABASE_ALLOW_INSECURE_PRIVATE_NETWORK)?.toLowerCase() === 'true') return
	if (!hasRequiredSslMode(parsed.url)) {
		throw new Error(
			`${variableName} must set sslmode=require, verify-ca, or verify-full for a non-loopback production-safe database`,
		)
	}
}

/**
 * Resolves the primary and presentation-read endpoints without opening a connection.
 * DATABASE_URL is always the primary endpoint. DATABASE_READ_URL is optional and is
 * only used for explicitly eventual presentation reads.
 */
export const resolveDatabaseConfiguration = (environment: DatabaseEnvironment): DatabaseConfiguration => {
	const isProduction = environment.NODE_ENV === 'production'
	const isTestEnvironment = environment.NODE_ENV === 'test'
	const isExplicitLocalEnvironment = environment.NODE_ENV === 'development' || isTestEnvironment
	const requiresProductionSafety = !isExplicitLocalEnvironment
	const primaryRaw = isTestEnvironment
		? (nonEmpty(environment.TEST_DATABASE_URL) ??
			(() => {
				throw new Error('TEST_DATABASE_URL is required for database access when NODE_ENV=test')
			})())
		: (nonEmpty(environment.DATABASE_URL) ??
			(requiresProductionSafety
				? (() => {
						throw new Error('DATABASE_URL is required unless NODE_ENV is explicitly development or test')
					})()
				: DEFAULT_DATABASE_URL))
	// Test runs must not inherit either production endpoint. They use the
	// explicit disposable URL for both clients, although db.test only uses db.
	const readRaw = isTestEnvironment ? primaryRaw : (nonEmpty(environment.DATABASE_READ_URL) ?? primaryRaw)
	const primaryVariableName = isTestEnvironment ? 'TEST_DATABASE_URL' : 'DATABASE_URL'
	const primary = parsePostgresUrl(primaryRaw, primaryVariableName)
	const read = parsePostgresUrl(readRaw, isTestEnvironment ? 'TEST_DATABASE_URL' : 'DATABASE_READ_URL')

	if (isTestEnvironment) {
		assertDisposableTestDatabase(primary)
	} else if (requiresProductionSafety) {
		validateProductionSafeTransport(primary, 'DATABASE_URL', environment)
		validateProductionSafeTransport(read, 'DATABASE_READ_URL', environment)
	}

	const idleTimeoutSeconds = parseBoundedInteger(
		environment.DATABASE_IDLE_TIMEOUT_SECONDS,
		'DATABASE_IDLE_TIMEOUT_SECONDS',
		DEFAULT_IDLE_TIMEOUT_SECONDS,
		5,
		300,
	)
	const connectionTimeoutSeconds = parseBoundedInteger(
		environment.DATABASE_CONNECTION_TIMEOUT_SECONDS,
		'DATABASE_CONNECTION_TIMEOUT_SECONDS',
		DEFAULT_CONNECTION_TIMEOUT_SECONDS,
		1,
		30,
	)

	return {
		primaryUrl: primary.raw,
		readUrl: read.raw,
		hasSeparateReadPool: primary.normalized !== read.normalized,
		isProduction,
		requiresProductionSafety,
		primaryPool: {
			max: parseBoundedInteger(environment.DATABASE_POOL_MAX, 'DATABASE_POOL_MAX', DEFAULT_PRIMARY_POOL_MAX, 1, 20),
			idleTimeoutSeconds,
			connectionTimeoutSeconds,
		},
		readPool: {
			max: parseBoundedInteger(
				environment.DATABASE_READ_POOL_MAX,
				'DATABASE_READ_POOL_MAX',
				DEFAULT_READ_POOL_MAX,
				1,
				10,
			),
			idleTimeoutSeconds,
			connectionTimeoutSeconds,
		},
		readProbeTimeoutMs: parseBoundedInteger(
			environment.DATABASE_READ_PROBE_TIMEOUT_MS,
			'DATABASE_READ_PROBE_TIMEOUT_MS',
			DEFAULT_READ_PROBE_TIMEOUT_MS,
			100,
			10_000,
		),
		readQueryTimeoutMs: parseBoundedInteger(
			environment.DATABASE_READ_QUERY_TIMEOUT_MS,
			'DATABASE_READ_QUERY_TIMEOUT_MS',
			DEFAULT_READ_QUERY_TIMEOUT_MS,
			100,
			30_000,
		),
		readMaxReplayLagMs: parseBoundedInteger(
			environment.DATABASE_READ_MAX_REPLAY_LAG_MS,
			'DATABASE_READ_MAX_REPLAY_LAG_MS',
			DEFAULT_READ_MAX_REPLAY_LAG_MS,
			100,
			60_000,
		),
		readReceiverFreshnessMs: parseBoundedInteger(
			environment.DATABASE_READ_RECEIVER_FRESHNESS_MS,
			'DATABASE_READ_RECEIVER_FRESHNESS_MS',
			DEFAULT_READ_RECEIVER_FRESHNESS_MS,
			1_000,
			300_000,
		),
		readProbeIntervalMs: parseBoundedInteger(
			environment.DATABASE_READ_PROBE_INTERVAL_MS,
			'DATABASE_READ_PROBE_INTERVAL_MS',
			DEFAULT_READ_PROBE_INTERVAL_MS,
			500,
			60_000,
		),
		readCircuitCooldownMs: parseBoundedInteger(
			environment.DATABASE_READ_CIRCUIT_COOLDOWN_MS,
			'DATABASE_READ_CIRCUIT_COOLDOWN_MS',
			DEFAULT_READ_CIRCUIT_COOLDOWN_MS,
			500,
			60_000,
		),
	}
}
