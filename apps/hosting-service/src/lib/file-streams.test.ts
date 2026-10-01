import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { computeCID, computeCIDFromDigest } from '@wispplace/atproto-utils'
import { MAX_BLOB_SIZE } from '@wispplace/constants'
import { DecompressionLimitError, type StreamResult } from '@wispplace/tiered-storage'
import {
	bufferResponseBody,
	disposeFileStream,
	disposeFileStreamAndWait,
	FileStreamIntegrityError,
	getStreamResponseBody,
	peekFileStream,
	transformFileStream,
	verifyFileStream,
} from './file-streams'

let directory: string
let previousCacheDir: string | undefined
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'wisp-stream-test-'))
	previousCacheDir = process.env.CACHE_DIR
	process.env.CACHE_DIR = join(directory, 'sites')
})
afterEach(async () => {
	if (previousCacheDir === undefined) delete process.env.CACHE_DIR
	else process.env.CACHE_DIR = previousCacheDir
	await rm(directory, { recursive: true, force: true })
})

function result(data: Uint8Array, chunkSize = 16 * 1024): StreamResult {
	function* chunks() {
		for (let offset = 0; offset < data.byteLength; offset += chunkSize) yield data.subarray(offset, offset + chunkSize)
	}
	return {
		stream: Readable.from(chunks(), { objectMode: false }),
		metadata: {
			key: 'owner/site/file',
			size: data.byteLength,
			checksum: createHash('sha256').update(data).digest('hex'),
			compressed: false,
			accessCount: 0,
			createdAt: new Date(),
			lastAccessed: new Date(),
		},
		source: 'warm',
	}
}

async function bytes(value: StreamResult): Promise<Uint8Array> {
	return new Uint8Array(await new Response(getStreamResponseBody(value.stream)).arrayBuffer())
}

async function expectNoSpools(): Promise<void> {
	// File close cleanup is asynchronous and deliberately does not hold response completion.
	for (let attempt = 0; attempt < 100; attempt++) {
		const entries = await readdir(join(directory, '.streams')).catch(() => [])
		if (!entries.length) return
		await Bun.sleep(2)
	}
	expect(await readdir(join(directory, '.streams'))).toEqual([])
}

test('incremental SHA-256 digest builds the same raw blob CID', () => {
	const data = Buffer.from('blob bytes')
	expect(computeCIDFromDigest(createHash('sha256').update(data).digest())).toBe(computeCID(data))
	expect(() => computeCIDFromDigest(new Uint8Array(31))).toThrow('SHA-256')
})

test('buffer response body uses the original backing store and bounded chunk views', async () => {
	const data = Buffer.alloc(128 * 1024, 0x5a)
	const reader = bufferResponseBody(data).getReader()
	const first = await reader.read()
	expect(first.value!.buffer).toBe(data.buffer)
	expect(first.value!.byteLength).toBe(64 * 1024)
	data[0] = 0x42
	expect(first.value![0]).toBe(0x42)
	await reader.cancel()
})

test('byte-weighted web backpressure does not read a whole slow response ahead', async () => {
	let produced = 0
	const chunk = Buffer.alloc(64 * 1024)
	function* chunks() {
		for (let index = 0; index < 4096; index++) {
			produced++
			yield chunk
		}
	}
	const source = Readable.from(chunks(), { objectMode: false, highWaterMark: 64 * 1024 })
	const body = getStreamResponseBody(source)
	await Bun.sleep(10)
	expect(produced).toBeLessThan(8)
	const reader = body.getReader()
	await reader.read()
	await reader.cancel()
	expect(source.destroyed).toBe(true)
})

test('peeking gzip magic preserves every byte and does not copy the first chunk', async () => {
	const data = gzipSync('hello world')
	const peek = await peekFileStream(result(data))
	expect([...peek.prefix]).toEqual([0x1f, 0x8b])
	expect(peek.prefix.buffer).toBe(data.buffer)
	expect(await bytes(peek.result)).toEqual(new Uint8Array(data))
})

test('destroying an unconsumed peek releases the original stream', async () => {
	const original = result(Buffer.alloc(1024 * 1024))
	const peek = await peekFileStream(original)
	disposeFileStream(peek.result.stream)
	await Bun.sleep(2)
	expect((original.stream as Readable).destroyed).toBe(true)
})

test('legacy CID verification spools before returning and replays identical bytes', async () => {
	const data = Buffer.alloc(2 * 1024 * 1024, 0x5a)
	const verified = await verifyFileStream(result(data), computeCID(data))
	expect(verified.metadata.size).toBe(data.byteLength)
	expect(await bytes(verified)).toEqual(new Uint8Array(data))
	await expectNoSpools()
})

test('wrong CID returns no response stream and removes its replay file', async () => {
	await expect(verifyFileStream(result(Buffer.from('wrong')), computeCID(Buffer.from('right')))).rejects.toBeInstanceOf(
		FileStreamIntegrityError,
	)
	await expectNoSpools()
})

test('cancelling a verified body removes its replay file', async () => {
	const data = Buffer.alloc(1024 * 1024, 0x5a)
	const verified = await verifyFileStream(result(data), computeCID(data))
	const reader = getStreamResponseBody(verified.stream).getReader()
	await reader.read()
	await reader.cancel()
	await expectNoSpools()
})

