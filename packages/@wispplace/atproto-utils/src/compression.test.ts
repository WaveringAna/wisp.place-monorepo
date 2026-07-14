import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { decompressFile } from './compression'

describe('decompressFile', () => {
	test('decompresses content within the configured limit', () => {
		const compressed = gzipSync(Buffer.from('hello'))
		expect(decompressFile(compressed, 1024).toString()).toBe('hello')
	})

	test('rejects content that expands past the configured limit', () => {
		const compressed = gzipSync(Buffer.alloc(4096, 0x61))
		expect(() => decompressFile(compressed, 1024)).toThrow()
	})
})
