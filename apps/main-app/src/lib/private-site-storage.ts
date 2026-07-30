import { createLogger } from '@wispplace/observability'
import { buildPrivateStorageKey, PRIVATE_STORAGE_PREFIX } from '@wispplace/private-sites'
import { DiskStorageTier, S3StorageTier, TieredStorage } from '@wispplace/tiered-storage'

const logger = createLogger('main-app')
const PUBLIC_S3_BUCKET = process.env.S3_BUCKET || ''
const S3_BUCKET = process.env.PRIVATE_S3_BUCKET || PUBLIC_S3_BUCKET
const S3_REGION = process.env.PRIVATE_S3_REGION || process.env.S3_REGION || 'us-east-1'
const S3_ENDPOINT = process.env.PRIVATE_S3_ENDPOINT || process.env.S3_ENDPOINT
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== 'false'
const S3_PREFIX = process.env.PRIVATE_S3_PREFIX || 'private-sites/'
// Public buckets may allow anonymous reads, which would bypass every application check.
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
export const deletePrivateSiteFiles = async (siteId: string): Promise<number> => {
	const prefix = `${PRIVATE_STORAGE_PREFIX}/${siteId}/`
	const keys: string[] = []
	for await (const key of privateStorage.listKeys(prefix)) {
		if (key.startsWith(prefix)) keys.push(key)
	}
	await Promise.all(keys.map((key) => privateStorage.delete(key)))
	return keys.length
}
