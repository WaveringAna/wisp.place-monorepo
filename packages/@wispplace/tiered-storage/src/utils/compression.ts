import { gzip, gunzip, createGzip, createGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { Transform } from 'node:stream';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Compress data using gzip.
 *
 * @param data - Data to compress
 * @returns Compressed data as Uint8Array
 *
 * @remarks
 * Uses Node.js zlib with default compression level (6).
 * Compression is transparent to the user - data is automatically decompressed on retrieval.
 *
 * @example
 * ```typescript
 * const original = new TextEncoder().encode('Hello, world!');
 * const compressed = await compress(original);
 * console.log(`Compressed from ${original.length} to ${compressed.length} bytes`);
 * ```
 */
export async function compress(data: Uint8Array): Promise<Uint8Array> {
	const buffer = Buffer.from(data);
	const compressed = await gzipAsync(buffer);
	return new Uint8Array(compressed);
}

/**
 * Decompress gzip-compressed data.
 *
 * @param data - Compressed data
 * @returns Decompressed data as Uint8Array
 * @throws Error if data is not valid gzip format
 *
 * @remarks
 * Automatically validates gzip magic bytes (0x1f 0x8b) before decompression.
 *
 * @example
 * ```typescript
 * const decompressed = await decompress(compressedData);
 * const text = new TextDecoder().decode(decompressed);
 * ```
 */
export async function decompress(data: Uint8Array): Promise<Uint8Array> {
	// Validate gzip magic bytes
	if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) {
		throw new Error('Invalid gzip data: missing magic bytes');
	}

	const buffer = Buffer.from(data);
	const decompressed = await gunzipAsync(buffer);
	return new Uint8Array(decompressed);
}

/**
 * Check if data appears to be gzip-compressed by inspecting magic bytes.
 *
 * @param data - Data to check
 * @returns true if data starts with gzip magic bytes (0x1f 0x8b)
 *
 * @remarks
 * This is a quick check that doesn't decompress the data.
 * Useful for detecting already-compressed data to avoid double compression.
 *
 * @example
 * ```typescript
 * if (isGzipped(data)) {
 *	 console.log('Already compressed, skipping compression');
 * } else {
 *	 data = await compress(data);
 * }
 * ```
 */
export function isGzipped(data: Uint8Array): boolean {
	return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Create a gzip compression transform stream.
 *
 * @returns A transform stream that compresses data passing through it
 *
 * @remarks
 * Use this for streaming compression of large files.
 * Pipe data through this stream to compress it on-the-fly.
 *
 * @example
 * ```typescript
 * const compressStream = createCompressStream();
 * sourceStream.pipe(compressStream).pipe(destinationStream);
 * ```
 */
export function createCompressStream(): Transform {
	return createGzip();
}

/**
 * Create a gzip decompression transform stream.
 *
 * @returns A transform stream that decompresses data passing through it
 *
 * @remarks
 * Use this for streaming decompression of large files.
 * Pipe compressed data through this stream to decompress it on-the-fly.
 *
 * @example
 * ```typescript
 * const decompressStream = createDecompressStream();
 * compressedStream.pipe(decompressStream).pipe(destinationStream);
 * ```
 */
export function createDecompressStream(): Transform {
	return createGunzip();
}
