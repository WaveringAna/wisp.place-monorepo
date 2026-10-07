/**
 * Reproducible local bench for streamed-read promotion.
 *
 * Reads the same cold object N times through `TieredStorage.getStream` (the
 * hosting read path) with hosting's tier layout: memory hot, disk warm, and a
 * counting cold tier that stands in for S3. It reports cold-tier calls
 * (GET = getStream/get/getWithMetadata, HEAD = getMetadata, metadata writes),
 * the tier that served each read, per-read latency, and the RSS growth of one
 * large streamed read.
 *
 * Usage: bun scripts/bench-stream-promotion.ts [--reads 20] [--cold-latency-ms 25] [--large-mib 256]
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'
import { DiskStorageTier, MemoryStorageTier, type StorageMetadata, type StorageTier, TieredStorage } from '../src/index'

const { values } = parseArgs({
	options: {
		reads: { type: 'string', default: '20' },
		'cold-latency-ms': { type: 'string', default: '25' },
		'large-mib': { type: 'string', default: '256' },
	},
})
const reads = Number(values.reads)
const coldLatencyMs = Number(values['cold-latency-ms'])
const largeBytes = Number(values['large-mib']) * 1024 * 1024
const CHUNK = 64 * 1024

const counts = { get: 0, head: 0, metadataWrite: 0 }

const metadataFor = (key: string, size: number): StorageMetadata => ({
	key,
	size,
	createdAt: new Date(0),
	lastAccessed: new Date(0),
	accessCount: 0,
	compressed: false,
	checksum: `bench-${size}`,
})

/** Deterministic bytes generated on demand, so the source itself never holds an object in memory. */
function* chunksOf(size: number): Generator<Buffer> {
	for (let offset = 0; offset < size; offset += CHUNK) {
		yield Buffer.alloc(Math.min(CHUNK, size - offset), offset / CHUNK)
	}
}

const delay = () => new Promise((resolve) => setTimeout(resolve, coldLatencyMs))

/** Read-only S3 stand-in: every call pays one simulated round trip and is counted. */
function countingColdTier(objects: Map<string, number>): StorageTier {
	const body = async (key: string) => {
		counts.get++
		await delay()
		const size = objects.get(key)
		return size === undefined ? null : { size, metadata: metadataFor(key, size) }
	}
	return {
		get: async (key) => {
			const found = await body(key)
			return found && new Uint8Array(Buffer.concat([...chunksOf(found.size)]))
		},
		getWithMetadata: async (key) => {
			const found = await body(key)
			return found && { data: new Uint8Array(Buffer.concat([...chunksOf(found.size)])), metadata: found.metadata }
		},
		getStream: async (key) => {
			const found = await body(key)
			return found && { stream: Readable.from(chunksOf(found.size)), metadata: found.metadata }
		},
		getMetadata: async (key) => {
			counts.head++
			await delay()
			const size = objects.get(key)
			return size === undefined ? null : metadataFor(key, size)
		},
		setMetadata: async () => {
			counts.metadataWrite++
		},
		set: async () => {},
		delete: async () => {},
		exists: async (key) => objects.has(key),
		listKeys: async function* () {},
		deleteMany: async () => {},
		getStats: async () => ({ bytes: 0, items: objects.size }),
		clear: async () => {},
	}
}

async function drain(stream: NodeJS.ReadableStream): Promise<number> {
	let bytes = 0
	for await (const chunk of stream) bytes += (chunk as Buffer).byteLength
	return bytes
}

const directory = await mkdtemp(join(tmpdir(), 'tiered-storage-bench-'))
const objects = new Map([
	['did:plc:bench/site/app.css', 40 * 1024],
	['did:plc:bench/site/photo.png', 2 * 1024 * 1024],
	['did:plc:bench/site/video.mp4', largeBytes],
])
const storage = new TieredStorage<Uint8Array>({
	tiers: {
		hot: new MemoryStorageTier({ maxSizeBytes: 100 * 1024 * 1024, maxItems: 500 }),
		warm: new DiskStorageTier({ directory, encodeColons: false }),
		cold: countingColdTier(objects),
	},
	// Hosting's placement shape: css/js may live in memory, media stays on disk.
	placementRules: [
		{ pattern: '**/*.{css,js}', tiers: ['hot', 'warm', 'cold'] },
		{ pattern: '**', tiers: ['warm', 'cold'] },
	],
	compression: false,
	promotionStrategy: 'eager',
	serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 2 * coldLatencyMs + 10))

async function repeatedReads(key: string) {
	const before = { ...counts }
	const sources: Record<string, number> = {}
	const latencies: number[] = []
	for (let read = 0; read < reads; read++) {
		const started = performance.now()
		const result = await storage.getStream(key)
		if (!result) throw new Error(`missing ${key}`)
		const bytes = await drain(result.stream)
		latencies.push(performance.now() - started)
		if (bytes !== objects.get(key)) throw new Error(`short read of ${key}: ${bytes}`)
		sources[result.source] = (sources[result.source] ?? 0) + 1
		// Let fire-and-forget access-stat updates land in this read's counts.
		await settle()
	}
	const sorted = [...latencies].sort((a, b) => a - b)
	return {
		key,
		reads,
		coldGet: counts.get - before.get,
		coldHead: counts.head - before.head,
		coldMetadataWrite: counts.metadataWrite - before.metadataWrite,
		sources,
		firstReadMs: Number(latencies[0]!.toFixed(2)),
		medianLaterReadMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(2)),
		totalMs: Number(latencies.reduce((sum, value) => sum + value, 0).toFixed(1)),
	}
}

async function largeRead(key: string) {
	Bun.gc(true)
	const baseline = process.memoryUsage().rss
	let peak = baseline
	const sampler = setInterval(() => {
		peak = Math.max(peak, process.memoryUsage().rss)
	}, 2)
	const result = await storage.getStream(key)
	if (!result) throw new Error(`missing ${key}`)
	const bytes = await drain(result.stream)
	clearInterval(sampler)
	peak = Math.max(peak, process.memoryUsage().rss)
	const mib = (value: number) => Number((value / 1024 / 1024).toFixed(1))
	return {
		key,
		bytes: mib(bytes),
		source: result.source,
		rssBaselineMiB: mib(baseline),
		rssPeakGrowthMiB: mib(peak - baseline),
	}
}

try {
	// The large read runs first so its RSS growth is not hidden by earlier allocations.
	const large = await largeRead('did:plc:bench/site/video.mp4')
	const largeAgain = await storage.getStream('did:plc:bench/site/video.mp4')
	if (largeAgain) await drain(largeAgain.stream)
	await settle()
	const report = {
		coldLatencyMs,
		large: { ...large, secondReadSource: largeAgain?.source ?? null },
		repeated: [await repeatedReads('did:plc:bench/site/app.css'), await repeatedReads('did:plc:bench/site/photo.png')],
	}
	console.log(JSON.stringify(report, null, 2))
} finally {
	await rm(directory, { recursive: true, force: true })
}
