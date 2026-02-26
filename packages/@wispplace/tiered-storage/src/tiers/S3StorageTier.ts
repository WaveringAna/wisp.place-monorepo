import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	DeleteObjectsCommand,
	CopyObjectCommand,
	type GetObjectCommandOutput,
	type HeadObjectCommandOutput,
	type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';
import { lookup as mimeLookup } from 'mime-types';
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


}

/**
 * AWS S3 (or compatible) storage tier.
 *
 * @remarks
 * - Supports AWS S3, Cloudflare R2, MinIO, Hetzner Object Storage, and other S3-compatible services
 * - Metadata is stored inline as S3 object metadata headers (x-amz-meta-*)
 * - Single request per read/write — no separate metadata objects
 * - Requires `@aws-sdk/client-s3` peer dependency
 * - Typically used as the cold tier (source of truth)
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
	 * Metadata is read from S3 object metadata headers (x-amz-meta-*),
	 * returned in a single request alongside the file body.
	 */
	async getWithMetadata(key: string): Promise<TierGetResult | null> {
		const s3Key = this.getS3Key(key);

		try {
			const response = await this.client.send(
				new GetObjectCommand({
					Bucket: this.config.bucket,
					Key: s3Key,
				}),
			);

			if (!response.Body) {
				return null;
			}

			const rawData = await this.streamToUint8Array(response.Body as Readable);
			const { data, metadata } = response.Metadata
				? { data: rawData, metadata: this.s3ToMetadata(response.Metadata) }
				: this.recoverDataAndMetadataFromObject(key, rawData, response);

			return { data, metadata };
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
			const response = await this.client.send(
				new GetObjectCommand({
					Bucket: this.config.bucket,
					Key: s3Key,
				}),
			);

			if (!response.Body) {
				return null;
			}

			const metadata = response.Metadata
				? this.s3ToMetadata(response.Metadata)
				: this.metadataFromObjectResponse(key, response.ContentLength, response);

			return { stream: response.Body as Readable, metadata };
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
		const upload = new Upload({
			client: this.client,
			params: {
				Bucket: this.config.bucket,
				Key: this.getS3Key(key),
				Body: stream as Readable,
				Metadata: this.metadataToS3(metadata),
			},
		});

		await upload.done();
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
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.config.bucket,
				Key: this.getS3Key(key),
				Body: data,
				ContentLength: data.byteLength,
				Metadata: this.metadataToS3(metadata),
			}),
		);
	}

	async delete(key: string): Promise<void> {
		try {
			await this.client.send(
				new DeleteObjectCommand({
					Bucket: this.config.bucket,
					Key: this.getS3Key(key),
				}),
			);
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

			await this.client.send(
				new DeleteObjectsCommand({
					Bucket: this.config.bucket,
					Delete: {
						Objects: batch.map((key) => ({ Key: this.getS3Key(key) })),
					},
				}),
			);
		}
	}

	async getMetadata(key: string): Promise<StorageMetadata | null> {
		try {
			const response = await this.client.send(
				new HeadObjectCommand({
					Bucket: this.config.bucket,
					Key: this.getS3Key(key),
				}),
			);

			return response.Metadata
				? this.s3ToMetadata(response.Metadata)
				: this.metadataFromObjectResponse(key, response.ContentLength, response);
		} catch (error) {
			if (this.isNoSuchKeyError(error)) {
				return null;
			}
			throw error;
		}
	}

	async setMetadata(key: string, metadata: StorageMetadata): Promise<void> {
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
	 * Build conservative metadata when object metadata headers are missing.
	 */
	private metadataFromObjectResponse(
		key: string,
		size: number | undefined,
		response: GetObjectCommandOutput | HeadObjectCommandOutput,
		inferred?: { mimeType?: string; encoding?: string },
	): StorageMetadata {
		const now = new Date();
		const customMetadata: Record<string, string> = {};

		const mimeType = inferred?.mimeType ?? this.normalizeContentType(response.ContentType);
		if (mimeType) {
			customMetadata.mimeType = mimeType;
		}
		const encoding = inferred?.encoding ?? response.ContentEncoding;
		if (encoding) {
			customMetadata.encoding = encoding;
		}

		const rawChecksum = typeof response.ETag === 'string' ? response.ETag.replace(/"/g, '') : '';

		return {
			key,
			size: Math.max(0, size ?? 0),
			createdAt: now,
			lastAccessed: now,
			accessCount: 0,
			compressed: false,
			checksum: rawChecksum,
			...(Object.keys(customMetadata).length > 0 && { customMetadata }),
		};
	}

	/**
	 * Recover legacy/partial objects when S3 metadata headers are absent.
	 * Mirrors firehose heuristics: base64 decode for text-like files and gzip detection.
	 */
	private recoverDataAndMetadataFromObject(
		key: string,
		data: Uint8Array,
		response: GetObjectCommandOutput,
	): { data: Uint8Array; metadata: StorageMetadata } {
		const mimeType = this.normalizeContentType(response.ContentType) ?? this.mimeTypeFromKey(key);
		let recovered = data;
		let inferredEncoding: string | undefined;

		if (this.isTextLikeMime(mimeType, key)) {
			const decoded = this.tryDecodeBase64(recovered);
			if (decoded) {
				recovered = decoded;
			}
		}

		if (!inferredEncoding && this.shouldDetectGzip(mimeType, key) && this.isGzip(recovered)) {
			inferredEncoding = 'gzip';
		}

		const metadata = this.metadataFromObjectResponse(key, recovered.length, response, {
			...(mimeType ? { mimeType } : {}),
			...(inferredEncoding ? { encoding: inferredEncoding } : {}),
		});
		return { data: recovered, metadata };
	}

	private normalizeContentType(contentType?: string): string | undefined {
		if (!contentType) return undefined;
		return contentType.split(';')[0]?.trim() || undefined;
	}

	private mimeTypeFromKey(key: string): string | undefined {
		const guessed = mimeLookup(key);
		return typeof guessed === 'string' ? guessed : undefined;
	}

	private shouldDetectGzip(mimeType?: string, key?: string): boolean {
		if (mimeType) {
			if (mimeType.startsWith('text/')) return true;
			if (mimeType === 'application/javascript') return true;
			if (mimeType === 'application/json') return true;
			if (mimeType === 'application/xml') return true;
			if (mimeType === 'image/svg+xml') return true;
		}
		if (!key) return false;
		const lower = key.toLowerCase();
		return (
			lower.endsWith('.html') ||
			lower.endsWith('.htm') ||
			lower.endsWith('.css') ||
			lower.endsWith('.js') ||
			lower.endsWith('.json') ||
			lower.endsWith('.xml') ||
			lower.endsWith('.svg')
		);
	}

	private isTextLikeMime(mimeType?: string, key?: string): boolean {
		return this.shouldDetectGzip(mimeType, key);
	}

	private isGzip(content: Uint8Array): boolean {
		return content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
	}

	private looksLikeBase64(content: Uint8Array): boolean {
		if (content.length === 0) return false;
		let nonWhitespace = 0;
		for (const byte of content) {
			if (byte === 0x0a || byte === 0x0d || byte === 0x20 || byte === 0x09) {
				continue;
			}
			nonWhitespace++;
			const isBase64Char =
				(byte >= 0x41 && byte <= 0x5a) || // A-Z
				(byte >= 0x61 && byte <= 0x7a) || // a-z
				(byte >= 0x30 && byte <= 0x39) || // 0-9
				byte === 0x2b || // +
				byte === 0x2f || // /
				byte === 0x3d; // =
			if (!isBase64Char) return false;
		}
		return nonWhitespace % 4 === 0;
	}

	private tryDecodeBase64(content: Uint8Array): Uint8Array | null {
		if (!this.looksLikeBase64(content)) return null;
		const base64String = new TextDecoder().decode(content).replace(/\s+/g, '');
		try {
			return Buffer.from(base64String, 'base64');
		} catch {
			return null;
		}
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
