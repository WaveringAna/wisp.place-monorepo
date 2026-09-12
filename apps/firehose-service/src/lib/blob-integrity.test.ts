import { describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { MAX_BLOB_SIZE } from '@wispplace/constants'
import { SafeFetchHttpError } from '@wispplace/safe-fetch'
import { CID } from 'multiformats/cid'
import { sha256, sha512 } from 'multiformats/hashes/sha2'
import { BlobIntegrityError, type BlobSource, fetchVerifiedBlob, verifyBlobBytes } from './blob-integrity'
import { TransferByteBudget } from './revalidate-resources'

async function sourceFor(bytes: Uint8Array): Promise<BlobSource> {
	return {
		pds: 'https://pds.example',
		recordCid: 'record-cid',
		path: 'index.html',
		ownerDid: 'did:plc:source',
		blobCid: CID.createV1(0x55, await sha256.digest(bytes)).toString(),
		expectedSize: bytes.length,
	}
}
const resolver = async () => [{ address: '8.8.8.8', family: 4 as const }]

async function fetchResponse(source: BlobSource, response: Response) {
	return fetchVerifiedBlob(source, { resolver, transport: async () => response })
}

describe('raw PDS blob integrity', () => {
	for (const status of [404, 410])
		test(`classifies missing HTTP ${status} with actionable source details`, async () => {
			const source = await sourceFor(Buffer.from('expected'))
			await expect(fetchResponse(source, new Response(null, { status }))).rejects.toMatchObject({
				code: 'BLOB_MISSING',
				details: { ...source, actualSize: null, status },
			})
		})

	for (const bytes of [null, Buffer.alloc(0), Buffer.from('short'), Buffer.from('longer-than-expected')])
		test(`rejects declared-size mismatch including empty 200 (${bytes?.length ?? 'null'})`, async () => {
			const source = await sourceFor(Buffer.from('expected'))
			await expect(fetchResponse(source, new Response(bytes))).rejects.toMatchObject({
				code: 'BLOB_SIZE_MISMATCH',
				details: { expectedSize: 8, actualSize: bytes?.length ?? 0 },
			})
		})

	test('accepts a genuine empty file with its empty raw CID', async () => {
		const source = await sourceFor(Buffer.alloc(0))
		expect(await fetchResponse(source, new Response(null))).toEqual(new Uint8Array(0))
	})

	test('rejects same-size corrupt bytes', async () => {
		const source = await sourceFor(Buffer.from('expected'))
		await expect(fetchResponse(source, new Response('corrupt!'))).rejects.toMatchObject({
			code: 'BLOB_CID_MISMATCH',
			details: { expectedSize: 8, actualSize: 8 },
		})
	})

	test('verifies gzip and base64 bytes before any decoding', async () => {
		for (const bytes of [gzipSync('hello world'), Buffer.from(gzipSync('hello world').toString('base64'))]) {
			const source = await sourceFor(bytes)
			expect(await fetchResponse(source, new Response(bytes))).toEqual(new Uint8Array(bytes))
			const decodedSource = await sourceFor(Buffer.from('hello world'))
			await expect(verifyBlobBytes({ ...decodedSource, expectedSize: bytes.length }, bytes)).rejects.toMatchObject({
				code: 'BLOB_CID_MISMATCH',
			})
		}
	})

	test('fails closed on malformed CID, unsupported codec and unsupported hash', async () => {
		const bytes = Buffer.from('x')
		const source = await sourceFor(bytes)
		await expect(verifyBlobBytes({ ...source, blobCid: 'not-a-cid' }, bytes)).rejects.toMatchObject({
			code: 'BLOB_INVALID_CID',
		})
		for (const cid of [
			CID.createV1(0x71, await sha256.digest(bytes)),
			CID.createV1(0x55, await sha512.digest(bytes)),
		]) {
			await expect(verifyBlobBytes({ ...source, blobCid: cid.toString() }, bytes)).rejects.toMatchObject({
				code: 'BLOB_UNSUPPORTED_CID',
			})
		}
	})

	test('does not misclassify network failures or HTTP 503 as integrity errors', async () => {
		const source = await sourceFor(Buffer.from('expected'))
		await expect(fetchResponse(source, new Response(null, { status: 503 }))).rejects.toBeInstanceOf(SafeFetchHttpError)
		const error = new Error('connection reset')
		await expect(
			fetchVerifiedBlob(source, {
				resolver,
				transport: async () => {
					throw error
				},
			}),
		).rejects.toBe(error)
	})

	test('bounds response bodies and charges shared transfer bytes once', async () => {
		const bytes = Buffer.from('test')
		const source = await sourceFor(bytes)
		const byteBudget = new TransferByteBudget(bytes.length)
		await fetchVerifiedBlob(source, { resolver, byteBudget, transport: async () => new Response(bytes) })
		expect(byteBudget.consumedBytes).toBe(bytes.length)
		await expect(
			fetchResponse(source, new Response('x', { headers: { 'content-length': String(MAX_BLOB_SIZE + 1) } })),
		).rejects.toThrow('Response too large')
	})

	test('honors cancellation before fetch and during response streaming', async () => {
		const source = await sourceFor(Buffer.from('test'))
		const controller = new AbortController()
		controller.abort(new Error('stopped'))
		let calls = 0
		await expect(
			fetchVerifiedBlob(source, {
				signal: controller.signal,
				resolver,
				transport: async () => {
					calls++
					return new Response('test')
				},
			}),
		).rejects.toThrow('stopped')
		expect(calls).toBe(0)
		const active = new AbortController()
		let cancelled = false
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					active.abort(new Error('stream stopped'))
				},
				cancel() {
					cancelled = true
				},
			},
			{ highWaterMark: 0 },
		)
		await expect(
			fetchVerifiedBlob(source, { signal: active.signal, resolver, transport: async () => new Response(body) }),
		).rejects.toThrow('stream stopped')
		expect(cancelled).toBe(true)
	})

	test('keeps persistent diagnostics bounded and excludes URL secrets', async () => {
		const source = await sourceFor(Buffer.from('x'))
		const error = new BlobIntegrityError('BLOB_MISSING', {
			...source,
			pds: 'https://user:secret@pds.example/path?token=secret',
			path: 'x'.repeat(5000),
			actualSize: null,
		})
		expect(error.details.pds).toBe('https://pds.example')
		expect(error.details.path).toHaveLength(2048)
		expect(JSON.stringify(error)).not.toContain('secret')
	})
})
