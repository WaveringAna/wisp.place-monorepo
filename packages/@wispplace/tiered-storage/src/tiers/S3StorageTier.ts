import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	DeleteObjectsCommand,
	CopyObjectCommand,
	type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';
import type {
	StorageTier,
	StorageMetadata,
	TierStats,
	TierGetResult,
	TierStreamResult,
} from '../types/index.js';

/**
 * Configuration for S3StorageTier.
 */
export interface S3StorageTierConfig {
	/**
	 * S3 bucket name.
	 */
	bucket: string;

	/**
	 * AWS region.
	 */
	region: string;

	/**
	 * Optional S3-compatible endpoint (for R2, Minio, etc.).
	 *
	 * @example 'https://s3.us-east-1.amazonaws.com'
	 * @example 'https://account-id.r2.cloudflarestorage.com'
	 */
	endpoint?: string;

	/**
	 * Optional AWS credentials.
	 *
	 * @remarks
	 * If not provided, uses the default AWS credential chain
	 * (environment variables, ~/.aws/credentials, IAM roles, etc.)
	 */
	credentials?: {
		accessKeyId: string;
		secretAccessKey: string;
	};

	/**
	 * Optional key prefix for namespacing.
	 *
	 * @remarks
	 * All keys will be prefixed with this value.
	 * Useful for multi-tenant scenarios or organizing data.
	 *
	 * @example 'tiered-storage/'
	 */
	prefix?: string;

	/**
	 * Force path-style addressing for S3-compatible services.
	 *
	 * @defaultValue true
	 *
	 * @remarks
	 * Most S3-compatible services (MinIO, R2, etc.) require path-style URLs.
	 * AWS S3 uses virtual-hosted-style by default, but path-style also works.
	 *
	 * - true: `https://endpoint.com/bucket/key` (path-style)
	 * - false: `https://bucket.endpoint.com/key` (virtual-hosted-style)
	 */
	forcePathStyle?: boolean;

	/**
	 * Optional separate bucket for storing metadata.
	 *
	 * @remarks
	 * **RECOMMENDED for production use!**
	 *
	 * By default, metadata is stored in S3 object metadata fields. However, updating
	 * metadata requires copying the entire object, which is slow and expensive for large files.
	 *
	 * When `metadataBucket` is specified, metadata is stored as separate JSON objects
	 * in this bucket. This allows fast, cheap metadata updates without copying data.
	 *
	 * **Benefits:**
	 * - Fast metadata updates (no object copying)
	 * - Much cheaper for large objects
	 * - No impact on data object performance
	 *
	 * **Trade-offs:**
	 * - Requires managing two buckets
	 * - Metadata and data could become out of sync if not handled carefully
	 * - Additional S3 API calls for metadata operations
	 *
	 * @example
	 * ```typescript
	 * const tier = new S3StorageTier({
	 *	 bucket: 'my-data-bucket',
	 *	 metadataBucket: 'my-metadata-bucket', // Separate bucket for metadata
	 *	 region: 'us-east-1',
	 * });
	 * ```
	 */
	metadataBucket?: string;
}

/**
 * AWS S3 (or compatible) storage tier.
 *
 * @remarks
 * - Supports AWS S3, Cloudflare R2, MinIO, and other S3-compatible services
 * - Uses object metadata for StorageMetadata
 * - Requires `@aws-sdk/client-s3` peer dependency
 * - Typically used as the cold tier (source of truth)
 *
 * **Metadata Storage:**
 * Metadata is stored in S3 object metadata fields:
 * - Custom metadata fields are prefixed with `x-amz-meta-`
 * - Built-in fields use standard S3 headers
 *
 * @example
 * ```typescript
 * const tier = new S3StorageTier({
 *	 bucket: 'my-bucket',
 *	 region: 'us-east-1',
 *	 credentials: {
 *		 accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
 *		 secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 *	 },
 *	 prefix: 'cache/',
 * });
 * ```
 *
 * @example Cloudflare R2
 * ```typescript
 * const tier = new S3StorageTier({
 *	 bucket: 'my-bucket',
 *	 region: 'auto',
 *	 endpoint: 'https://account-id.r2.cloudflarestorage.com',
 *	 credentials: {
 *		 accessKeyId: process.env.R2_ACCESS_KEY_ID!,
 *		 secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
 *	 },
 * });
 * ```
 */
