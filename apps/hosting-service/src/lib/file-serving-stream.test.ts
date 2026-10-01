import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { computeCID } from '@wispplace/atproto-utils'

const DID = 'did:plc:stream-test'
const RKEY = 'site'
const body = new TextEncoder().encode('streamed binary content')
const cid = computeCID(body)
let activeBody: Uint8Array = body
let activeCid = cid
let activeMimeType = 'application/octet-stream'
let activeEncoding: string | undefined
let activeUncompressedSize: string | undefined
let separatedGzipMagic = false
let laterGzipChunksRead = 0
let streamClosed = 0
let lastRawStream: Readable | undefined
let activeFilePath = 'asset.bin'
const streamReads: Array<{ key: string; signal?: AbortSignal; borrowChunks?: boolean }> = []
let bufferedReads = 0
let sourceCidSequence: Array<string | null> = []
let evictions = 0
let legacyCidRepairs = 0
let streamMissing = false

function nextSourceCidMetadata(): { sourceCid?: string } {
	if (!sourceCidSequence.length) return { sourceCid: activeCid }
	const sourceCid = sourceCidSequence.shift()
	return sourceCid === null ? {} : { sourceCid }
}

const fakeStorage = {
	async getStream(key: string, options?: { signal?: AbortSignal; borrowChunks?: boolean }) {
		streamReads.push({ key, ...options })
		if (streamMissing) return null
		let phase = 0
		const stream = separatedGzipMagic
			? new Readable({
					highWaterMark: 1,
					read() {
						if (phase === 0) {
							phase++
							this.push(Buffer.from([0x1f]))
						} else if (phase === 1) {
							phase++
							this.push(Buffer.from([0x8b]))
						} else if (phase === 2) {
							phase++
							laterGzipChunksRead++
							this.push(Buffer.from(activeBody.subarray(2)))
						} else this.push(null)
					},
				})
			: Readable.from([Buffer.from(activeBody)])
		lastRawStream = stream
		stream.once('close', () => streamClosed++)
		return {
			stream,
			metadata: {
				key,
				size: activeBody.byteLength,
				checksum: 'stream-etag',
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				customMetadata: {
					...nextSourceCidMetadata(),
					mimeType: activeMimeType,
					...(activeEncoding ? { encoding: activeEncoding } : {}),
					...(activeUncompressedSize ? { uncompressedSize: activeUncompressedSize } : {}),
				},
			},
			source: 'cold' as const,
		}
	},
	async getWithMetadata() {
		bufferedReads++
		throw new Error('streaming response should not use buffered storage')
	},
	async get() {
		return null
	},
	async listKeys() {
		return []
	},
}

mock.module('./storage', () => ({
	storage: fakeStorage,
	addPublicSourceCidIfChecksumMatches: async () => {
		legacyCidRepairs++
		return true
	},
	evictPublicCacheKey: async () => {
		evictions++
	},
	isStorageUnavailableError: () => false,
}))
mock.module('./db', () => ({
	getSiteCache: async () => ({
		did: DID,
		rkey: RKEY,
		record_cid: 'record-cid',
		file_cids: { [activeFilePath]: activeCid },
		cached_at: 0,
		updated_at: 0,
		absent_since: null,
	}),
	getSiteSettingsCache: async () => null,
}))
mock.module('./utils', () => ({ getCachedSettings: async () => null }))
mock.module('./revalidate-queue', () => ({ enqueueRevalidate: async () => ({ enqueued: true, result: 'enqueued' }) }))
mock.module('./revalidate-metrics', () => ({ recordStorageMiss: () => {} }))
mock.module('./cache-invalidation', () => ({ isSiteUpdating: () => false }))
mock.module('./html-prewarm', () => ({ triggerSiteHtmlHotCacheWarmup: () => {} }))

const { cache } = await import('./cache-manager')
const { serveFileInternal, serveFileInternalWithRewrite } = await import('./file-serving')

