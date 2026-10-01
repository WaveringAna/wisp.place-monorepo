import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { getStreamResponseBody, verifyFileStream } from '../../apps/hosting-service/src/lib/file-streams'
import { computeCIDFromDigest } from '../../packages/@wispplace/atproto-utils/src/blob'
import { TieredStorage } from '../../packages/@wispplace/tiered-storage/src/TieredStorage'
import { DiskStorageTier } from '../../packages/@wispplace/tiered-storage/src/tiers/DiskStorageTier'
import { MemoryStorageTier } from '../../packages/@wispplace/tiered-storage/src/tiers/MemoryStorageTier'
import type { StorageMetadata } from '../../packages/@wispplace/tiered-storage/src/types'

const bytes = 98_691_200
const chunkSize = 64 * 1024
const concurrency = Number(Bun.env.CONCURRENCY ?? 16)
const readDelayMs = Number(Bun.env.PROFILE_READ_DELAY_MS ?? 2)
const readDelayBytes = Number(Bun.env.PROFILE_READ_DELAY_BYTES ?? 2 * 1024 * 1024)
if (!Number.isSafeInteger(concurrency) || concurrency <= 0) throw new Error('invalid profile concurrency')
if (
	!Number.isSafeInteger(readDelayMs) ||
	readDelayMs < 0 ||
	!Number.isSafeInteger(readDelayBytes) ||
	readDelayBytes <= 0
)
	throw new Error('invalid profile read throttle')