export class S3StorageTier implements StorageTier {
	private client: S3Client;
	private prefix: string;
	private metadataBucket?: string;

	constructor(private config: S3StorageTierConfig) {
		const clientConfig: S3ClientConfig = {
			region: config.region,
			// Most S3-compatible services need path-style URLs
			forcePathStyle: config.forcePathStyle ?? true,
			...(config.endpoint && { endpoint: config.endpoint }),
			...(config.credentials && { credentials: config.credentials }),
		};

		this.client = new S3Client(clientConfig);
		this.prefix = config.prefix ?? '';
		if (config.metadataBucket) {
			this.metadataBucket = config.metadataBucket;
		}
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			const command = new GetObjectCommand({
				Bucket: this.config.bucket,
				Key: this.getS3Key(key),
			});

			const response = await this.client.send(command);

			if (!response.Body) {
				return null;
			}

			return await this.streamToUint8Array(response.Body as Readable);
		} catch (error) {
			if (this.isNoSuchKeyError(error)) {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Retrieve data and metadata together in a single operation.
	 *
	 * @param key - The key to retrieve
	 * @returns The data and metadata, or null if not found
	 *
	 * @remarks
	 * When using a separate metadata bucket, fetches data and metadata in parallel.
	 * Otherwise, uses the data object's embedded metadata.
	 */
	async getWithMetadata(key: string): Promise<TierGetResult | null> {
		const s3Key = this.getS3Key(key);

		try {
			if (this.metadataBucket) {
				// Fetch data and metadata in parallel
				const [dataResponse, metadataResponse] = await Promise.all([
					this.client.send(
						new GetObjectCommand({
							Bucket: this.config.bucket,
							Key: s3Key,
						}),
					),
					this.client.send(
						new GetObjectCommand({
							Bucket: this.metadataBucket,
							Key: s3Key + '.meta',
						}),
					),
				]);

				if (!dataResponse.Body || !metadataResponse.Body) {
					return null;
				}

				const [data, metaBuffer] = await Promise.all([
					this.streamToUint8Array(dataResponse.Body as Readable),
					this.streamToUint8Array(metadataResponse.Body as Readable),
				]);

				const json = new TextDecoder().decode(metaBuffer);
				let metadata: StorageMetadata;
				try {
					metadata = JSON.parse(json) as StorageMetadata;
				} catch {
					// Corrupted or partial .meta file — return null so the caller
					// falls through to on-demand fetch rather than serving bad data.
					return null;
				}
				metadata.createdAt = new Date(metadata.createdAt);
				metadata.lastAccessed = new Date(metadata.lastAccessed);
				if (metadata.ttl) {
					metadata.ttl = new Date(metadata.ttl);
				}

				return { data, metadata };
			} else {
				// Get data with embedded metadata from response headers
				const response = await this.client.send(
					new GetObjectCommand({
						Bucket: this.config.bucket,
						Key: s3Key,
					}),
				);

				if (!response.Body || !response.Metadata) {
					return null;
				}

				const data = await this.streamToUint8Array(response.Body as Readable);
				const metadata = this.s3ToMetadata(response.Metadata);

				return { data, metadata };
			}
		} catch (error) {
			if (this.isNoSuchKeyError(error)) {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Retrieve data as a readable stream with metadata.
	 *
	 * @param key - The key to retrieve
	 * @returns A readable stream and metadata, or null if not found
	 *
	 * @remarks
	 * Use this for large files to avoid loading entire content into memory.
	 * The stream must be consumed or destroyed by the caller.
	 */
	async getStream(key: string): Promise<TierStreamResult | null> {
		const s3Key = this.getS3Key(key);

		try {
			if (this.metadataBucket) {
				// Fetch data stream and metadata in parallel
				const [dataResponse, metadataResponse] = await Promise.all([
					this.client.send(
						new GetObjectCommand({
							Bucket: this.config.bucket,
							Key: s3Key,
						}),
					),
					this.client.send(
						new GetObjectCommand({
							Bucket: this.metadataBucket,
							Key: s3Key + '.meta',
						}),
					),
				]);

				if (!dataResponse.Body || !metadataResponse.Body) {
					return null;
				}

				// Only buffer the small metadata, stream the data
				const metaBuffer = await this.streamToUint8Array(metadataResponse.Body as Readable);
				const json = new TextDecoder().decode(metaBuffer);
				const metadata = JSON.parse(json) as StorageMetadata;
				metadata.createdAt = new Date(metadata.createdAt);
				metadata.lastAccessed = new Date(metadata.lastAccessed);
				if (metadata.ttl) {
					metadata.ttl = new Date(metadata.ttl);
				}

				return { stream: dataResponse.Body as Readable, metadata };
			} else {
				// Get data stream with embedded metadata from response headers
				const response = await this.client.send(
					new GetObjectCommand({
						Bucket: this.config.bucket,
						Key: s3Key,
					}),
				);

				if (!response.Body || !response.Metadata) {
					return null;
				}

				const metadata = this.s3ToMetadata(response.Metadata);

				return { stream: response.Body as Readable, metadata };
			}
		} catch (error) {
			if (this.isNoSuchKeyError(error)) {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Store data from a readable stream.
	 *
	 * @param key - The key to store under
	 * @param stream - Readable stream of data to store
	 * @param metadata - Metadata to store alongside the data
	 *
	 * @remarks
	 * Uses multipart upload for efficient streaming of large files.
	 * The stream will be fully consumed by this operation.
	 */
	async setStream(
		key: string,
		stream: NodeJS.ReadableStream,
		metadata: StorageMetadata,
	): Promise<void> {
		const s3Key = this.getS3Key(key);

		if (this.metadataBucket) {
			// Use multipart upload for streaming data
			const upload = new Upload({
				client: this.client,
				params: {
					Bucket: this.config.bucket,
					Key: s3Key,
					Body: stream as Readable,
				},
			});

			const metadataJson = JSON.stringify(metadata);
			const metadataBuffer = new TextEncoder().encode(metadataJson);
			const metadataCommand = new PutObjectCommand({
				Bucket: this.metadataBucket,
				Key: s3Key + '.meta',
				Body: metadataBuffer,
				ContentType: 'application/json',
			});

			await Promise.all([upload.done(), this.client.send(metadataCommand)]);
		} else {
			// Use multipart upload with embedded metadata
			const upload = new Upload({
				client: this.client,
				params: {
					Bucket: this.config.bucket,
					Key: s3Key,
					Body: stream as Readable,
					Metadata: this.metadataToS3(metadata),
				},
			});

			await upload.done();
		}
	}

	private async streamToUint8Array(stream: Readable): Promise<Uint8Array> {
		const chunks: Uint8Array[] = [];

		for await (const chunk of stream) {
			if (Buffer.isBuffer(chunk)) {
				chunks.push(new Uint8Array(chunk));
			} else if (chunk instanceof Uint8Array) {
				chunks.push(chunk);
			} else {
				throw new Error('Unexpected chunk type in S3 stream');
			}
		}

		const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
		const result = new Uint8Array(totalLength);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}

		return result;
	}

	private isNoSuchKeyError(error: unknown): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'name' in error &&
			(error.name === 'NoSuchKey' || error.name === 'NotFound')
		);
	}

	async set(key: string, data: Uint8Array, metadata: StorageMetadata): Promise<void> {
		const s3Key = this.getS3Key(key);

		if (this.metadataBucket) {
			const dataCommand = new PutObjectCommand({
				Bucket: this.config.bucket,
				Key: s3Key,
				Body: data,
				ContentLength: data.byteLength,
			});

			const metadataJson = JSON.stringify(metadata);
			const metadataBuffer = new TextEncoder().encode(metadataJson);
			const metadataCommand = new PutObjectCommand({
				Bucket: this.metadataBucket,
				Key: s3Key + '.meta',
				Body: metadataBuffer,
				ContentType: 'application/json',
			});

			await Promise.all([this.client.send(dataCommand), this.client.send(metadataCommand)]);
		} else {
			const command = new PutObjectCommand({
				Bucket: this.config.bucket,
				Key: s3Key,
				Body: data,
				ContentLength: data.byteLength,
				Metadata: this.metadataToS3(metadata),
			});

			await this.client.send(command);
		}
	}

	async delete(key: string): Promise<void> {
		const s3Key = this.getS3Key(key);

		try {
			const dataCommand = new DeleteObjectCommand({
				Bucket: this.config.bucket,
				Key: s3Key,
			});

			if (this.metadataBucket) {
				const metadataCommand = new DeleteObjectCommand({
					Bucket: this.metadataBucket,
					Key: s3Key + '.meta',
				});

				await Promise.all([
					this.client.send(dataCommand),
					this.client.send(metadataCommand).catch((error) => {
						if (!this.isNoSuchKeyError(error)) throw error;
					}),
				]);
			} else {
				await this.client.send(dataCommand);
			}
		} catch (error) {
			if (!this.isNoSuchKeyError(error)) {
				throw error;
			}
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			const command = new HeadObjectCommand({
				Bucket: this.config.bucket,
				Key: this.getS3Key(key),
			});

			await this.client.send(command);
			return true;
		} catch (error) {
			if (this.isNoSuchKeyError(error)) {
				return false;
			}
			throw error;
		}
	}

	async *listKeys(prefix?: string): AsyncIterableIterator<string> {
		const s3Prefix = prefix ? this.getS3Key(prefix) : this.prefix;
		let continuationToken: string | undefined;

		do {
			const command = new ListObjectsV2Command({
				Bucket: this.config.bucket,
				Prefix: s3Prefix,
				ContinuationToken: continuationToken,
			});

			const response = await this.client.send(command);

			if (response.Contents) {
				for (const object of response.Contents) {
					if (object.Key) {
						// Remove prefix to get original key
						const key = this.removePrefix(object.Key);
						yield key;
					}
				}
			}

			continuationToken = response.NextContinuationToken;
		} while (continuationToken);
	}

	async deleteMany(keys: string[]): Promise<void> {
		if (keys.length === 0) return;

		const batchSize = 1000;

		for (let i = 0; i < keys.length; i += batchSize) {
			const batch = keys.slice(i, i + batchSize);

			const dataCommand = new DeleteObjectsCommand({
				Bucket: this.config.bucket,
				Delete: {
					Objects: batch.map((key) => ({ Key: this.getS3Key(key) })),
				},
			});

			if (this.metadataBucket) {
				const metadataCommand = new DeleteObjectsCommand({
					Bucket: this.metadataBucket,
					Delete: {
						Objects: batch.map((key) => ({ Key: this.getS3Key(key) + '.meta' })),
					},
				});

				await Promise.all([
					this.client.send(dataCommand),
					this.client.send(metadataCommand).catch(() => {}),
				]);
			} else {
				await this.client.send(dataCommand);
			}
		}
	}

	async getMetadata(key: string): Promise<StorageMetadata | null> {
		if (this.metadataBucket) {
			try {
				const command = new GetObjectCommand({
					Bucket: this.metadataBucket,
					Key: this.getS3Key(key) + '.meta',
				});

				const response = await this.client.send(command);

				if (!response.Body) {
					return null;
				}

				const buffer = await this.streamToUint8Array(response.Body as Readable);
				const json = new TextDecoder().decode(buffer);
				let metadata: StorageMetadata;
				try {
					metadata = JSON.parse(json) as StorageMetadata;
				} catch {
					return null;
				}

				metadata.createdAt = new Date(metadata.createdAt);
				metadata.lastAccessed = new Date(metadata.lastAccessed);
				if (metadata.ttl) {
					metadata.ttl = new Date(metadata.ttl);
				}

				return metadata;
			} catch (error) {
				if (this.isNoSuchKeyError(error)) {
					return null;
				}
				throw error;
			}
		}

		try {
			const command = new HeadObjectCommand({
				Bucket: this.config.bucket,
				Key: this.getS3Key(key),
			});

			const response = await this.client.send(command);

			if (!response.Metadata) {
				return null;
			}

			return this.s3ToMetadata(response.Metadata);
		} catch (error) {
			if (this.isNoSuchKeyError(error)) {
				return null;
			}
			throw error;
		}
	}

	async setMetadata(key: string, metadata: StorageMetadata): Promise<void> {
		if (this.metadataBucket) {
			const metadataJson = JSON.stringify(metadata);
			const buffer = new TextEncoder().encode(metadataJson);

			const command = new PutObjectCommand({
				Bucket: this.metadataBucket,
				Key: this.getS3Key(key) + '.meta',
				Body: buffer,
				ContentType: 'application/json',
			});

			await this.client.send(command);
			return;
		}

		const s3Key = this.getS3Key(key);
		const command = new CopyObjectCommand({
			Bucket: this.config.bucket,
			Key: s3Key,
			CopySource: `${this.config.bucket}/${s3Key}`,
			Metadata: this.metadataToS3(metadata),
			MetadataDirective: 'REPLACE',
		});

		await this.client.send(command);
	}

	async getStats(): Promise<TierStats> {
		let bytes = 0;
		let items = 0;

		// List all objects and sum up sizes
		let continuationToken: string | undefined;

		do {
			const command = new ListObjectsV2Command({
				Bucket: this.config.bucket,
				Prefix: this.prefix,
				ContinuationToken: continuationToken,
			});

			const response = await this.client.send(command);

			if (response.Contents) {
				for (const object of response.Contents) {
					items++;
					bytes += object.Size ?? 0;
				}
			}

			continuationToken = response.NextContinuationToken;
		} while (continuationToken);

		return { bytes, items };
	}

	async clear(): Promise<void> {
		// List and delete all objects with the prefix
		const keys: string[] = [];

		for await (const key of this.listKeys()) {
			keys.push(key);
		}

		await this.deleteMany(keys);
	}

	/**
	 * Get the full S3 key including prefix.
	 */
	private getS3Key(key: string): string {
		return this.prefix + key;
	}

	/**
	 * Remove the prefix from an S3 key to get the original key.
	 */
	private removePrefix(s3Key: string): string {
		if (this.prefix && s3Key.startsWith(this.prefix)) {
			return s3Key.slice(this.prefix.length);
		}
		return s3Key;
	}

	/**
	 * Convert StorageMetadata to S3 metadata format.
	 *
	 * @remarks
	 * S3 metadata keys must be lowercase and values must be strings.
	 * We serialize complex values as JSON.
	 */
	private metadataToS3(metadata: StorageMetadata): Record<string, string> {
		return {
			key: metadata.key,
			size: metadata.size.toString(),
			createdat: metadata.createdAt.toISOString(),
			lastaccessed: metadata.lastAccessed.toISOString(),
			accesscount: metadata.accessCount.toString(),
			compressed: metadata.compressed.toString(),
			checksum: metadata.checksum,
			...(metadata.ttl && { ttl: metadata.ttl.toISOString() }),
			...(metadata.mimeType && { mimetype: metadata.mimeType }),
			...(metadata.encoding && { encoding: metadata.encoding }),
			...(metadata.customMetadata && { custom: JSON.stringify(metadata.customMetadata) }),
		};
	}

	/**
	 * Convert S3 metadata to StorageMetadata format.
	 */
	private s3ToMetadata(s3Metadata: Record<string, string>): StorageMetadata {
		const metadata: StorageMetadata = {
			key: s3Metadata.key ?? '',
			size: parseInt(s3Metadata.size ?? '0', 10),
			createdAt: new Date(s3Metadata.createdat ?? Date.now()),
			lastAccessed: new Date(s3Metadata.lastaccessed ?? Date.now()),
			accessCount: parseInt(s3Metadata.accesscount ?? '0', 10),
			compressed: s3Metadata.compressed === 'true',
			checksum: s3Metadata.checksum ?? '',
		};

		if (s3Metadata.ttl) {
			metadata.ttl = new Date(s3Metadata.ttl);
		}

		if (s3Metadata.mimetype) {
			metadata.mimeType = s3Metadata.mimetype;
		}

		if (s3Metadata.encoding) {
			metadata.encoding = s3Metadata.encoding;
		}

		if (s3Metadata.custom) {
			try {
				const parsed: unknown = JSON.parse(s3Metadata.custom);
				// Validate it's a Record<string, string>
				if (
					parsed &&
					typeof parsed === 'object' &&
					!Array.isArray(parsed) &&
					Object.values(parsed).every((v) => typeof v === 'string')
				) {
					metadata.customMetadata = parsed as Record<string, string>;
				}
			} catch {
				// Ignore invalid JSON
			}
		}

		return metadata;
	}
}
