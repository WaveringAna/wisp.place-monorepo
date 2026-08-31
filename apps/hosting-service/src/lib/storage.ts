/**
 * Tiered storage configuration for wisp-hosting-service
 *
 * Implements a three-tier caching strategy:
 * - Hot (Memory): Instant access for frequently used files (index.html, CSS, JS)
 * - Warm (Disk): Local cache with eviction policy
 * - Cold (S3/R2): Object storage as source of truth (optional)
 *
 * When S3 is not configured, falls back to disk-only mode (warm tier acts as source of truth).
 * Hosting service is read-only: S3 writes are always skipped.
 */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLogger } from '@wispplace/observability'
import {
	DiskStorageTier,
	MemoryStorageTier,
	S3StorageTier,
	type StorageMetadata,
	type StorageTier,
	TieredStorage,
} from '@wispplace/tiered-storage'

const logger = createLogger('hosting-storage')

const DEFAULT_CACHE_DIR = './cache/sites'
const DEFAULT_HOT_CACHE_SIZE = 104857600 // 100MB
const DEFAULT_HOT_CACHE_COUNT = 500
const DEFAULT_WARM_CACHE_SIZE = 10737418240 // 10GB
const DEFAULT_HOT_CACHE_TTL_SECONDS = 60
const DEFAULT_S3_REGION = 'us-east-1'
const DEFAULT_S3_PREFIX = 'sites/'
const DEFAULT_PRIVATE_S3_PREFIX = 'private-sites/'
const MAX_CACHE_SIZE_BYTES = 1024 ** 4 // 1TiB
const MAX_CACHE_ITEMS = 1_000_000
const MAX_HOT_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60
const MAX_STORAGE_PATH_LENGTH = 1024
const MAX_S3_PREFIX_LENGTH = 512

/** Environment values used to resolve hosting storage configuration. */
export type HostingStorageEnvironment = Readonly<Record<string, string | undefined>>

/** Validated hosting storage configuration. */
export interface HostingStorageConfiguration {
	cacheDir: string
	hotCacheSize: number
	hotCacheCount: number
	warmCacheSize: number
	warmEvictionPolicy: 'lru' | 'fifo' | 'size'
	hotCacheTtlSeconds: number
	s3Bucket: string
	s3Region: string
	s3Endpoint: string | undefined
	s3ForcePathStyle: boolean
	s3Prefix: string
	privateS3Bucket: string
	privateS3Prefix: string
	awsAccessKeyId: string | undefined
	awsSecretAccessKey: string | undefined
	allowDiskSource: boolean
}

function parsePositiveStorageInteger(value: string | undefined, fallback: number, maximum: number): number {
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback
}

function hasExplicitLocalDevelopmentMode(env: HostingStorageEnvironment): boolean {
	return env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
}

function validateCacheDirectory(value: string | undefined): string {
	const cacheDir = value?.trim() || DEFAULT_CACHE_DIR
	const resolvedCacheDir = resolve(cacheDir)
	const resolvedRoot = resolve('/')
	const resolvedCurrentDirectory = resolve(process.cwd())
	if (
		cacheDir.length > MAX_STORAGE_PATH_LENGTH ||
		cacheDir.includes('\0') ||
		resolvedCacheDir === resolvedRoot ||
		resolvedCacheDir === resolvedCurrentDirectory
	) {
		throw new Error('Invalid CACHE_DIR')
	}

	// Follow an existing symlink before startup. This rejects accidental cache roots
	// such as a `cache` symlink to `/` or to the process working directory.
	if (existsSync(resolvedCacheDir)) {
		try {
			const realCacheDir = realpathSync(resolvedCacheDir)
			if (realCacheDir === resolvedRoot || realCacheDir === resolvedCurrentDirectory) {
				throw new Error('Invalid CACHE_DIR')
			}
		} catch (error) {
			if (error instanceof Error && error.message === 'Invalid CACHE_DIR') throw error
			throw new Error('Invalid CACHE_DIR')
		}
	}
	return cacheDir
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code <= 31 || code === 127) return true
	}
	return false
}

