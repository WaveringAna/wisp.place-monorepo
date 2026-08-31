import { describe, expect, test } from 'bun:test'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gzipSync } from 'node:zlib'
import {
	createDecompressStream,
	DecompressionLimitError,
	decompress,
	measureDecompressedSize,
} from '../src/utils/compression.js'

describe('bounded gzip decompression', () => {
	test('returns valid gzip output up to the configured limit', async () => {
		const original = Buffer.from('valid compressed site asset '.repeat(128))
		const compressed = gzipSync(original)

		const output = await decompress(compressed, original.length)

		expect(output).toEqual(original)
	})

	test('measures valid gzip output without retaining a decompressed buffer', async () => {
		const original = Buffer.from('logical site size '.repeat(512))
		const compressed = gzipSync(original)

		expect(await measureDecompressedSize(compressed, original.length)).toBe(original.length)
	})

	test('rejects before retaining output above the configured limit', async () => {
		const compressed = gzipSync(Buffer.alloc(128 * 1024, 'a'))

		let thrown: unknown
		try {
			await decompress(compressed, 1024)
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(DecompressionLimitError)
		expect((thrown as DecompressionLimitError).maxOutputBytes).toBe(1024)
		expect((thrown as DecompressionLimitError).outputBytes).toBeGreaterThan(1024)
		await expect(measureDecompressedSize(compressed, 1024)).rejects.toBeInstanceOf(DecompressionLimitError)
	})

	test('aborts a streaming decode when its first oversized output chunk arrives', async () => {
		const compressed = gzipSync(Buffer.alloc(128 * 1024, 'a'))
		let bytesWritten = 0
		const sink = new Writable({
			write(chunk, _encoding, callback) {
				bytesWritten += Buffer.byteLength(chunk)
				callback()
			},
		})

		await expect(pipeline(Readable.from([compressed]), createDecompressStream(1024), sink)).rejects.toBeInstanceOf(
			DecompressionLimitError,
		)
		expect(bytesWritten).toBe(0)
	})

	test('rejects input that is not gzip before creating a decompression stream', async () => {
		await expect(decompress(Buffer.from('not gzip'), 1024)).rejects.toThrow('missing magic bytes')
	})
})