const cacheRoot = Bun.env.PROFILE_CACHE ?? tmpdir()
await mkdir(cacheRoot, { recursive: true })
const cache = await mkdtemp(join(cacheRoot, 'hosting-streaming-profile-'))
process.env.CACHE_DIR = join(cache, 'cache', 'sites')
const fixture = join(cache, 'fixture')
const spoolDir = join(cache, 'cache', '.streams')
const hash = createHash('sha256')
const chunk = new Uint8Array(chunkSize)
for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + 7) & 255
const writer = createWriteStream(fixture, { flags: 'wx' })
for (let offset = 0; offset < bytes; offset += chunkSize) {
	const part = chunk.subarray(0, Math.min(chunkSize, bytes - offset))
	hash.update(part)
	if (!writer.write(part)) await new Promise<void>((resolve) => writer.once('drain', resolve))
}
writer.end()
await new Promise<void>((resolve, reject) => {
	writer.once('finish', resolve)
	writer.once('error', reject)
})
const digest = hash.digest()
const cid = computeCIDFromDigest(digest)
const metadata: StorageMetadata = {
	key: 'fixture',
	size: bytes,
	createdAt: new Date(),
	lastAccessed: new Date(),
	accessCount: 0,
	compressed: false,
	checksum: digest.toString('hex'),
	customMetadata: {},
}
const hot = new MemoryStorageTier({ maxSizeBytes: bytes + 1 })
const disk = new DiskStorageTier({ directory: join(cache, 'disk') })
await hot.setStream('fixture', createReadStream(fixture, { highWaterMark: chunkSize }), metadata)
await disk.setStream('fixture', createReadStream(fixture, { highWaterMark: chunkSize }), metadata)
const storage = new TieredStorage({ tiers: { hot, cold: disk } })
const diskStorage = new TieredStorage({ tiers: { cold: disk } })
const initialRss = process.memoryUsage().rss
let peakRss = initialRss
let totalDrained = 0
let failures = 0
let active = 0
const sources = new Set<Readable>()
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		if (request.method === 'HEAD')
			return new Response(null, { headers: { 'content-length': String(bytes), 'x-content-cid': cid } })
		const legacy = new URL(request.url).pathname === '/legacy'
		const selectedStorage = legacy ? diskStorage : storage
		const result = await selectedStorage.getStream('fixture', { signal: request.signal, borrowChunks: true })
		if (!result) return new Response('fixture missing', { status: 404 })
		const source = result.stream as Readable
		sources.add(source)
		active++
		source.once('close', () => {
			sources.delete(source)
			active--
		})
		try {
			const verified = legacy ? await verifyFileStream(result, cid, request.signal) : result
			return new Response(getStreamResponseBody(verified.stream, request.signal), {
				headers: {
					'content-length': String(bytes),
					'x-content-cid': cid,
					'x-profile-case': legacy ? 'legacy-spool-replay' : 'trusted-source-direct',
				},
			})
		} catch (error) {
			if (request.signal.aborted) return new Response(null, { status: 499 })
			failures++
			return new Response(String(error), { status: 500 })
		}
	},
})
async function readCgroupMemory() {
	try {
		const [current, peak, rawEvents] = await Promise.all([
			readFile('/sys/fs/cgroup/memory.current', 'utf8'),
			readFile('/sys/fs/cgroup/memory.peak', 'utf8'),
			readFile('/sys/fs/cgroup/memory.events', 'utf8'),
		])
		const events = Object.fromEntries(
			rawEvents
				.trim()
				.split('\n')
				.map((line) => {
					const [name, count] = line.split(' ')
					return [name, Number(count)]
				}),
		)
		return { currentBytes: Number(current.trim()), peakBytes: Number(peak.trim()), events }
	} catch {
		return null
	}
}
const sample = setInterval(() => {
	peakRss = Math.max(peakRss, process.memoryUsage().rss)
}, 20)
async function runCase(name: string, clients = concurrency) {
	const before = totalDrained
	const rssBaselineBytes = process.memoryUsage().rss
	const cgroupBefore = await readCgroupMemory()
	peakRss = rssBaselineBytes
	const started = performance.now()
	await Promise.all(
		Array.from({ length: clients }, async () => {
			const response = await fetch(`http://localhost:${server.port}/${name === 'legacy' ? 'legacy' : 'direct'}`)
			if (response.status !== 200 || response.headers.get('x-content-cid') !== cid)
				throw new Error(`${name}: status or CID mismatch`)
			let length = 0
			let nextDelayAt = readDelayBytes
			const responseHash = createHash('sha256')
			const reader = response.body!.getReader()
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				length += value.byteLength
				responseHash.update(value)
				totalDrained += value.byteLength
				while (length >= nextDelayAt) {
					if (readDelayMs > 0) await Bun.sleep(readDelayMs)
					nextDelayAt += readDelayBytes
				}
			}
			if (length !== bytes) throw new Error(`${name}: expected ${bytes} bytes, got ${length}`)
			if (computeCIDFromDigest(responseHash.digest()) !== cid) throw new Error(`${name}: body CID mismatch`)
		}),
	)
	const cgroupAfter = await readCgroupMemory()
	return {
		case: name,
		concurrency: clients,
		bytesEach: bytes,
		drainedBytes: totalDrained - before,
		elapsedMs: Math.round(performance.now() - started),
		rssBaselineBytes,
		rssPeakBytes: peakRss,
		cgroupBefore,
		cgroupAfter,
	}
}
try {
	const results = []
	results.push(await runCase('direct'))
	results.push(await runCase('legacy'))
	const head = await fetch(`http://localhost:${server.port}/direct`, { method: 'HEAD' })
	if (head.status !== 200 || head.headers.get('content-length') !== String(bytes) || head.body !== null)
		throw new Error('HEAD status, body, or length mismatch')
	const aborter = new AbortController()
	const aborted = await fetch(`http://localhost:${server.port}/direct`, { signal: aborter.signal })
	const reader = aborted.body!.getReader()
	await reader.read()
	aborter.abort()
	await reader.cancel().catch(() => undefined)
	const legacyAborter = new AbortController()
	const legacyAbortRequest = fetch(`http://localhost:${server.port}/legacy`, { signal: legacyAborter.signal })
	await Bun.sleep(25)
	legacyAborter.abort()
	try {
		const response = await legacyAbortRequest
		if (response.status === 200) throw new Error('legacy preflight abort unexpectedly succeeded')
	} catch (error) {
		if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error
	}
	await Bun.sleep(100)
	for (const source of sources) if (!source.destroyed) throw new Error('source stream leaked after completion/abort')
	await Bun.sleep(100)
	const spoolEntries = await readdir(spoolDir)
	if (failures !== 0 || active !== 0 || sources.size !== 0 || spoolEntries.length !== 0)
		throw new Error(
			`cleanup/assertion failure: failures=${failures}, active=${active}, sources=${sources.size}, spool=${spoolEntries.length}`,
		)
	console.log(
		JSON.stringify(
			{
				bunVersion: Bun.version,
				platform: process.platform,
				arch: process.arch,
				bytes,
				fixtureSha256: digest.toString('hex'),
				fixtureBytes: (await stat(fixture)).size,
				results,
				failures,
				active,
				sourceCount: sources.size,
				spoolEntries,
				note: 'standalone transport/profile harness; not a production file-serving benchmark',
			},
			null,
			2,
		),
	)
} finally {
	clearInterval(sample)
	server.stop(true)
	await rm(cache, { recursive: true, force: true })
}
