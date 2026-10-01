import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { computeCIDFromDigest } from '@wispplace/atproto-utils'
import { MAX_BLOB_SIZE } from '@wispplace/constants'
import { createDecompressStream, type StreamResult } from '@wispplace/tiered-storage'

const STREAM_CHUNK_BYTES = 64 * 1024
const SOURCE_CLEANUP = Symbol('sourceCleanup')
type SourceCleanupReadable = Readable & { [SOURCE_CLEANUP]?: () => void | Promise<void> }

export class FileStreamIntegrityError extends Error {
	constructor() {
		super('Stored file source CID does not match the manifest')
		this.name = 'FileStreamIntegrityError'
	}
}

function checkAborted(signal?: AbortSignal): void {
	signal?.throwIfAborted()
}

export function disposeFileStream(stream: NodeJS.ReadableStream): void {
	void disposeFileStreamAndWait(stream).catch(() => undefined)
}

export async function disposeFileStreamAndWait(stream: NodeJS.ReadableStream): Promise<void> {
	const readable = stream as SourceCleanupReadable
	readable.destroy()
	await readable[SOURCE_CLEANUP]?.()
}

export function bufferResponseBody(data: Uint8Array): ReadableStream<Uint8Array> {
	function* chunks() {
		for (let offset = 0; offset < data.byteLength; offset += STREAM_CHUNK_BYTES) {
			yield data.subarray(offset, offset + STREAM_CHUNK_BYTES)
		}
	}
	return getStreamResponseBody(Readable.from(chunks(), { objectMode: false }))
}

export function getStreamResponseBody(stream: NodeJS.ReadableStream, signal?: AbortSignal): ReadableStream<Uint8Array> {
	const source = stream as Readable
	const iterator = source[Symbol.asyncIterator]()
	let finished = false
	let abort: () => void
	const release = async () => {
		signal?.removeEventListener('abort', abort)
		source.destroy()
		await iterator.return?.().catch(() => undefined)
	}
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				abort = () => {
					if (finished) return
					finished = true
					controller.error(new DOMException('Request aborted', 'AbortError'))
					void release()
				}
				signal?.addEventListener('abort', abort, { once: true })
				if (signal?.aborted) abort()
			},
			async pull(controller) {
				try {
					const next = await iterator.next()
					if (finished) return
					if (next.done) {
						finished = true
						controller.close()
						await release()
						return
					}
					if (!(next.value instanceof Uint8Array)) throw new TypeError('Expected a binary file stream')
					controller.enqueue(next.value)
				} catch (error) {
					if (!finished) {
						finished = true
						controller.error(error)
						await release()
					}
				}
			},
			async cancel() {
				finished = true
				await release()
			},
		},
		{ highWaterMark: STREAM_CHUNK_BYTES, size: (chunk) => chunk?.byteLength ?? 0 },
	)
}

export async function peekFileStream(result: StreamResult): Promise<{ result: StreamResult; prefix: Uint8Array }> {
	const source = result.stream as Readable
	const iterator = source[Symbol.asyncIterator]()
	const head: Uint8Array[] = []
	let prefixSize = 0
	try {
		while (prefixSize < 2) {
			const next = await iterator.next()
			if (next.done) break
			if (!(next.value instanceof Uint8Array)) throw new TypeError('Expected a binary file stream')
			if (next.value.byteLength === 0) continue
			head.push(next.value)
			prefixSize += next.value.byteLength
		}
	} catch (error) {
		source.destroy()
		throw error
	}
	let sourceCleanup: Promise<void> | undefined
	const cleanupSource = () => {
		if (!sourceCleanup) {
			source.destroy()
			sourceCleanup = (async () => {
				await iterator.return?.().catch(() => undefined)
				await disposeFileStreamAndWait(source)
			})()
		}
		return sourceCleanup
	}
	async function* chunks() {
		try {
			yield* head
			for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value
		} finally {
			await cleanupSource()
		}
	}
	const replay = Readable.from(chunks(), {
		objectMode: false,
		highWaterMark: STREAM_CHUNK_BYTES,
	}) as SourceCleanupReadable
	replay[SOURCE_CLEANUP] = cleanupSource
	replay.once('close', () => void cleanupSource().catch(() => undefined))
	const first = head[0]
	const prefix =
		first && first.byteLength >= 2 ? first.subarray(0, 2) : new Uint8Array(head.map((chunk) => chunk[0] ?? 0))
	return { result: { ...result, stream: replay }, prefix }
}

