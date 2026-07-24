/**
 * Storage for private site content.
 *
 * Writes go straight to the cold tier (S3, or a disk fallback in local development), which
 * is the same source of truth the hosting service reads from. Private bytes are namespaced
 * under `private/<siteId>/` so they cannot collide with the public `<did>/<rkey>/` key
 * space; see `buildPrivateStorageKey`.
 */

import { createLogger } from '@wispplace/observability'
import { buildPrivateStorageKey, PRIVATE_STORAGE_PREFIX } from '@wispplace/private-sites'
import { DiskStorageTier, S3StorageTier, TieredStorage } from '@wispplace/tiered-storage'

const logger = createLogger('main-app')

// Private content must not share a bucket with public site content unless an operator has
// explicitly accepted that. The public bucket may carry an anonymous-read policy, which
// would expose `<prefix>private/<siteId>/<path>` directly and bypass all application
// authorization. Configure a separate block-public-access bucket via
// PRIVATE_S3_BUCKET / PRIVATE_S3_PREFIX.
const PUBLIC_S3_BUCKET = process.env.S3_BUCKET || ''
const S3_BUCKET = process.env.PRIVATE_S3_BUCKET || PUBLIC_S3_BUCKET
const S3_REGION = process.env.PRIVATE_S3_REGION || process.env.S3_REGION || 'us-east-1'
const S3_ENDPOINT = process.env.PRIVATE_S3_ENDPOINT || process.env.S3_ENDPOINT
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== 'false'
const S3_PREFIX = process.env.PRIVATE_S3_PREFIX || 'private-sites/'

/**
 * Refuse to start when private content would land in the public bucket without an explicit
 * operator acknowledgement. Failing loudly at boot is preferable to silently writing
 * private bytes into a possibly world-readable bucket.
 */
const assertPrivateBucketIsolated = (): void => {
	if (!S3_BUCKET) return
	const sharesPublicBucket = Boolean(PUBLIC_S3_BUCKET) && S3_BUCKET === PUBLIC_S3_BUCKET
	if (!sharesPublicBucket) return
	if (process.env.PRIVATE_ALLOW_SHARED_BUCKET === 'true') {
		logger.warn(
			'[PrivateStorage] Private content shares the public bucket. Ensure the prefix denies anonymous access.',
			{ bucket: S3_BUCKET, prefix: S3_PREFIX },
		)
		return
	}
	throw new Error(
		'Private sites would write into the public S3 bucket. Set PRIVATE_S3_BUCKET to a bucket with public access blocked, ' +
			'or set PRIVATE_ALLOW_SHARED_BUCKET=true after confirming the private prefix denies anonymous reads.',
	)
}

assertPrivateBucketIsolated()
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY

let coldTier: S3StorageTier | DiskStorageTier

if (S3_BUCKET) {
	coldTier = new S3StorageTier({
		bucket: S3_BUCKET,
		region: S3_REGION,
		endpoint: S3_ENDPOINT,
		credentials:
			AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
				? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
				: undefined,
		prefix: S3_PREFIX,
		forcePathStyle: S3_FORCE_PATH_STYLE,
	})
	logger.info('[PrivateStorage] Using S3 cold tier', { bucket: S3_BUCKET })
} else {
	const cacheDir = process.env.CACHE_DIR || './cache/sites'
	coldTier = new DiskStorageTier({
		directory: cacheDir,
		maxSizeBytes: 10 * 1024 * 1024 * 1024,
		evictionPolicy: 'lru',
		encodeColons: false,
	})
	logger.info('[PrivateStorage] Using disk fallback (no S3_BUCKET configured)', { cacheDir })
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

/** Write one private site file. */
export const writePrivateFile = async (
	siteId: string,
	filePath: string,
	data: Uint8Array,
	mimeType?: string,
): Promise<void> => {
	await privateStorage.set(buildPrivateStorageKey(siteId, filePath), data, {
		onlyTiers: ['cold'],
		metadata: mimeType ? { mimeType } : undefined,
	})
}

/** Read one private site file, or null when absent. */
export const readPrivateFile = async (siteId: string, filePath: string): Promise<Uint8Array | null> => {
	const result = await privateStorage.get(buildPrivateStorageKey(siteId, filePath))
	return result ?? null
}

/**
 * Delete every stored file for a private site.
 *
 * Enumerates by the site's own key prefix so nothing outside that namespace can be
 * removed, even if the caller passes an unexpected id.
 */
export const deletePrivateSiteFiles = async (siteId: string): Promise<number> => {
	const prefix = `${PRIVATE_STORAGE_PREFIX}/${siteId}/`
	const keys: string[] = []
	for await (const key of privateStorage.listKeys(prefix)) {
		if (key.startsWith(prefix)) keys.push(key)
	}
	await Promise.all(keys.map((key) => privateStorage.delete(key)))
	return keys.length
}
