/**
 * Reproducible local bench for per-read access statistics on warm-tier hits.
 *
 * Reads a fixed set of objects already on the disk warm tier N times through
 * `TieredStorage` (no hot tier, so every read is a warm hit) with a fixed
 * number of reads in flight. It reports metadata writes per read, the largest
 * number of metadata writes in flight (the disk tier's serialized mutation
 * queue), how long they take to drain (or flush) after the last read, read latency, and
 * RSS. Uses only APIs present before and after access-statistic batching, so
 * the same script measures both.
 *
 * Usage: bun scripts/bench-access-stats.ts [--reads 20000] [--keys 50] [--concurrency 32] [--path stream|buffered]
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DiskStorageTier, MemoryStorageTier, type StorageMetadata, TieredStorage } from '../src/index'

const { values } = parseArgs({
	options: {
		reads: { type: 'string', default: '20000' },
		keys: { type: 'string', default: '50' },
		concurrency: { type: 'string', default: '32' },
		path: { type: 'string', default: 'stream' },
	},
})
const reads = Number(values.reads)
const keyCount = Number(values.keys)
const concurrency = Number(values.concurrency)
const streamed = values.path === 'stream'
const SIZE = 4 * 1024

const metadataFor = (key: string): StorageMetadata => ({
	key,
	size: SIZE,
	createdAt: new Date(0),
	lastAccessed: new Date(0),
	accessCount: 0,
	compressed: false,
	checksum: `bench-${key}`,
})

const directory = await mkdtemp(join(tmpdir(), 'tiered-storage-access-bench-'))
const warm = new DiskStorageTier({ directory, encodeColons: false })
const keys = Array.from({ length: keyCount }, (_, index) => `did:plc:bench/site/asset-${index}.png`)
for (const key of keys) await warm.set(key, new Uint8Array(SIZE).fill(1), metadataFor(key))

// Count every metadata write the storage layer issues and how many are pending at once.
const writes = { total: 0, inFlight: 0, maxInFlight: 0 }
for (const method of ['setMetadata', 'setMetadataIfChecksumMatches'] as const) {
	const original = (warm[method] as (...args: never[]) => Promise<unknown>).bind(warm)
	;(warm as unknown as Record<string, unknown>)[method] = (...args: never[]) => {
		writes.total++
		writes.inFlight++
		writes.maxInFlight = Math.max(writes.maxInFlight, writes.inFlight)
		return original(...args).finally(() => writes.inFlight--)
	}
}

const storage = new TieredStorage<Uint8Array>({
	tiers: { warm, cold: new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 }) },
	promotionStrategy: 'eager',
	serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
})

async function readOnce(key: string): Promise<void> {
	if (!streamed) {
		await storage.getWithMetadata(key, { borrowData: true })
		return
	}
	const result = await storage.getStream(key)
	for await (const _chunk of result!.stream) {
	}
}

Bun.gc(true)
const rssBefore = process.memoryUsage().rss
let rssPeak = rssBefore
const latencies: number[] = []
let next = 0
const started = performance.now()
await Promise.all(
	Array.from({ length: concurrency }, async () => {
		while (next < reads) {
			const key = keys[next++ % keys.length]!
			const t0 = performance.now()
			await readOnce(key)
			latencies.push(performance.now() - t0)
			if (latencies.length % 1000 === 0) rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
		}
	}),
)
const readMs = performance.now() - started
const pendingAtEnd = writes.inFlight
const writesAtEnd = writes.total
rssPeak = Math.max(rssPeak, process.memoryUsage().rss)

const drainStarted = performance.now()
while (writes.inFlight > 0) await Bun.sleep(1)
// Before batching there is nothing to flush; after it, this is the shutdown flush.
await (storage as { flushAccessStats?: () => Promise<void> }).flushAccessStats?.()
const drainMs = performance.now() - drainStarted

latencies.sort((a, b) => a - b)
const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!
const round = (value: number) => Math.round(value * 1000) / 1000
console.log(
	JSON.stringify({
		path: values.path,
		reads,
		keys: keyCount,
		concurrency,
		metadataWritesDuringReads: writesAtEnd,
		metadataWritesPerRead: round(writesAtEnd / reads),
		maxMetadataWritesInFlight: writes.maxInFlight,
		metadataWritesPendingAtEnd: pendingAtEnd,
		drainMs: Math.round(drainMs),
		metadataWritesAfterDrain: writes.total,
		readsPerSecond: Math.round(reads / (readMs / 1000)),
		p50Ms: round(percentile(0.5)),
		p95Ms: round(percentile(0.95)),
		rssBeforeMiB: round(rssBefore / 1024 / 1024),
		rssPeakDeltaMiB: round((rssPeak - rssBefore) / 1024 / 1024),
	}),
)
await rm(directory, { recursive: true, force: true })