interface SpoolFile {
	path: string
	size: number
	cleanup(): Promise<void>
}

async function writeSpool(
	result: StreamResult,
	options: { expectedCid?: string; decodeGzip?: boolean; signal?: AbortSignal } = {},
): Promise<SpoolFile> {
	const source = result.stream as Readable
	let directory: string | undefined
	try {
		checkAborted(options.signal)
		// Replay must live on the disk cache volume: /tmp may be memory-backed.
		const root = resolve(process.env.CACHE_DIR || './cache/sites', '..', '.streams')
		await mkdir(root, { recursive: true, mode: 0o700 })
		directory = await mkdtemp(join(root, 'file-'))
		const path = join(directory, 'body')
		let size = 0
		const hash = options.expectedCid ? createHash('sha256') : undefined
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				size += chunk.byteLength
				if (options.expectedCid && size > MAX_BLOB_SIZE) {
					callback(new FileStreamIntegrityError())
					return
				}
				hash?.update(chunk)
				callback(null, chunk)
			},
		})
		const writer = createWriteStream(path, { flags: 'wx', mode: 0o600 })
		if (options.decodeGzip) {
			await pipeline(source, createDecompressStream(MAX_BLOB_SIZE), meter, writer, { signal: options.signal })
		} else {
			await pipeline(source, meter, writer, { signal: options.signal })
		}
		if (hash && computeCIDFromDigest(hash.digest()) !== options.expectedCid) throw new FileStreamIntegrityError()
		checkAborted(options.signal)
		const ownedDirectory = directory
		return { path, size, cleanup: () => rm(ownedDirectory, { recursive: true, force: true }) }
	} catch (error) {
		source.destroy()
		if (directory) await rm(directory, { recursive: true, force: true })
		throw error
	}
}

function replaySpool(result: StreamResult, file: SpoolFile, uncompressedSize?: number): StreamResult {
	const stream = createReadStream(file.path, { highWaterMark: STREAM_CHUNK_BYTES }) as SourceCleanupReadable
	const closed = new Promise<void>((resolve) => stream.once('close', resolve))
	let cleanupPromise: Promise<void> | undefined
	const cleanup = () => {
		if (!cleanupPromise) {
			if (!stream.destroyed) stream.destroy()
			cleanupPromise = closed.then(() => file.cleanup())
		}
		return cleanupPromise
	}
	stream[SOURCE_CLEANUP] = cleanup
	stream.once('close', () => void cleanup().catch(() => undefined))
	return {
		...result,
		stream,
		metadata: {
			...result.metadata,
			size: file.size,
			...(uncompressedSize !== undefined && {
				customMetadata: { ...result.metadata.customMetadata, uncompressedSize: String(uncompressedSize) },
			}),
		},
	}
}

export async function verifyFileStream(
	result: StreamResult,
	expectedCid: string,
	signal?: AbortSignal,
): Promise<StreamResult> {
	return replaySpool(result, await writeSpool(result, { expectedCid, signal }))
}

export async function transformFileStream(
	result: StreamResult,
	kind: 'identity' | 'measure-gzip',
	signal?: AbortSignal,
): Promise<StreamResult> {
	const file = await writeSpool(result, { decodeGzip: kind === 'identity', signal })
	if (kind === 'identity') return replaySpool(result, file, file.size)
	try {
		let uncompressedSize = 0
		const counter = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				uncompressedSize += chunk.byteLength
				callback()
			},
		})
		await pipeline(createReadStream(file.path), createDecompressStream(MAX_BLOB_SIZE), counter, { signal })
		checkAborted(signal)
		return replaySpool(result, file, uncompressedSize)
	} catch (error) {
		await file.cleanup()
		throw error
	}
}
