import { Duplex, Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGunzip, createGzip, gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)

/**
 * Maximum uncompressed bytes accepted by the built-in gzip helpers.
 *
 * This matches Wisp's per-blob limit. Callers that handle a smaller payload can
 * pass their own lower limit to `decompress` or `createDecompressStream`.
 */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024

/** Raised when gzip output exceeds the caller's allowed size. */
export class DecompressionLimitError extends Error {
	readonly maxOutputBytes: number
	readonly outputBytes: number

	constructor(maxOutputBytes: number, outputBytes: number) {
		super(`Decompressed data exceeds the ${maxOutputBytes}-byte limit`)
		this.name = 'DecompressionLimitError'
		this.maxOutputBytes = maxOutputBytes
		this.outputBytes = outputBytes
	}
}

function assertValidOutputLimit(maxOutputBytes: number): void {
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) {
		throw new RangeError('maxOutputBytes must be a non-negative safe integer')
	}
}

/**
 * Count decompressed bytes while preserving stream backpressure. Returning an
 * error from this transform makes `pipeline` destroy the gzip source at the
 * first chunk that crosses the limit.
 */
function createOutputLimitTransform(maxOutputBytes: number): Transform {
	let outputBytes = 0

	return new Transform({
		transform(chunk, _encoding, callback) {
			const output = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			const nextOutputBytes = outputBytes + output.length
			if (nextOutputBytes > maxOutputBytes) {
				callback(new DecompressionLimitError(maxOutputBytes, nextOutputBytes))
				return
			}

			outputBytes = nextOutputBytes
			callback(null, output)
		},
	})
}

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
	const buffer = Buffer.from(data)
	const compressed = await gzipAsync(buffer)
	return new Uint8Array(compressed)
}

async function pipeGzip(data: Uint8Array, maxOutputBytes: number, destination: Writable): Promise<void> {
	if (!isGzipped(data)) {
		throw new Error('Invalid gzip data: missing magic bytes')
	}
	assertValidOutputLimit(maxOutputBytes)
	await pipeline(Readable.from([data]), createDecompressStream(maxOutputBytes), destination)
}

/**
 * Decompress gzip-compressed data without allowing unbounded output.
 *
 * @param data - Compressed data
 * @param maxOutputBytes - Maximum accepted decompressed size
 * @returns Decompressed data as a Buffer (a Uint8Array subclass)
 * @throws Error if data is not valid gzip format
 * @throws DecompressionLimitError if decompressed output exceeds `maxOutputBytes`
 *
 * @remarks
 * Automatically validates gzip magic bytes (0x1f 0x8b) before decompression.
 * Decompression runs through Node's streaming zlib implementation. The pipeline
 * is destroyed as soon as a chunk crosses the output cap, rather than buffering
 * the full decompressed payload first.
 *
 * @example
 * ```typescript
 * const decompressed = await decompress(compressedData, 10 * 1024 * 1024);
 * const text = new TextDecoder().decode(decompressed);
 * ```
 */

export async function decompress(
	data: Uint8Array,
	maxOutputBytes = DEFAULT_MAX_DECOMPRESSED_BYTES,
): Promise<Buffer<ArrayBuffer>> {
	const chunks: Buffer[] = []
	let outputBytes = 0
	const collector = new Writable({
		write(chunk, _encoding, callback) {
			const output = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			chunks.push(output)
			outputBytes += output.length
			callback()
		},
	})

	await pipeGzip(data, maxOutputBytes, collector)
	return Buffer.concat(chunks, outputBytes) as Buffer<ArrayBuffer>
}

/**
 * Count gzip output without retaining it.
 *
 * Use this when a caller needs to enforce a logical-size quota while keeping
 * the accepted gzip payload compressed in storage.
 */
export async function measureDecompressedSize(
	data: Uint8Array,
	maxOutputBytes = DEFAULT_MAX_DECOMPRESSED_BYTES,
): Promise<number> {
	let outputBytes = 0
	const counter = new Writable({
		write(chunk, _encoding, callback) {
			outputBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
			callback()
		},
	})

	await pipeGzip(data, maxOutputBytes, counter)
	return outputBytes
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
	return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b
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
	return createGzip()
}

/**
 * Create a bounded gzip decompression stream.
 *
 * @param maxOutputBytes - Maximum accepted decompressed size
 * @returns A duplex stream that decompresses data passing through it
 * @throws DecompressionLimitError if output exceeds `maxOutputBytes`
 *
 * @remarks
 * The output limiter is after zlib so it counts decompressed bytes. It destroys
 * the gzip stream at the first output chunk that crosses the cap.
 *
 * @example
 * ```typescript
 * const decompressStream = createDecompressStream(10 * 1024 * 1024);
 * compressedStream.pipe(decompressStream).pipe(destinationStream);
 * ```
 */
export function createDecompressStream(maxOutputBytes = DEFAULT_MAX_DECOMPRESSED_BYTES): Duplex {
	assertValidOutputLimit(maxOutputBytes)

	const gunzip = createGunzip()
	const outputLimit = createOutputLimitTransform(maxOutputBytes)
	gunzip.pipe(outputLimit)

	// Duplex.from accepts this Node stream pair at runtime. Its declaration is
	// narrower in newer @types/node releases, so preserve the cross-version type
	// through the generic readable-stream branch.
	gunzip.once('error', (error) => outputLimit.destroy(error))
	outputLimit.once('error', (error) => gunzip.destroy(error))
	return Duplex.from({ writable: gunzip, readable: outputLimit } as unknown as NodeJS.ReadWriteStream)
}
