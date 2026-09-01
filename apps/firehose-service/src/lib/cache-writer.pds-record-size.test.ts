/**
 * Boundary tests for the shared PDS getRecord response size limit.
 *
 * Production revalidations failed as FETCH_FAILED when legitimate site and
 * chunked-subfs records exceeded the previous 64 KiB cap (observed up to
 * ~112 KiB). These tests pin the admitted range: a valid record above 64 KiB
 * must be accepted, and anything above the 1 MiB hard bound must be rejected,
 * including streamed responses that carry no Content-Length.
 */

// The loopback PDS escape hatch is evaluated when ./cache-writer is imported,
// so the dev gates must be in place before the module graph loads. bun test
// --isolate gives this file its own module registry.
process.env.NODE_ENV = 'development'
process.env.LOCAL_DEV = 'true'
process.env.WISP_ALLOW_LOCALHOST_FETCH = '1'
// cache-writer's import graph resolves the storage config; development mode
// needs the disk-storage stand-in because no S3 bucket is configured here.
process.env.FIREHOSE_ALLOW_DISK_STORAGE = 'true'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { SubfsSubject } from '@wispplace/atproto-utils'
import { createRevalidationResourceContext } from './revalidate-resources'

// Static imports are hoisted above the env setup above, so the module under
// test must be imported dynamically once the dev gates are visible to it.
const { MAX_PDS_RECORD_RESPONSE_BYTES, fetchSubfsRecord } = await import('./cache-writer')

const ABOVE_LEGACY_64_KIB = 70 * 1024
const ABOVE_1_MIB = MAX_PDS_RECORD_RESPONSE_BYTES + 1024

const subject: SubfsSubject = {
	uri: 'at://did:plc:source/place.wisp.subfs/record',
	repo: 'did:plc:source',
	collection: 'place.wisp.subfs',
	rkey: 'record',
}

/** Build a getRecord JSON envelope of approximately `totalBytes`. */
function recordEnvelope(totalBytes: number): string {
	const envelopeOverhead = 120
	const padding = 'x'.repeat(Math.max(0, totalBytes - envelopeOverhead))
	return JSON.stringify({
		uri: subject.uri,
		cid: 'bafyreitest',
		value: { $type: 'place.wisp.subfs', root: { $type: 'place.wisp.subfs#directory', entries: [] }, padding },
	})
}

function startPdsServer(): Promise<{ server: Server; url: string }> {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		// fetchSubfsRecord sends ?repo=&collection=&rkey=; the requested body
		// size and transfer style travel in the rkey itself (record-<bytes>[-chunked]).
		const rkey = url.searchParams.get('rkey') ?? ''
		const match = /^record-(\d+)(-chunked)?$/.exec(rkey)
		if (!match) {
			response.writeHead(400)
			response.end('unknown record key')
			return
		}
		const body = recordEnvelope(Number(match[1]))
		const chunked = match[2] === '-chunked'

		response.writeHead(200, {
			'content-type': 'application/json',
			...(chunked ? {} : { 'content-length': Buffer.byteLength(body).toString() }),
		})

		if (chunked) {
			// No Content-Length: HTTP/1.1 chunked transfer, flushed in small
			// pieces so the size bound must be enforced while streaming.
			const chunkSize = 16 * 1024
			let offset = 0
			const sendNext = () => {
				while (offset < body.length) {
					const slice = body.slice(offset, offset + chunkSize)
					offset += chunkSize
					if (!response.write(slice)) {
						response.once('drain', sendNext)
						return
					}
				}
				response.end()
			}
			sendNext()
		} else {
			response.end(body)
		}
	})

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			if (address === null || typeof address === 'string') {
				throw new Error('Expected a TCP listen address')
			}
			resolve({ server, url: `http://127.0.0.1:${address.port}` })
		})
	})
}

describe('PDS getRecord response size boundaries', () => {
	let pds: { server: Server; url: string }

	beforeAll(async () => {
		pds = await startPdsServer()
	})

	afterAll(() => {
		pds.server.close()
	})

	function resolveEndpoint(): Promise<string> {
		return Promise.resolve(pds.url)
	}

	async function fetchRecord(bytes: number, chunked: boolean): Promise<unknown> {
		const resources = createRevalidationResourceContext(30_000, 64 * 1024 * 1024)
		try {
			return await fetchSubfsRecord(
				{ ...subject, rkey: `record-${bytes}${chunked ? '-chunked' : ''}` },
				resolveEndpoint,
				resources,
			)
		} finally {
			resources.close()
		}
	}

	test('admits the previous 64 KiB hard bound as the new accepted floor', () => {
		expect(MAX_PDS_RECORD_RESPONSE_BYTES).toBe(1024 * 1024)
		expect(ABOVE_LEGACY_64_KIB).toBeGreaterThan(64 * 1024)
		expect(ABOVE_LEGACY_64_KIB).toBeLessThan(MAX_PDS_RECORD_RESPONSE_BYTES)
	})

	test('accepts a buffered getRecord response above 64 KiB', async () => {
		const value = (await fetchRecord(ABOVE_LEGACY_64_KIB, false)) as { padding?: string }
		expect(typeof value?.padding).toBe('string')
	})

	test('rejects a buffered getRecord response above 1 MiB', async () => {
		await expect(fetchRecord(ABOVE_1_MIB, false)).rejects.toThrow(/exceeds max size|Response too large/)
	})

	test('accepts a streamed getRecord response above 64 KiB without Content-Length', async () => {
		const value = (await fetchRecord(ABOVE_LEGACY_64_KIB, true)) as { padding?: string }
		expect(typeof value?.padding).toBe('string')
	})

	test('rejects a streamed getRecord response above 1 MiB without Content-Length', async () => {
		await expect(fetchRecord(ABOVE_1_MIB, true)).rejects.toThrow(/exceeds max size|Response too large/)
	})
})
