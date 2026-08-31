import { normalizeSitePath } from '@wispplace/fs-utils'
import { createLogger } from '@wispplace/observability'
import { buildPrivateStorageKey, isValidSiteId, PRIVATE_STORAGE_PREFIX } from '@wispplace/private-sites'
import { DiskStorageTier, S3StorageTier, TieredStorage } from '@wispplace/tiered-storage'
import { PRIVATE_SITE_STORAGE_WRITE_TIMEOUT_MS } from './private-site-lifecycle'

const logger = createLogger('main-app')
const LOCAL_PRIVATE_STORAGE_ENVS = new Set(['development', 'test'])

export interface PrivateStorageEnvironment {
	NODE_ENV?: string
	S3_BUCKET?: string
	PRIVATE_S3_BUCKET?: string
	S3_REGION?: string
	PRIVATE_S3_REGION?: string
	S3_ENDPOINT?: string
	PRIVATE_S3_ENDPOINT?: string
	S3_FORCE_PATH_STYLE?: string
	PRIVATE_S3_PREFIX?: string
	PRIVATE_ALLOW_SHARED_BUCKET?: string
	AWS_ACCESS_KEY_ID?: string
	AWS_SECRET_ACCESS_KEY?: string
	CACHE_DIR?: string
	PRIVATE_CACHE_DIR?: string
}

export type PrivateStorageConfiguration =
	| {
			mode: 's3'
			bucket: string
			region: string
			endpoint: string | undefined
			prefix: string
			forcePathStyle: boolean
			credentials: { accessKeyId: string; secretAccessKey: string } | undefined
	  }
	| { mode: 'disk'; directory: string }

const nonEmpty = (value: string | undefined): string | undefined => {
	const normalized = value?.trim()
	return normalized || undefined
}

/**
 * Private objects need durable, region-shared storage. Disk is allowed only in
 * the explicit local modes so a production process cannot silently create an
 * isolated namespace that another region cannot read or clean.
 */
export const resolvePrivateStorageConfiguration = (
	env: PrivateStorageEnvironment = process.env,
): PrivateStorageConfiguration => {
	const publicBucket = nonEmpty(env.S3_BUCKET)
	const privateBucket = nonEmpty(env.PRIVATE_S3_BUCKET)
	const bucket = privateBucket ?? publicBucket
	const localMode = LOCAL_PRIVATE_STORAGE_ENVS.has(env.NODE_ENV ?? '')

	if (!bucket) {
		if (!localMode) {
			throw new Error('private durable S3 storage is required outside development or test')
		}
		return {
			mode: 'disk',
			directory: nonEmpty(env.PRIVATE_CACHE_DIR) ?? nonEmpty(env.CACHE_DIR) ?? './cache/private-sites',
		}
	}

	const sharesPublicBucket = Boolean(publicBucket) && bucket === publicBucket
	if (sharesPublicBucket && env.PRIVATE_ALLOW_SHARED_BUCKET !== 'true') {
		throw new Error(
			'private storage cannot share S3_BUCKET without PRIVATE_ALLOW_SHARED_BUCKET=true and a private prefix policy',
		)
	}

	return {
		mode: 's3',
		bucket,
		region: nonEmpty(env.PRIVATE_S3_REGION) ?? nonEmpty(env.S3_REGION) ?? 'us-east-1',
		endpoint: nonEmpty(env.PRIVATE_S3_ENDPOINT) ?? nonEmpty(env.S3_ENDPOINT),
		prefix: nonEmpty(env.PRIVATE_S3_PREFIX) ?? 'private-sites/',
		forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
		credentials:
			nonEmpty(env.AWS_ACCESS_KEY_ID) && nonEmpty(env.AWS_SECRET_ACCESS_KEY)
				? { accessKeyId: nonEmpty(env.AWS_ACCESS_KEY_ID)!, secretAccessKey: nonEmpty(env.AWS_SECRET_ACCESS_KEY)! }
				: undefined,
	}
}

const storageConfiguration = resolvePrivateStorageConfiguration()
const coldTier =
	storageConfiguration.mode === 's3'
		? new S3StorageTier({
				bucket: storageConfiguration.bucket,
				region: storageConfiguration.region,
				endpoint: storageConfiguration.endpoint,
				credentials: storageConfiguration.credentials,
				prefix: storageConfiguration.prefix,
				forcePathStyle: storageConfiguration.forcePathStyle,
			})
		: new DiskStorageTier({
				directory: storageConfiguration.directory,
				maxSizeBytes: 10 * 1024 * 1024 * 1024,
				evictionPolicy: 'lru',
				encodeColons: false,
			})

if (storageConfiguration.mode === 's3') {
	logger.info('[PrivateStorage] Configured durable S3 cold tier')
} else {
	logger.info('[PrivateStorage] Configured local disk cold tier')
}

const identitySerialize = async (data: unknown): Promise<Uint8Array> => {
	if (data instanceof Uint8Array) return data
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	if (Buffer.isBuffer(data)) return new Uint8Array(data)
	return new TextEncoder().encode(JSON.stringify(data))
}

const identityDeserialize = async (data: Uint8Array): Promise<unknown> => data

export const privateStorage = new TieredStorage<Uint8Array>({
	tiers: { cold: coldTier },
	compression: false,
	serialization: { serialize: identitySerialize, deserialize: identityDeserialize },
})

export class PrivateStorageWriteTimeoutError extends Error {
	constructor() {
		super('private storage write timed out')
		this.name = 'PrivateStorageWriteTimeoutError'
	}
}

const privateStorageMimeType = (value: string | null | undefined): string | undefined => {
	if (value === null || value === undefined) return undefined
	const normalized = value.trim()
	return normalized.length > 0 && normalized.length <= 255 && /^[\x20-\x7E]+$/.test(normalized)
		? normalized
		: 'application/octet-stream'
}

const withPrivateStorageWriteDeadline = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
	const controller = new AbortController()
	let timedOut = false
	const timeout = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, PRIVATE_SITE_STORAGE_WRITE_TIMEOUT_MS)
	timeout.unref?.()

	try {
		return await operation(controller.signal)
	} catch (error) {
		if (timedOut) throw new PrivateStorageWriteTimeoutError()
		throw error
	} finally {
		clearTimeout(timeout)
	}
}

export const writePrivateFile = async (
	siteId: string,
	filePath: string,
	data: Uint8Array,
	mimeType?: string,
): Promise<void> => {
	if (!isValidSiteId(siteId) || !filePath || normalizeSitePath(filePath) !== filePath) {
		throw new Error('invalid private storage key')
	}
	const normalizedMimeType = privateStorageMimeType(mimeType)
	await withPrivateStorageWriteDeadline(async (signal) => {
		await privateStorage.set(buildPrivateStorageKey(siteId, filePath), data, {
			onlyTiers: ['cold'],
			signal,
			metadata: normalizedMimeType ? { mimeType: normalizedMimeType } : undefined,
		})
	})
}

/**
 * This is intentionally safe to repeat. Callers first move metadata to
 * `deleting`, so a storage failure leaves a hidden row that the reaper can retry.
 * The cold namespace is cleared natively or through bounded streamed batches.
 */
export const deletePrivateSiteFiles = async (siteId: string): Promise<number> => {
	if (!isValidSiteId(siteId)) throw new Error('invalid private site id')
	return await privateStorage.deleteColdPrefix(`${PRIVATE_STORAGE_PREFIX}/${siteId}/`)
}
