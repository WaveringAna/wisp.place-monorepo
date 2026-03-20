import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { S3StorageTier } from '../src/tiers/S3StorageTier.js'

describe('S3StorageTier metadata fallback', () => {
	test('getWithMetadata should synthesize metadata when S3 metadata headers are missing', async () => {
		const tier = new S3StorageTier({
			bucket: 'test-bucket',
			region: 'us-east-1',
		})

		;(tier as any).client = {
			send: async () => ({
				Body: Readable.from([Buffer.from('hello')]),
				Metadata: undefined,
				ContentLength: 5,
				ContentType: 'text/plain',
				ContentEncoding: 'gzip',
				ETag: '"etag-123"',
			}),
		}

		const result = await tier.getWithMetadata('did:plc:abc/site/index.html')

		expect(result).not.toBeNull()
		expect(Buffer.from(result!.data).toString()).toBe('hello')
		expect(result!.metadata.key).toBe('did:plc:abc/site/index.html')
		expect(result!.metadata.size).toBe(5)
		expect(result!.metadata.checksum).toBe('etag-123')
		expect(result!.metadata.customMetadata).toEqual({
			mimeType: 'text/plain',
			encoding: 'gzip',
		})
	})

	test('getStream should synthesize metadata when S3 metadata headers are missing', async () => {
		const tier = new S3StorageTier({
			bucket: 'test-bucket',
			region: 'us-east-1',
		})

		;(tier as any).client = {
			send: async () => ({
				Body: Readable.from([Buffer.from('abc')]),
				Metadata: undefined,
				ContentLength: 3,
				ETag: '"etag-stream"',
			}),
		}

		const result = await tier.getStream('did:plc:abc/site/style.css')

		expect(result).not.toBeNull()
		expect(result!.metadata.key).toBe('did:plc:abc/site/style.css')
		expect(result!.metadata.size).toBe(3)
		expect(result!.metadata.checksum).toBe('etag-stream')
	})

	test('getMetadata should synthesize metadata from HeadObject when headers are missing', async () => {
		const tier = new S3StorageTier({
			bucket: 'test-bucket',
			region: 'us-east-1',
		})

		;(tier as any).client = {
			send: async () => ({
				Metadata: undefined,
				ContentLength: 42,
				ContentType: 'text/html',
				ETag: '"etag-head"',
			}),
		}

		const metadata = await tier.getMetadata('did:plc:abc/site/page.html')

		expect(metadata).not.toBeNull()
		expect(metadata!.key).toBe('did:plc:abc/site/page.html')
		expect(metadata!.size).toBe(42)
		expect(metadata!.checksum).toBe('etag-head')
		expect(metadata!.customMetadata).toEqual({ mimeType: 'text/html' })
	})

	test('getWithMetadata should infer gzip encoding from magic bytes for text-like content', async () => {
		const tier = new S3StorageTier({
			bucket: 'test-bucket',
			region: 'us-east-1',
		})

		const gzipped = gzipSync(Buffer.from('<html>ok</html>'))

		;(tier as any).client = {
			send: async () => ({
				Body: Readable.from([gzipped]),
				Metadata: undefined,
				ContentLength: gzipped.length,
				ContentType: 'text/html; charset=utf-8',
				ETag: '"etag-gzip"',
			}),
		}

		const result = await tier.getWithMetadata('did:plc:abc/site/index.html')

		expect(result).not.toBeNull()
		expect(Buffer.from(result!.data).equals(gzipped)).toBe(true)
		expect(result!.metadata.customMetadata).toEqual({
			mimeType: 'text/html',
			encoding: 'gzip',
		})
	})

	test('getWithMetadata should decode base64 payload and infer gzip encoding for text-like content', async () => {
		const tier = new S3StorageTier({
			bucket: 'test-bucket',
			region: 'us-east-1',
		})

		const gzipped = gzipSync(Buffer.from('console.log("ok")'))
		const base64 = Buffer.from(gzipped).toString('base64')

		;(tier as any).client = {
			send: async () => ({
				Body: Readable.from([Buffer.from(base64)]),
				Metadata: undefined,
				ContentLength: base64.length,
				ContentType: 'application/javascript',
				ETag: '"etag-base64-gzip"',
			}),
		}

		const result = await tier.getWithMetadata('did:plc:abc/site/app.js')

		expect(result).not.toBeNull()
		expect(Buffer.from(result!.data).equals(gzipped)).toBe(true)
		expect(result!.metadata.customMetadata).toEqual({
			mimeType: 'application/javascript',
			encoding: 'gzip',
		})
	})
})