describe('file serving streams', () => {
	beforeEach(() => {
		streamReads.length = 0
		bufferedReads = 0
		sourceCidSequence = []
		evictions = 0
		legacyCidRepairs = 0
		streamMissing = false
		activeUncompressedSize = undefined
		separatedGzipMagic = false
		laterGzipChunksRead = 0
		streamClosed = 0
		lastRawStream = undefined
		activeBody = body
		activeCid = cid
		activeMimeType = 'application/octet-stream'
		activeEncoding = undefined
		activeFilePath = 'asset.bin'
		cache.clear('sourceCidMismatches')
	})

	test('serves a trusted non-HTML stream without reading a buffered snapshot', async () => {
		const signal = new AbortController().signal
		const response = await serveFileInternal(DID, RKEY, 'asset.bin', null, {}, null, {
			method: 'GET',
			signal,
		})

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('streamed binary content')
		expect(bufferedReads).toBe(0)
		expect(streamReads).toEqual([{ key: `${DID}/${RKEY}/asset.bin`, signal, borrowChunks: true }])
		expect(response.headers.get('Content-Length')).toBe(`${body.byteLength}`)
	})

	test('streams pre-rewritten HTML without materializing it', async () => {
		activeFilePath = 'page.html'
		activeBody = new TextEncoder().encode('<html>rewritten</html>')
		activeCid = computeCID(activeBody)
		activeMimeType = 'text/html'
		const response = await serveFileInternalWithRewrite(DID, RKEY, 'page.html', '/site/')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('<html>rewritten</html>')
		expect(bufferedReads).toBe(0)
		expect(streamReads[0]?.key).toBe(`${DID}/${RKEY}/.rewritten/page.html`)
	})

	test('retains byte-range response semantics for streams', async () => {
		const response = await serveFileInternal(DID, RKEY, 'asset.bin', null, {
			range: 'bytes=2-6',
			'if-range': '"stream-etag"',
		})

		expect(response.status).toBe(206)
		expect(response.headers.get('Content-Range')).toBe(`bytes 2-6/${body.byteLength}`)
		expect(await response.text()).toBe('reame')
	})

	test('applies If-Range and closes the source for HEAD byte ranges', async () => {
		const partial = await serveFileInternal(DID, RKEY, 'asset.bin', null, {
			range: 'bytes=2-6',
			'if-range': '"stream-etag"',
		})
		expect(partial.status).toBe(206)
		expect(partial.headers.get('Content-Range')).toBe(`bytes 2-6/${body.byteLength}`)

		const full = await serveFileInternal(DID, RKEY, 'asset.bin', null, {
			range: 'bytes=2-6',
			'if-range': '"stale-etag"',
		})
		expect(full.status).toBe(200)
		expect(await full.text()).toBe('streamed binary content')

		streamClosed = 0
		const head = await serveFileInternal(
			DID,
			RKEY,
			'asset.bin',
			null,
			{
				range: 'bytes=2-6',
			},
			null,
			{ method: 'HEAD' },
		)
		expect(head.status).toBe(206)
		expect(head.body).toBeNull()
		expect(head.headers.get('Content-Length')).toBe('5')
		expect(head.headers.get('Content-Range')).toBe(`bytes 2-6/${body.byteLength}`)
		expect(lastRawStream?.destroyed).toBe(true)
	})

	test('coalesces a mismatch burst into one cold validation read', async () => {
		sourceCidSequence = ['bafkreibad', 'bafkreibad', cid]
		const [first, second] = await Promise.all([
			serveFileInternal(DID, RKEY, 'asset.bin'),
			serveFileInternal(DID, RKEY, 'asset.bin'),
		])

		expect(first.status).toBe(200)
		expect(second.status).toBe(200)
		expect(streamReads).toHaveLength(5)
		expect(evictions).toBe(1)
	})

	test('evicts and retries one mismatched local stream against cold storage', async () => {
		sourceCidSequence = ['bafkreibad', cid]
		const response = await serveFileInternal(DID, RKEY, 'asset.bin')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('streamed binary content')
		expect(streamReads).toHaveLength(3)
		expect(evictions).toBe(1)
		expect(bufferedReads).toBe(0)
	})

	test('preflights and repairs a legacy stream without a source CID', async () => {
		sourceCidSequence = [null]
		const response = await serveFileInternal(DID, RKEY, 'asset.bin')

		expect(response.status).toBe(200)
		expect(await response.text()).toBe('streamed binary content')
		expect(bufferedReads).toBe(0)
		expect(legacyCidRepairs).toBe(1)
	})

	test('cleans gzip replay spools after a HEAD byte range', async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), 'hosting-stream-range-'))
		const originalCacheDir = process.env.CACHE_DIR
		process.env.CACHE_DIR = join(tempRoot, 'cache', 'sites')
		try {
			const identity = new TextEncoder().encode('head range identity body')
			activeBody = new Uint8Array(gzipSync(identity))
			activeCid = computeCID(activeBody)
			activeMimeType = 'text/plain'
			activeEncoding = 'gzip'
			const response = await serveFileInternal(
				DID,
				RKEY,
				'asset.bin',
				null,
				{
					'accept-encoding': 'gzip;q=0',
					range: 'bytes=2-6',
				},
				null,
				{ method: 'HEAD' },
			)
			expect(response.status).toBe(206)
			expect(response.body).toBeNull()
			expect(response.headers.get('Content-Length')).toBe('5')
			await new Promise<void>((resolve) => setImmediate(resolve))
			expect(await readdir(join(tempRoot, 'cache', '.streams'))).toHaveLength(0)
		} finally {
			if (originalCacheDir === undefined) delete process.env.CACHE_DIR
			else process.env.CACHE_DIR = originalCacheDir
			await rm(tempRoot, { recursive: true, force: true })
		}
	})

	test('closes a HEAD stream while preserving GET-equivalent length', async () => {
		const response = await serveFileInternal(DID, RKEY, 'asset.bin', null, {}, null, { method: 'HEAD' })

		expect(response.status).toBe(200)
		expect(response.body).toBeNull()
		expect(response.headers.get('Content-Length')).toBe(`${body.byteLength}`)
	})

	test('does not buffer when streaming reports a missing manifest object', async () => {
		streamMissing = true
		const response = await serveFileInternal(DID, RKEY, 'asset.bin')

		expect(response.status).toBe(503)
		expect(bufferedReads).toBe(0)
	})

	test('fails closed and negative-caches a stream mismatch after one cold retry', async () => {
		sourceCidSequence = ['bafkreibad', 'bafkreibad']
		const response = await serveFileInternal(DID, RKEY, 'asset.bin')
		expect(response.status).toBe(503)
		expect(bufferedReads).toBe(0)
		expect(evictions).toBe(1)
		const readCount = streamReads.length

		const second = await serveFileInternal(DID, RKEY, 'asset.bin')
		expect(second.status).toBe(503)
		expect(streamReads).toHaveLength(readCount)
	})

	test('preflights gzip streams before identity, passthrough, and conditional responses', async () => {
		const identity = new TextEncoder().encode('plain identity text')
		const compressed = new Uint8Array(gzipSync(identity))
		activeBody = compressed
		activeCid = computeCID(compressed)
		activeMimeType = 'text/plain'
		activeEncoding = 'gzip'

		const identityResponse = await serveFileInternal(DID, RKEY, 'asset.bin', null, { 'accept-encoding': 'gzip;q=0' })
		expect(identityResponse.status).toBe(200)
		expect(identityResponse.headers.get('Content-Encoding')).toBeNull()
		expect(await identityResponse.text()).toBe('plain identity text')
		expect(identityResponse.headers.get('ETag')).toBe('"stream-etag-identity"')

		activeUncompressedSize = `${identity.byteLength}`
		const compressedResponse = await serveFileInternal(DID, RKEY, 'asset.bin', null, { 'accept-encoding': 'gzip' })
		expect(compressedResponse.status).toBe(200)
		expect(compressedResponse.headers.get('Content-Encoding')).toBe('gzip')
		expect(new Uint8Array(await compressedResponse.arrayBuffer())).toEqual(compressed)

		const conditional = await serveFileInternal(DID, RKEY, 'asset.bin', null, {
			'accept-encoding': 'gzip;q=0',
			'if-none-match': '"stream-etag-identity"',
		})
		expect(conditional.status).toBe(304)
	})

	test('trusted gzip passthrough skips full-body preflight', async () => {
		const compressed = new Uint8Array(gzipSync(new TextEncoder().encode('trusted gzip fixture')))
		activeBody = compressed
		activeCid = computeCID(compressed)
		activeMimeType = 'text/plain'
		activeEncoding = 'gzip'
		activeUncompressedSize = `${new TextEncoder().encode('trusted gzip fixture').byteLength}`
		separatedGzipMagic = true

		const response = await serveFileInternal(DID, RKEY, 'asset.bin', null, {
			'accept-encoding': 'gzip',
			'if-none-match': '"stream-etag-gzip"',
		})

		expect(response.status).toBe(304)
		expect(laterGzipChunksRead).toBe(0)
	})

	test('rejects a truncated gzip stream before a matching 304', async () => {
		const compressed = new Uint8Array(gzipSync(new TextEncoder().encode('broken gzip fixture'))).subarray(0, 12)
		activeBody = compressed
		activeCid = computeCID(compressed)
		activeMimeType = 'text/plain'
		activeEncoding = 'gzip'

		const response = await serveFileInternal(DID, RKEY, 'asset.bin', null, {
			'accept-encoding': 'gzip;q=0',
			'if-none-match': '"stream-etag-identity"',
		})
		expect(response.status).toBe(422)
		expect(response.status).not.toBe(304)
	})
})
