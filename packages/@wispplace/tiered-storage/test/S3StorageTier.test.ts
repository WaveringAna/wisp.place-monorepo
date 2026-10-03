import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3'
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

	test('getStream forwards its abort signal and keeps the response body owned', async () => {
		const tier = new S3StorageTier({ bucket: 'test-bucket', region: 'us-east-1' })
		const body = Readable.from([Buffer.from('stream')])
		const controller = new AbortController()
		let requestOptions: { abortSignal?: AbortSignal } | undefined
		;(tier as any).client = {
			send: async (_command: unknown, options: typeof requestOptions) => {
				requestOptions = options
				return { Body: body, Metadata: undefined, ContentLength: 6, ETag: '"stream-etag"' }
			},
		}

		const result = await tier.getStream('key', { signal: controller.signal })
		expect(requestOptions?.abortSignal).toBe(controller.signal)
		expect(result?.stream).toBe(body)
		;(result!.stream as Readable).destroy()
	})

	test('destroys an S3 response body when metadata conversion fails', async () => {
		const tier = new S3StorageTier({ bucket: 'test-bucket', region: 'us-east-1' })
		const body = Readable.from([Buffer.from('unused')])
		;(tier as any).client = { send: async () => ({ Body: body, Metadata: { key: '%' } }) }

		await expect(tier.getStream('key')).rejects.toThrow()
		expect(body.destroyed).toBe(true)
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

describe('S3StorageTier durable write cancellation', () => {
	test('forwards the storage deadline abort signal to PutObject', async () => {
		const tier = new S3StorageTier({ bucket: 'test-bucket', region: 'us-east-1' })
		const controller = new AbortController()
		let receivedSignal: AbortSignal | undefined
		setMockClient(tier, {
			async send(command, options?: { abortSignal?: AbortSignal }) {
				expect(command).toBeInstanceOf(PutObjectCommand)
				receivedSignal = options?.abortSignal
				return {}
			},
		})

		await tier.set(
			'private/site/index.html',
			new Uint8Array([1]),
			{
				key: 'private/site/index.html',
				size: 1,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'checksum',
			},
			{ signal: controller.signal },
		)

		expect(receivedSignal).toBe(controller.signal)
	})
})

describe('S3StorageTier CopySource encoding', () => {
	test('encodes unsafe key bytes while preserving CopySource path separators', async () => {
		const tier = new S3StorageTier({
			bucket: 'test-bucket',
			region: 'us-east-1',
			prefix: 'site root/',
		})
		let copySource: string | undefined
		const clientHolder = tier as unknown as {
			client: { send(command: { input: { CopySource?: string } }): Promise<unknown> }
		}
		clientHolder.client = {
			async send(command) {
				copySource = command.input.CopySource
				return {}
			},
		}

		const key = 'folder/hello world#?%/café.txt'
		await tier.setMetadata(key, {
			key,
			size: 1,
			createdAt: new Date(),
			lastAccessed: new Date(),
			accessCount: 0,
			compressed: false,
			checksum: 'test',
		})

		expect(copySource).toBe('test-bucket/site%20root/folder/hello%20world%23%3F%25/caf%C3%A9.txt')
	})
})

type MockS3Client = {
	send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>
}

function setMockClient(tier: S3StorageTier, client: MockS3Client): void {
	;(tier as unknown as { client: MockS3Client }).client = client
}

async function collectKeys(tier: S3StorageTier): Promise<string[]> {
	const keys: string[] = []
	for await (const key of tier.listKeys()) {
		keys.push(key)
	}
	return keys
}

describe('S3StorageTier bounded pagination', () => {
	test('uses continuation tokens for list and exact stats totals', async () => {
		const tier = new S3StorageTier({
			bucket: 'test-bucket',
			region: 'us-east-1',
			prefix: 'sites/',
			maxListPages: 4,
		})
		const continuationTokens: Array<string | undefined> = []
		setMockClient(tier, {
			async send(command) {
				expect(command).toBeInstanceOf(ListObjectsV2Command)
				const input = (command as ListObjectsV2Command).input
				continuationTokens.push(input.ContinuationToken)
				if (!input.ContinuationToken) {
					return {
						Contents: [{ Key: 'sites/first.txt', Size: 2 }],
						// Some compatible APIs supply a token even when IsTruncated is absent.
						NextContinuationToken: 'next-page',
					}
				}
				return { Contents: [{ Key: 'sites/second.txt', Size: 3 }], IsTruncated: false }
			},
		})

		expect(await collectKeys(tier)).toEqual(['first.txt', 'second.txt'])
		expect(await tier.getStats()).toEqual({ items: 2, bytes: 5 })
		expect(continuationTokens).toEqual([undefined, 'next-page', undefined, 'next-page'])
	})

	test('rejects a repeated continuation token for both listing and stats', async () => {
		const makeTier = () => {
			const tier = new S3StorageTier({ bucket: 'test-bucket', region: 'us-east-1', maxListPages: 10 })
			let requests = 0
			setMockClient(tier, {
				async send(command) {
					expect(command).toBeInstanceOf(ListObjectsV2Command)
					requests++
					return { Contents: [{ Key: `key-${requests}`, Size: 1 }], NextContinuationToken: 'same-token' }
				},
			})
			return { tier, getRequests: () => requests }
		}

		const listed = makeTier()
		await expect(collectKeys(listed.tier)).rejects.toThrow('S3 list response repeated continuation token')
		expect(listed.getRequests()).toBe(2)

		const stats = makeTier()
		await expect(stats.tier.getStats()).rejects.toThrow('S3 list response repeated continuation token')
		expect(stats.getRequests()).toBe(2)
	})

	test('rejects at the configured page bound rather than returning a partial total', async () => {
		const tier = new S3StorageTier({ bucket: 'test-bucket', region: 'us-east-1', maxListPages: 1 })
		let requests = 0
		setMockClient(tier, {
			async send(command) {
				expect(command).toBeInstanceOf(ListObjectsV2Command)
				requests++
				return { Contents: [{ Key: 'first', Size: 99 }], NextContinuationToken: 'next-page' }
			},
		})

		await expect(tier.getStats()).rejects.toThrow('S3 list page limit exceeded')
		expect(requests).toBe(1)
	})

	test('clears in bounded delete batches before requesting another list page', async () => {
		const tier = new S3StorageTier({
			bucket: 'test-bucket',
			region: 'us-east-1',
			prefix: 'sites/',
			maxListPages: 4,
		})
		const events: string[] = []
		const deletedBatches: string[][] = []
		setMockClient(tier, {
			async send(command) {
				if (command instanceof ListObjectsV2Command) {
					const token = command.input.ContinuationToken
					events.push(`list:${token ?? 'first'}`)
					if (!token) {
						return {
							Contents: Array.from({ length: 1000 }, (_, index) => ({ Key: `sites/key-${index}` })),
							NextContinuationToken: 'page-two',
						}
					}
					return { Contents: [{ Key: 'sites/key-1000' }] }
				}
				expect(command).toBeInstanceOf(DeleteObjectsCommand)
				const keys = ((command as DeleteObjectsCommand).input.Delete?.Objects ?? []).map((entry) => entry.Key ?? '')
				deletedBatches.push(keys)
				events.push(`delete:${keys.length}`)
				return {}
			},
		})

		await tier.clear()
		expect(events).toEqual(['list:first', 'delete:1000', 'list:page-two', 'delete:1'])
		expect(deletedBatches.map((batch) => batch.length)).toEqual([1000, 1])
		expect(deletedBatches[0]?.[0]).toBe('sites/key-0')
		expect(deletedBatches[1]).toEqual(['sites/key-1000'])
	})

	test('rejects a resolved S3 partial delete response', async () => {
		const tier = new S3StorageTier({ bucket: 'test-bucket', region: 'us-east-1' })
		setMockClient(tier, {
			async send(command) {
				expect(command).toBeInstanceOf(DeleteObjectsCommand)
				return { Errors: [{ Code: 'AccessDenied' }] }
			},
		})

		await expect(tier.deleteMany(['one'])).rejects.toThrow('S3 batch delete returned errors')
	})
})

describe('S3StorageTier conditional metadata', () => {
	test('uses the observed ETag as CopySourceIfMatch and rejects absent objects', async () => {
		const tier = new S3StorageTier({ bucket: 'test-bucket', region: 'us-east-1' })
		const commands: unknown[] = []
		;(tier as any).client = {
			send: async (command: unknown) => {
				commands.push(command)
				if (command instanceof CopyObjectCommand) return {}
				return {
					Metadata: {
						key: 'key',
						size: '1',
						createdat: '0',
						lastaccessed: '0',
						accesscount: '0',
						compressed: 'false',
						checksum: 'sum',
					},
					ETag: '"observed-etag"',
				}
			},
		}
		const updated = {
			key: 'key',
			size: 1,
			createdAt: new Date(0),
			lastAccessed: new Date(0),
			accessCount: 0,
			compressed: false,
			checksum: 'sum',
			customMetadata: { sourceCid: 'bafyreitest' },
		}
		expect(await tier.setMetadataIfChecksumMatches('key', 'sum', updated)).toBe(true)
		const copy = commands.find((command) => command instanceof CopyObjectCommand) as CopyObjectCommand
		expect(copy.input.CopySourceIfMatch).toBe('"observed-etag"')
		;(tier as any).client = {
			send: async () => {
				const error = new Error('missing')
				;(error as any).name = 'NoSuchKey'
				throw error
			},
		}
		expect(await tier.setMetadataIfChecksumMatches('absent', 'sum', updated)).toBe(false)
	})
})

describe('S3StorageTier copyObject', () => {
	const sourceHead = {
		Metadata: {
			key: 'did%3Aplc%3Aabc%2Fsite%2Fa.css',
			size: '19',
			createdat: '2024-01-01T00:00:00.000Z',
			lastaccessed: '2024-01-01T00:00:00.000Z',
			accesscount: '3',
			compressed: 'false',
			checksum: 'sum-1',
		},
		ETag: '"source-etag"',
	}
	const metadata = {
		key: 'cas/bafkreiabc.ebb2ee7b.css',
		size: 19,
		createdAt: new Date('2024-01-01T00:00:00Z'),
		lastAccessed: new Date('2024-02-01T00:00:00Z'),
		accessCount: 0,
		compressed: false,
		checksum: 'sum-1',
		customMetadata: { sourceCid: 'bafkreiabc', base64: 'false', uncompressedSize: '19' },
	}

	function tierWith(send: (command: unknown) => Promise<unknown>, prefix?: string) {
		const tier = new S3StorageTier({ bucket: 'test-bucket', region: 'us-east-1', prefix })
		;(tier as any).client = { send }
		return tier
	}

	test('copies inside the bucket, replacing metadata so it names the new key, fenced on the source ETag', async () => {
		const commands: unknown[] = []
		const tier = tierWith(async (command) => {
			commands.push(command)
			return command instanceof CopyObjectCommand ? {} : sourceHead
		}, 'sites/')

		expect(await tier.copyObject('did:plc:abc/site/a.css', 'cas/bafkreiabc.ebb2ee7b.css', metadata, 'sum-1')).toBe(true)

		const copy = commands.find((command) => command instanceof CopyObjectCommand) as CopyObjectCommand
		expect(copy.input.Bucket).toBe('test-bucket')
		expect(copy.input.Key).toBe('sites/cas/bafkreiabc.ebb2ee7b.css')
		expect(copy.input.CopySource).toBe('test-bucket/sites/did%3Aplc%3Aabc/site/a.css')
		expect(copy.input.CopySourceIfMatch).toBe('"source-etag"')
		expect(copy.input.MetadataDirective).toBe('REPLACE')
		expect(copy.input.Metadata?.key).toBe(encodeURIComponent('cas/bafkreiabc.ebb2ee7b.css'))
		expect(JSON.parse(copy.input.Metadata?.custom ?? '{}')).toEqual(metadata.customMetadata)
	})

	test('copies nothing when the source no longer has the checksum that was classified', async () => {
		const commands: unknown[] = []
		const tier = tierWith(async (command) => {
			commands.push(command)
			return sourceHead
		})

		expect(await tier.copyObject('a', 'b', metadata, 'a-different-sum')).toBe(false)
		expect(commands.some((command) => command instanceof CopyObjectCommand)).toBe(false)
	})

	test.each([
		['a source that is gone', 'NoSuchKey'],
		['a source that changed between the check and the copy', 'PreconditionFailed'],
	])('returns false for %s', async (_name, errorName) => {
		const tier = tierWith(async (command) => {
			if (command instanceof CopyObjectCommand) {
				const error = new Error(errorName)
				;(error as any).name = errorName
				throw error
			}
			return sourceHead
		})

		expect(await tier.copyObject('a', 'b', metadata, 'sum-1')).toBe(false)
	})

	test('does not attempt an unfenced copy when the backend returns no ETag', async () => {
		const commands: unknown[] = []
		const tier = tierWith(async (command) => {
			commands.push(command)
			return { Metadata: sourceHead.Metadata }
		})

		expect(await tier.copyObject('a', 'b', metadata, 'sum-1')).toBe(false)
		expect(commands.some((command) => command instanceof CopyObjectCommand)).toBe(false)
	})

	test('lets an unexpected failure through instead of reporting it as a changed source', async () => {
		const tier = tierWith(async (command) => {
			if (command instanceof CopyObjectCommand) throw new Error('connection reset')
			return sourceHead
		})

		await expect(tier.copyObject('a', 'b', metadata, 'sum-1')).rejects.toThrow('connection reset')
	})
})