test('aborted verification destroys its input without creating replay files', async () => {
	const controller = new AbortController()
	controller.abort()
	const original = result(Buffer.from('body'))
	await expect(verifyFileStream(original, computeCID(Buffer.from('body')), controller.signal)).rejects.toThrow()
	expect((original.stream as Readable).destroyed).toBe(true)
	await expectNoSpools()
})

test('source failure cannot return a partial legacy replay', async () => {
	const stream = Readable.from(
		(async function* () {
			yield Buffer.from('partial')
			throw new Error('broken source')
		})(),
	)
	await expect(
		verifyFileStream({ ...result(Buffer.from('')), stream }, computeCID(Buffer.from('partial'))),
	).rejects.toThrow('broken source')
	await expectNoSpools()
})

test('gzip identity preflight decodes before returning and exposes actual length', async () => {
	const plain = Buffer.from('identity text'.repeat(4096))
	const decoded = await transformFileStream(result(gzipSync(plain)), 'identity')
	expect(decoded.metadata.size).toBe(plain.byteLength)
	expect(await bytes(decoded)).toEqual(new Uint8Array(plain))
	await expectNoSpools()
})

test('legacy gzip measurement validates the gzip while preserving its encoded representation', async () => {
	const plain = Buffer.from('encoded text'.repeat(4096))
	const compressed = gzipSync(plain)
	const measured = await transformFileStream(result(compressed), 'measure-gzip')
	expect(measured.metadata.customMetadata?.uncompressedSize).toBe(String(plain.byteLength))
	expect(await bytes(measured)).toEqual(new Uint8Array(compressed))
	await expectNoSpools()
})

test('malformed gzip never receives a body and removes its replay files', async () => {
	for (const kind of ['identity', 'measure-gzip'] as const) {
		await expect(transformFileStream(result(Buffer.from([0x1f, 0x8b, 0])), kind)).rejects.toThrow()
	}
	await expectNoSpools()
})

test('cancelling during a pending pull never enqueues after cancellation', async () => {
	let started!: () => void
	let release!: () => void
	const pending = new Promise<void>((resolve) => {
		release = resolve
	})
	const pulling = new Promise<void>((resolve) => {
		started = resolve
	})
	const source = Readable.from(
		(async function* () {
			started()
			await pending
			yield Buffer.from('late bytes')
		})(),
		{ objectMode: false },
	)
	const reader = getStreamResponseBody(source).getReader()
	const read = reader.read()
	await pulling
	const cancelled = reader.cancel()
	release()
	await cancelled
	expect((await read).done).toBe(true)
	expect(source.destroyed).toBe(true)
})

test('request abort rejects a pending body read and releases its source', async () => {
	const controller = new AbortController()
	const source = new Readable({ read() {} })
	const reader = getStreamResponseBody(source, controller.signal).getReader()
	const read = reader.read()
	controller.abort()
	await expect(read).rejects.toThrow('Request aborted')
	expect(source.destroyed).toBe(true)
})

test('abort during legacy preflight removes partial replay files', async () => {
	const controller = new AbortController()
	const source = new Readable({
		read() {
			this.push(Buffer.alloc(64 * 1024))
		},
	})
	const verification = verifyFileStream(
		{ ...result(Buffer.from('')), stream: source },
		computeCID(Buffer.from('')),
		controller.signal,
	)
	for (let attempt = 0; attempt < 100; attempt++) {
		const entries = await readdir(join(directory, '.streams')).catch(() => [])
		if (entries.length) break
		await Bun.sleep(2)
	}
	controller.abort()
	await expect(verification).rejects.toThrow()
	expect(source.destroyed).toBe(true)
	await expectNoSpools()
})

test('gzip preflight rejects expanded output above the blob cap', async () => {
	const compressed = gzipSync(Buffer.alloc(MAX_BLOB_SIZE + 1))
	for (const kind of ['identity', 'measure-gzip'] as const) {
		await expect(transformFileStream(result(compressed), kind)).rejects.toBeInstanceOf(DecompressionLimitError)
		await expectNoSpools()
	}
})

test('gzip magic is recognized across one-byte source chunks', async () => {
	const data = gzipSync('split magic')
	const peek = await peekFileStream(result(data, 1))
	expect([...peek.prefix]).toEqual([0x1f, 0x8b])
	expect(await bytes(peek.result)).toEqual(new Uint8Array(data))
})

test('peeking an empty or one-byte file preserves its entire body', async () => {
	for (const data of [Buffer.alloc(0), Buffer.from([0x1f])]) {
		const peek = await peekFileStream(result(data, 1))
		expect(peek.prefix).toEqual(new Uint8Array(data))
		expect(await bytes(peek.result)).toEqual(new Uint8Array(data))
	}
})

test('awaited disposal removes a replay before resolving', async () => {
	const data = Buffer.from('owned replay')
	const verified = await verifyFileStream(result(data), computeCID(data))
	await disposeFileStreamAndWait(verified.stream)
	expect(await readdir(join(directory, '.streams'))).toEqual([])
})

test('awaited peek disposal also removes its underlying replay', async () => {
	const data = Buffer.from('peeked replay')
	const verified = await verifyFileStream(result(data), computeCID(data))
	const peek = await peekFileStream(verified)
	await disposeFileStreamAndWait(peek.result.stream)
	expect(await readdir(join(directory, '.streams'))).toEqual([])
})