function validateS3Prefix(value: string | undefined, fallback: string, field: string): string {
	const rawPrefix = value === undefined || value === '' ? fallback : value
	const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`
	const segments = prefix.slice(0, -1).split('/')
	if (
		prefix.length > MAX_S3_PREFIX_LENGTH ||
		prefix.startsWith('/') ||
		prefix.includes('\\') ||
		hasControlCharacter(prefix) ||
		segments.some((segment) => !segment || segment === '.' || segment === '..') ||
		!/^[A-Za-z0-9._/-]+$/.test(prefix)
	) {
		throw new Error(`Invalid ${field}`)
	}
	return prefix
}

function isLocalDevelopmentHost(hostname: string): boolean {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '::1' ||
		hostname === '[::1]' ||
		hostname.endsWith('.localhost')
	)
}

function validateS3Endpoint(value: string | undefined, allowLocalDevelopment: boolean): string | undefined {
	if (!value) return undefined
	let endpoint: URL
	try {
		endpoint = new URL(value)
	} catch {
		throw new Error('Invalid S3_ENDPOINT')
	}
	const allowsLocalHttp =
		allowLocalDevelopment && endpoint.protocol === 'http:' && isLocalDevelopmentHost(endpoint.hostname)
	if (
		(endpoint.protocol !== 'https:' && !allowsLocalHttp) ||
		!endpoint.hostname ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new Error('Invalid S3_ENDPOINT')
	}
	return value
}

function hasValidRedisUrl(value: string | undefined): boolean {
	if (!value) return false
	try {
		const url = new URL(value)
		return (
			(url.protocol === 'redis:' || url.protocol === 'rediss:') && Boolean(url.hostname) && !url.search && !url.hash
		)
	} catch {
		return false
	}
}

/**
 * Resolve and validate storage configuration before the service starts accepting requests.
 *
 * S3 plus Redis are required unless the operator explicitly opts into
 * single-node disk-source mode. Development and test are the only implicit
 * local modes; an unknown environment is treated as production-like.
 *
 * @param env Environment values to validate
 * @returns Validated storage configuration
 * @throws Error when source-of-truth or path configuration is unsafe
 */
export function resolveHostingStorageConfig(env: HostingStorageEnvironment = process.env): HostingStorageConfiguration {
	const localDevelopmentMode = hasExplicitLocalDevelopmentMode(env)
	const diskSourceOptIn = env.HOSTING_ALLOW_DISK_SOURCE === 'true'
	const s3Bucket = env.S3_BUCKET?.trim() || ''
	const privateS3Bucket = env.PRIVATE_S3_BUCKET?.trim() || s3Bucket
	if (diskSourceOptIn && (s3Bucket || env.PRIVATE_S3_BUCKET?.trim())) {
		throw new Error('HOSTING_ALLOW_DISK_SOURCE cannot be used with S3_BUCKET')
	}
	const allowDiskSource = localDevelopmentMode || diskSourceOptIn
	const s3Endpoint = validateS3Endpoint(env.S3_ENDPOINT?.trim(), localDevelopmentMode)
	const s3Prefix = validateS3Prefix(env.S3_PREFIX, DEFAULT_S3_PREFIX, 'S3_PREFIX')
	const privateS3Prefix = validateS3Prefix(env.PRIVATE_S3_PREFIX, DEFAULT_PRIVATE_S3_PREFIX, 'PRIVATE_S3_PREFIX')
	const warmEvictionPolicy = env.WARM_EVICTION_POLICY?.trim() || 'lru'
	if (warmEvictionPolicy !== 'lru' && warmEvictionPolicy !== 'fifo' && warmEvictionPolicy !== 'size') {
		throw new Error('Invalid WARM_EVICTION_POLICY')
	}

	if (!allowDiskSource) {
		if (!s3Bucket) throw new Error('S3_BUCKET is required unless disk-source mode is explicitly enabled')
		if (!hasValidRedisUrl(env.REDIS_URL))
			throw new Error('REDIS_URL is required unless disk-source mode is explicitly enabled')
	}

	return {
		cacheDir: validateCacheDirectory(env.CACHE_DIR),
		hotCacheSize: parsePositiveStorageInteger(env.HOT_CACHE_SIZE, DEFAULT_HOT_CACHE_SIZE, MAX_CACHE_SIZE_BYTES),
		hotCacheCount: parsePositiveStorageInteger(env.HOT_CACHE_COUNT, DEFAULT_HOT_CACHE_COUNT, MAX_CACHE_ITEMS),
		warmCacheSize: parsePositiveStorageInteger(env.WARM_CACHE_SIZE, DEFAULT_WARM_CACHE_SIZE, MAX_CACHE_SIZE_BYTES),
		warmEvictionPolicy,
		hotCacheTtlSeconds: parsePositiveStorageInteger(
			env.HOT_CACHE_TTL,
			DEFAULT_HOT_CACHE_TTL_SECONDS,
			MAX_HOT_CACHE_TTL_SECONDS,
		),
		s3Bucket,
		s3Region: env.S3_REGION?.trim() || DEFAULT_S3_REGION,
		s3Endpoint,
		s3ForcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
		s3Prefix,
		privateS3Bucket,
		privateS3Prefix,
		awsAccessKeyId: env.AWS_ACCESS_KEY_ID,
		awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		allowDiskSource,
	}
}

const resolvedStorageConfig = resolveHostingStorageConfig()
const CACHE_DIR = resolvedStorageConfig.cacheDir
const HOT_CACHE_SIZE = resolvedStorageConfig.hotCacheSize
const HOT_CACHE_COUNT = resolvedStorageConfig.hotCacheCount
const WARM_CACHE_SIZE = resolvedStorageConfig.warmCacheSize
const WARM_EVICTION_POLICY = resolvedStorageConfig.warmEvictionPolicy
const HOT_CACHE_TTL = resolvedStorageConfig.hotCacheTtlSeconds
const S3_BUCKET = resolvedStorageConfig.s3Bucket
const S3_REGION = resolvedStorageConfig.s3Region
const S3_ENDPOINT = resolvedStorageConfig.s3Endpoint
const S3_FORCE_PATH_STYLE = resolvedStorageConfig.s3ForcePathStyle
const AWS_ACCESS_KEY_ID = resolvedStorageConfig.awsAccessKeyId
const AWS_SECRET_ACCESS_KEY = resolvedStorageConfig.awsSecretAccessKey
const S3_PREFIX = resolvedStorageConfig.s3Prefix
const PRIVATE_BUCKET = resolvedStorageConfig.privateS3Bucket
const PRIVATE_PREFIX = resolvedStorageConfig.privateS3Prefix

// Identity serializers for raw binary data (no JSON transformation)
// Files are stored as-is without any encoding/decoding
const identitySerialize = async (data: unknown): Promise<Uint8Array> => {
	if (data instanceof Uint8Array) return data
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	if (Buffer.isBuffer(data)) return new Uint8Array(data)
	// For other types, fall back to JSON (shouldn't happen with file storage)
	return new TextEncoder().encode(JSON.stringify(data))
}

const identityDeserialize = async (data: Uint8Array): Promise<unknown> => {
	// Return as-is for binary file storage
	return data
}

/** Safe operation names exposed when a cold S3 read cannot complete. */
export type StorageReadOperation =
	| 'get'
	| 'getWithMetadata'
	| 'getStream'
	| 'exists'
	| 'getMetadata'
	| 'listKeys'
	| 'getStats'

/** Safe categories for S3 read failures. */
export type StorageUnavailableKind = 'authentication' | 'network' | 'service' | 'timeout' | 'unknown' | 'circuit-open'

/**
 * A non-authoritative S3 read failure.
 *
 * This error intentionally stores only a safe operation and category. It never
 * retains the driver error, object key, bucket, endpoint, or driver message.
 */
export class StorageUnavailableError extends Error {
	override readonly name = 'StorageUnavailableError'

	/**
	 * @param operation The failed read operation
	 * @param kind A safe failure category
	 */
	constructor(
		readonly operation: StorageReadOperation,
		readonly kind: StorageUnavailableKind,
	) {
		super('Storage is temporarily unavailable')
	}
}

/**
 * Test whether an error is a typed non-authoritative S3 read failure.
 *
 * @param error Value to inspect
 * @returns True when callers should return a transient storage response
 */
export function isStorageUnavailableError(error: unknown): error is StorageUnavailableError {
	return error instanceof StorageUnavailableError
}

/** Constant-time safe health state for public cold S3 reads. */
export interface StorageReadHealthSnapshot {
	configured: boolean
	status: 'not-configured' | 'healthy' | 'degraded' | 'unavailable'
	breaker: 'closed' | 'open' | 'half-open'
	consecutiveFailures: number
	totalFailures: number
	totalSuccesses: number
	circuitRejections: number
	lastSuccessAt: number | null
	lastFailureAt: number | null
	lastErrorKind: StorageUnavailableKind | null
	lastSuccessAgeMs: number | null
}

type ReadPermit = { probe: boolean }
type BreakerState = 'closed' | 'open' | 'half-open'

const S3_READ_FAILURE_THRESHOLD = 3
const S3_READ_BREAKER_COOLDOWN_MS = 5_000
const NOT_FOUND_S3_ERROR_NAMES = new Set(['NoSuchKey', 'NoSuchVersion', 'NotFound'])
const TIMEOUT_S3_ERROR_NAMES = new Set(['AbortError', 'RequestTimeout', 'TimeoutError', 'ETIMEDOUT'])
const AUTHENTICATION_S3_ERROR_NAMES = new Set([
	'AccessDenied',
	'CredentialsProviderError',
	'ExpiredToken',
	'InvalidAccessKeyId',
	'SignatureDoesNotMatch',
	'Unauthorized',
	'EACCES',
	'EPERM',
])
const NETWORK_S3_ERROR_NAMES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'EAI_AGAIN',
	'ENETUNREACH',
	'ENOTFOUND',
	'NetworkingError',
])

function getErrorFields(error: unknown): { name?: string; code?: string; statusCode?: number } {
	if (!error || typeof error !== 'object') return {}
	try {
		const value = error as {
			name?: unknown
			code?: unknown
			$metadata?: { httpStatusCode?: unknown }
		}
		return {
			...(typeof value.name === 'string' && { name: value.name }),
			...(typeof value.code === 'string' && { code: value.code }),
			...(typeof value.$metadata?.httpStatusCode === 'number' && { statusCode: value.$metadata.httpStatusCode }),
		}
	} catch {
		return {}
	}
}

function isAuthoritativeS3Miss(error: unknown): boolean {
	const { name, code, statusCode } = getErrorFields(error)
	return (
		statusCode === 404 ||
		(name !== undefined && NOT_FOUND_S3_ERROR_NAMES.has(name)) ||
		(code !== undefined && NOT_FOUND_S3_ERROR_NAMES.has(code))
	)
}

function getStorageUnavailableKind(error: unknown): StorageUnavailableKind {
	const { name, code, statusCode } = getErrorFields(error)
	const candidates = [name, code].filter((candidate): candidate is string => candidate !== undefined)
	if (
		statusCode === 401 ||
		statusCode === 403 ||
		candidates.some((candidate) => AUTHENTICATION_S3_ERROR_NAMES.has(candidate))
	) {
		return 'authentication'
	}
	if (candidates.some((candidate) => TIMEOUT_S3_ERROR_NAMES.has(candidate))) return 'timeout'
	if (candidates.some((candidate) => NETWORK_S3_ERROR_NAMES.has(candidate))) return 'network'
	if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) return 'service'
	return 'unknown'
}

function getErrorDigest(error: unknown): string {
	let fingerprint: string
	try {
		if (error instanceof Error) {
			fingerprint = `${error.name}\0${error.message}`
		} else if (typeof error === 'string') {
			fingerprint = error
		} else if (error && typeof error === 'object') {
			const value = error as { name?: unknown; code?: unknown; message?: unknown }
			fingerprint = `${String(value.name ?? '')}\0${String(value.code ?? '')}\0${String(value.message ?? '')}`
		} else {
			fingerprint = String(error)
		}
	} catch {
		fingerprint = 'unreadable-error'
	}

	return createHash('sha256').update(fingerprint.slice(0, 4096)).digest('hex').slice(0, 16)
}

class StorageReadHealth {
	private breaker: BreakerState = 'closed'
	private breakerOpenUntil = 0
	private probeInFlight = false
	private consecutiveFailures = 0
	private totalFailures = 0
	private totalSuccesses = 0
	private circuitRejections = 0
	private lastSuccessAt: number | null = null
	private lastFailureAt: number | null = null
	private lastErrorKind: StorageUnavailableKind | null = null

	beginRead(operation: StorageReadOperation): ReadPermit | StorageUnavailableError {
		const now = Date.now()
		if (this.breaker === 'open') {
			if (now < this.breakerOpenUntil) {
				this.circuitRejections++
				return new StorageUnavailableError(operation, 'circuit-open')
			}
			if (this.probeInFlight) {
				this.circuitRejections++
				return new StorageUnavailableError(operation, 'circuit-open')
			}
			this.breaker = 'half-open'
			this.probeInFlight = true
			return { probe: true }
		}
		if (this.breaker === 'half-open') {
			this.circuitRejections++
			return new StorageUnavailableError(operation, 'circuit-open')
		}
		return { probe: false }
	}

	recordSuccess(permit: ReadPermit): void {
		this.totalSuccesses++
		this.consecutiveFailures = 0
		this.lastSuccessAt = Date.now()
		this.breaker = 'closed'
		this.breakerOpenUntil = 0
		if (permit.probe) this.probeInFlight = false
	}

	recordFailure(permit: ReadPermit, kind: StorageUnavailableKind): void {
		this.totalFailures++
		this.consecutiveFailures++
		this.lastFailureAt = Date.now()
		this.lastErrorKind = kind
		if (permit.probe) this.probeInFlight = false
		if (permit.probe || this.consecutiveFailures >= S3_READ_FAILURE_THRESHOLD) {
			this.breaker = 'open'
			this.breakerOpenUntil = Date.now() + S3_READ_BREAKER_COOLDOWN_MS
		}
	}

	abandonRead(permit: ReadPermit): void {
		if (!permit.probe) return
		this.probeInFlight = false
		this.breaker = 'open'
	}

	getSnapshot(configured: boolean): StorageReadHealthSnapshot {
		const now = Date.now()
		const breaker = this.breaker
		return {
			configured,
			status: !configured
				? 'not-configured'
				: breaker === 'closed'
					? this.consecutiveFailures > 0
						? 'degraded'
						: 'healthy'
					: 'unavailable',
			breaker,
			consecutiveFailures: this.consecutiveFailures,
			totalFailures: this.totalFailures,
			totalSuccesses: this.totalSuccesses,
			circuitRejections: this.circuitRejections,
			lastSuccessAt: this.lastSuccessAt,
			lastFailureAt: this.lastFailureAt,
			lastErrorKind: this.lastErrorKind,
			lastSuccessAgeMs: this.lastSuccessAt === null ? null : Math.max(0, now - this.lastSuccessAt),
		}
	}
}

/**
 * Read-only wrapper for S3 tier.
 *
 * Authoritative object absence remains `null`. Transient/authentication/network
 * failures are surfaced as `StorageUnavailableError` so callers cannot mistake
 * an unavailable source of truth for a cache miss.
 */
export class ReadOnlyS3Tier implements StorageTier {
	private static hasLoggedWriteSkip = false

	/**
	 * @param tier S3-backed tier to read from
	 * @param health Per-source health and breaker state
	 */
	constructor(
		private readonly tier: StorageTier,
		private readonly health: StorageReadHealth = new StorageReadHealth(),
	) {}

	async get(key: string): Promise<Uint8Array | null> {
		return await this.performRead('get', () => this.tier.get(key), { missingResult: null })
	}

	async getWithMetadata(key: string) {
		return await this.performRead('getWithMetadata', async () => (await this.tier.getWithMetadata?.(key)) ?? null, {
			missingResult: null,
		})
	}

	async getStream(key: string) {
		return await this.performRead('getStream', async () => (await this.tier.getStream?.(key)) ?? null, {
			missingResult: null,
		})
	}

	async exists(key: string): Promise<boolean> {
		return await this.performRead('exists', () => this.tier.exists(key), { missingResult: false })
	}

	async getMetadata(key: string): Promise<StorageMetadata | null> {
		return await this.performRead('getMetadata', () => this.tier.getMetadata(key), { missingResult: null })
	}

	async *listKeys(prefix?: string): AsyncIterableIterator<string> {
		const permit = this.health.beginRead('listKeys')
		if (permit instanceof StorageUnavailableError) throw permit
		let completed = false
		try {
			for await (const key of this.tier.listKeys(prefix)) {
				yield key
			}
			completed = true
			this.health.recordSuccess(permit)
		} catch (error) {
			throw this.handleReadFailure('listKeys', permit, error)
		} finally {
			if (!completed) this.health.abandonRead(permit)
		}
	}

	async getStats() {
		return await this.performRead('getStats', () => this.tier.getStats())
	}

	// Write operations are no-ops: hosting service never mutates its S3 source.
	async set(_key: string, _data: Uint8Array, _metadata: StorageMetadata): Promise<void> {
		this.logWriteSkip('set')
	}

	async setStream(_key: string, _stream: NodeJS.ReadableStream, _metadata: StorageMetadata): Promise<void> {
		this.logWriteSkip('setStream')
	}

	async setMetadata(_key: string, _metadata: StorageMetadata): Promise<void> {
		this.logWriteSkip('setMetadata')
	}

	async delete(_key: string): Promise<void> {
		this.logWriteSkip('delete')
	}

	async deleteMany(_keys: string[]): Promise<void> {
		this.logWriteSkip('deleteMany')
	}

	async clear(): Promise<void> {
		this.logWriteSkip('clear')
	}

	/**
	 * Return this wrapper's safe read-health state.
	 *
	 * @returns Constant-time breaker and counter snapshot
	 */
	getHealthSnapshot(): StorageReadHealthSnapshot {
		return this.health.getSnapshot(true)
	}

	private async performRead<T>(
		operation: StorageReadOperation,
		work: () => Promise<T>,
		options?: { missingResult: T },
	): Promise<T> {
		const permit = this.health.beginRead(operation)
		if (permit instanceof StorageUnavailableError) throw permit
		try {
			const result = await work()
			this.health.recordSuccess(permit)
			return result
		} catch (error) {
			if (options && isAuthoritativeS3Miss(error)) {
				this.health.recordSuccess(permit)
				return options.missingResult
			}
			throw this.handleReadFailure(operation, permit, error)
		}
	}

	private handleReadFailure(
		operation: StorageReadOperation,
		permit: ReadPermit,
		error: unknown,
	): StorageUnavailableError {
		const kind = getStorageUnavailableKind(error)
		this.health.recordFailure(permit, kind)
		logger.warn('S3 read operation failed', {
			operation,
			errorKind: kind,
			errorDigest: getErrorDigest(error),
		})
		return new StorageUnavailableError(operation, kind)
	}

	private logWriteSkip(operation: string): void {
		if (!ReadOnlyS3Tier.hasLoggedWriteSkip) {
			logger.info('Skipping S3 mutation in read-only tier', { operation })
			ReadOnlyS3Tier.hasLoggedWriteSkip = true
		}
	}
}

const publicS3ReadHealth = new StorageReadHealth()
const privateS3ReadHealth = new StorageReadHealth()

/**
 * Get a constant-time health snapshot for the public S3 source.
 *
 * @returns Safe public cold-tier read health without issuing storage I/O
 */
export function getStorageReadHealthSnapshot(): StorageReadHealthSnapshot {
	return publicS3ReadHealth.getSnapshot(Boolean(S3_BUCKET))
}

/**
 * Wrapper around MemoryStorageTier that enforces a short per-entry TTL.
 * This acts as a safety net: even if cache invalidation fails to clear the
 * hot tier, stale entries will expire after HOT_CACHE_TTL seconds.
 *
 * The TieredStorage defaultTTL (14 days) is too long for the hot tier -
 * we want stale hot entries to expire quickly and re-fetch from warm/cold.
 */
class TTLMemoryTier implements StorageTier {
	public readonly inner: MemoryStorageTier
	private ttlMs: number
	private insertedAt = new Map<string, number>()

	constructor(config: { maxSizeBytes: number; maxItems?: number }, ttlSeconds: number) {
		this.inner = new MemoryStorageTier(config)
		this.ttlMs = ttlSeconds * 1000
	}

	private isStale(key: string): boolean {
		const ts = this.insertedAt.get(key)
		if (ts === undefined) return false
		return Date.now() - ts > this.ttlMs
	}

	private async evictIfStale(key: string): Promise<boolean> {
		if (this.isStale(key)) {
			await this.inner.delete(key)
			this.insertedAt.delete(key)
			return true
		}
		return false
	}

	/** Remove timestamps for entries TinyLRU evicted without notifying this wrapper. */
	private async pruneMissingTimestamps(): Promise<void> {
		for (const key of this.insertedAt.keys()) {
			if (!(await this.inner.exists(key))) {
				this.insertedAt.delete(key)
			}
		}
	}

	private async recordSuccessfulWrite(key: string): Promise<void> {
		if (await this.inner.exists(key)) {
			this.insertedAt.set(key, Date.now())
		} else {
			this.insertedAt.delete(key)
		}
		await this.pruneMissingTimestamps()
	}

	async get(key: string) {
		if (await this.evictIfStale(key)) return null
		const result = await this.inner.get(key)
		if (!result) this.insertedAt.delete(key)
		return result
	}

	async getWithMetadata(key: string) {
		if (await this.evictIfStale(key)) return null
		const result = await this.inner.getWithMetadata(key)
		if (!result) this.insertedAt.delete(key)
		return result
	}

	async getStream(key: string) {
		if (await this.evictIfStale(key)) return null
		const result = await this.inner.getStream(key)
		if (!result) this.insertedAt.delete(key)
		return result
	}

	async set(key: string, data: Uint8Array, metadata: StorageMetadata) {
		try {
			await this.inner.set(key, data, metadata)
			await this.recordSuccessfulWrite(key)
		} catch (error) {
			if (!(await this.inner.exists(key))) this.insertedAt.delete(key)
			throw error
		}
	}

	async setStream(key: string, stream: NodeJS.ReadableStream, metadata: StorageMetadata) {
		try {
			await this.inner.setStream(key, stream, metadata)
			await this.recordSuccessfulWrite(key)
		} catch (error) {
			if (!(await this.inner.exists(key))) this.insertedAt.delete(key)
			throw error
		}
	}

	async delete(key: string) {
		this.insertedAt.delete(key)
		return this.inner.delete(key)
	}

	async deleteMany(keys: string[]) {
		for (const key of keys) this.insertedAt.delete(key)
		return this.inner.deleteMany(keys)
	}

	async exists(key: string) {
		if (await this.evictIfStale(key)) return false
		const exists = await this.inner.exists(key)
		if (!exists) this.insertedAt.delete(key)
		return exists
	}

	async *listKeys(prefix?: string) {
		yield* this.inner.listKeys(prefix)
	}

	async getMetadata(key: string) {
		if (await this.evictIfStale(key)) return null
		const metadata = await this.inner.getMetadata(key)
		if (!metadata) this.insertedAt.delete(key)
		return metadata
	}

	async setMetadata(key: string, metadata: StorageMetadata) {
		await this.inner.setMetadata(key, metadata)
		if (!(await this.inner.exists(key))) this.insertedAt.delete(key)
	}

	async getStats() {
		await this.pruneMissingTimestamps()
		return this.inner.getStats()
	}

	async clear() {
		this.insertedAt.clear()
		return this.inner.clear()
	}
}

// Exported for direct access during cache invalidation
export let hotTier: TTLMemoryTier
export let warmTier: StorageTier | undefined

let sharedDiskTier: DiskStorageTier | undefined

function getSharedDiskTier(): DiskStorageTier {
	sharedDiskTier ??= new DiskStorageTier({
		directory: CACHE_DIR,
		maxSizeBytes: WARM_CACHE_SIZE,
		evictionPolicy: WARM_EVICTION_POLICY,
		encodeColons: false, // Preserve colons for readable DID paths on Unix/macOS
	})
	return sharedDiskTier
}

/**
 * Initialize tiered storage
 * Must be called before serving requests
 */
function initializeStorage(): TieredStorage<Uint8Array> {
	// Determine cold tier: S3 if configured, otherwise disk acts as cold
	let coldTier: StorageTier

	const diskTier = getSharedDiskTier()

	if (S3_BUCKET) {
		// Full three-tier setup with S3 as cold storage
		const s3Tier = new S3StorageTier({
			bucket: S3_BUCKET,
			region: S3_REGION,
			endpoint: S3_ENDPOINT,
			forcePathStyle: S3_FORCE_PATH_STYLE,
			credentials:
				AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
					? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
					: undefined,
			prefix: S3_PREFIX,
		})

		// Hosting service is read-only: always wrap S3 tier to make it read-only
		coldTier = new ReadOnlyS3Tier(s3Tier, publicS3ReadHealth)
		warmTier = diskTier

		logger.info('Configured S3 as the read-only cold tier', { mode: 's3' })
	} else {
		// Disk-only mode: disk tier acts as source of truth (cold)
		coldTier = diskTier
		warmTier = undefined
		logger.info('Configured disk as the single-node cold tier', { mode: 'disk' })
	}

	// Hot tier with short TTL - entries expire quickly so stale data doesn't persist
	hotTier = new TTLMemoryTier({ maxSizeBytes: HOT_CACHE_SIZE, maxItems: HOT_CACHE_COUNT }, HOT_CACHE_TTL)

	logger.info('Configured hot cache TTL', { ttlSeconds: HOT_CACHE_TTL })

	const storage = new TieredStorage<Uint8Array>({
		tiers: {
			// Hot tier: In-memory LRU with short TTL for instant serving
			hot: hotTier,

			// Warm tier: Disk-based cache (only when S3 is configured)
			warm: warmTier,

			// Cold tier: S3/R2 as source of truth, or disk in disk-only mode
			cold: coldTier,
		},

		// Placement rules: determine which tiers each file goes to
		placementRules: [
			// Rewritten HTML: keep hot for fast serving
			{
				pattern: '**/.rewritten/**/*.html',
				tiers: ['hot', 'warm', 'cold'],
			},

			// index.html is critical: write to all tiers for instant serving
			{
				pattern: '**/index.html',
				tiers: ['hot', 'warm', 'cold'],
			},
			{
				pattern: 'index.html',
				tiers: ['hot', 'warm', 'cold'],
			},

			// CSS and JS: eligible for hot tier if accessed frequently
			{
				pattern: '**/*.{css,js}',
				tiers: ['hot', 'warm', 'cold'],
			},

			// Media files: never needed in memory, skip hot tier
			{
				pattern: '**/*.{jpg,jpeg,png,gif,webp,svg,ico,mp4,webm,mp3,woff,woff2,ttf,eot}',
				tiers: ['warm', 'cold'],
			},

			// Default: everything else goes to warm and cold
			{
				pattern: '**',
				tiers: ['warm', 'cold'],
			},
		],

		// IMPORTANT: Compression is disabled at the tiered-storage level
		// Text files (HTML, CSS, JS, JSON) are pre-compressed with gzip at the app level
		// Binary files (images, video) are stored uncompressed as they're already compressed
		// The file's compression state is tracked in customMetadata.encoding
		compression: false,

		// TTL for cache entries (14 days)
		defaultTTL: 14 * 24 * 60 * 60 * 1000,

		// Eager promotion: promote data to upper tiers on read
		// This ensures frequently accessed files end up in hot tier
		promotionStrategy: 'eager',

		// Identity serialization: store raw binary without JSON transformation
		serialization: {
			serialize: identitySerialize,
			deserialize: identityDeserialize,
		},
	})

	return storage
}

// Export singleton instance
export const storage = initializeStorage()

/**
 * Add source-CID provenance only when the cold object still matches the bytes
 * just verified by the caller. A false result is safe to repair by download.
 */
export async function addPublicSourceCidIfChecksumMatches(
	key: string,
	expectedChecksum: string,
	sourceCid: string,
): Promise<boolean> {
	return await storage.addSourceCidIfChecksumMatches(key, expectedChecksum, sourceCid)
}

/**
 * Evict one public file from local cache tiers without deleting the source copy.
 *
 * This is used when cached metadata does not match the manifest. It never
 * touches the cold tier, including S3 and disk-only cold storage. The underlying
 * operation is ordered with eager promotion so concurrent evictions cannot be
 * undone by a stale lower-tier read.
 */
export async function evictPublicCacheKey(key: string): Promise<void> {
	const failures = await storage.invalidateUpperCacheKey(key)
	if (failures.length > 0) {
		const tiers = failures.map(({ tier }) => tier).join(', ')
		throw new Error(`Failed to evict local cache tier${failures.length === 1 ? '' : 's'}: ${tiers}`)
	}
}

// Avoid promotion into shared caches that outlive the authorization decision.
function initializePrivateStorage(): TieredStorage<Uint8Array> {
	let coldTier: StorageTier

	if (PRIVATE_BUCKET) {
		coldTier = new ReadOnlyS3Tier(
			new S3StorageTier({
				bucket: PRIVATE_BUCKET,
				region: S3_REGION,
				endpoint: S3_ENDPOINT,
				forcePathStyle: S3_FORCE_PATH_STYLE,
				credentials:
					AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
						? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
						: undefined,
				prefix: PRIVATE_PREFIX,
			}),
			privateS3ReadHealth,
		)
	} else {
		// Public and private disk-only reads share one index and mutation queue.
		// Private keys remain under their existing `private/` namespace.
		coldTier = getSharedDiskTier()
	}

	return new TieredStorage<Uint8Array>({
		tiers: { cold: coldTier },
		compression: false,
		promotionStrategy: 'lazy',
		serialization: {
			serialize: identitySerialize,
			deserialize: identityDeserialize,
		},
	})
}

export const privateStorage = initializePrivateStorage()

/**
 * Get a safe storage configuration summary for application logs and startup.
 * Object-store identifiers and prefixes are deliberately excluded.
 */
export function getStorageConfig() {
	return {
		cacheDir: CACHE_DIR,
		hotCacheSize: `${(HOT_CACHE_SIZE / 1024 / 1024).toFixed(0)}MB`,
		hotCacheCount: HOT_CACHE_COUNT,
		warmCacheSize: `${(WARM_CACHE_SIZE / 1024 / 1024 / 1024).toFixed(1)}GB`,
		warmEvictionPolicy: WARM_EVICTION_POLICY,
		coldStorageMode: S3_BUCKET ? 's3' : 'disk',
		s3EndpointConfigured: Boolean(S3_ENDPOINT),
		diskSourceAllowed: resolvedStorageConfig.allowDiskSource,
	}
}
