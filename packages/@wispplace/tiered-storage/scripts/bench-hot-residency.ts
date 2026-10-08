/**
 * Reproducible local bench for hot-tier residency under buffered reads.
 *
 * Builds a seeded mixed-size set of HTML objects in a counting cold tier and
 * reads them with a skewed (Zipf-like) popularity through
 * `TieredStorage.getWithMetadata`, the buffered path hosting uses for HTML,
 * `_redirects`, rewrites, and prewarm. Tiers follow hosting's layout: a memory
 * hot tier with hosting's byte and item caps, a disk warm tier, and a cold
 * stand-in for S3. It reports hot-tier bytes and items, how many resident
 * entries exceed 256 KiB, and which tier served the reads.
 *
 * Usage: bun scripts/bench-hot-residency.ts [--objects 400] [--reads 20000] [--hot-mib 32] [--hot-items 300] [--seed 1]
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DiskStorageTier, MemoryStorageTier, type StorageMetadata, TieredStorage } from '../src/index'

const { values } = parseArgs({
	options: {
		objects: { type: 'string', default: '400' },
		reads: { type: 'string', default: '20000' },
		'hot-mib': { type: 'string', default: '32' },
		'hot-items': { type: 'string', default: '300' },
		seed: { type: 'string', default: '1' },
	},
})
const objectCount = Number(values.objects)
const reads = Number(values.reads)
const hotBytes = Number(values['hot-mib']) * 1024 * 1024
const hotItems = Number(values['hot-items'])
const LARGE = 256 * 1024
const KiB = 1024

// mulberry32: small seeded PRNG so every run sees the same objects and reads.
let state = Number(values.seed) >>> 0
const random = () => {
	state = (state + 0x6d2b79f5) >>> 0
	let t = state
	t = Math.imul(t ^ (t >>> 15), t | 1)
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (low: number, high: number) => Math.floor(low + random() * (high - low))

/** Mostly small pages, with a tail of large single-page apps and generated docs. */
function objectSize(): number {
	const roll = random()
	if (roll < 0.7) return between(8 * KiB, 64 * KiB)
	if (roll < 0.9) return between(64 * KiB, 256 * KiB)
	if (roll < 0.98) return between(512 * KiB, 1024 * KiB)
	return between(2048 * KiB, 4096 * KiB)
}

const sizes = Array.from({ length: objectCount }, objectSize)
const keys = sizes.map((_, index) => `did:plc:bench/site-${index % 40}/page-${index}.html`)
// Popularity follows key index (Zipf), drawn independently of each object's size.
const weights = keys.map((_, rank) => 1 / (rank + 1))
const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
const pick = () => {
	let target = random() * totalWeight
	for (let index = 0; index < weights.length; index++) {
		target -= weights[index]!
		if (target <= 0) return index
	}
	return weights.length - 1
}

const metadataFor = (key: string, size: number): StorageMetadata => ({
	key,
	size,
	createdAt: new Date(0),
	lastAccessed: new Date(0),
	accessCount: 0,
	compressed: false,
	checksum: `bench-${key}`,
})

const directory = await mkdtemp(join(tmpdir(), 'tiered-storage-hot-bench-'))
const cold = new MemoryStorageTier({ maxSizeBytes: 2 * 1024 * 1024 * 1024 })
for (const [index, key] of keys.entries()) {
	await cold.set(key, new Uint8Array(sizes[index]!).fill(index % 251), metadataFor(key, sizes[index]!))
}
const hot = new MemoryStorageTier({ maxSizeBytes: hotBytes, maxItems: hotItems })
const storage = new TieredStorage<Uint8Array>({
	tiers: { hot, warm: new DiskStorageTier({ directory, encodeColons: false }), cold },
	placementRules: [{ pattern: '**/*.html', tiers: ['hot', 'warm', 'cold'] }],
	promotionStrategy: 'eager',
	serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
})

const served = { hot: 0, warm: 0, cold: 0 }
const servedBytes = { hot: 0, warm: 0, cold: 0 }
const latencies: number[] = []
for (let read = 0; read < reads; read++) {
	const t0 = performance.now()
	const result = await storage.getWithMetadata(keys[pick()]!, { borrowData: true })
	latencies.push(performance.now() - t0)
	served[result!.source]++
	servedBytes[result!.source] += result!.data.byteLength
}

let largeEntries = 0
let largeBytes = 0
for await (const key of hot.listKeys()) {
	const size = (await hot.getMetadata(key))!.size
	if (size > LARGE) {
		largeEntries++
		largeBytes += size
	}
}
const stats = await hot.getStats()
latencies.sort((a, b) => a - b)
const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!
const round = (value: number) => Math.round(value * 1000) / 1000
const mib = (value: number) => round(value / 1024 / 1024)
console.log(
	JSON.stringify({
		objects: objectCount,
		objectsOver256KiB: sizes.filter((size) => size > LARGE).length,
		reads,
		hotCapMiB: mib(hotBytes),
		hotCapItems: hotItems,
		hotBytesMiB: mib(stats.bytes),
		hotItems: stats.items,
		hotEntriesOver256KiB: largeEntries,
		hotBytesOver256KiBMiB: mib(largeBytes),
		hotEvictions: stats.evictions,
		servedFrom: served,
		hotHitRatio: round(served.hot / reads),
		bytesServedFromHotRatio: round(servedBytes.hot / (servedBytes.hot + servedBytes.warm + servedBytes.cold)),
		p50Ms: round(percentile(0.5)),
		p95Ms: round(percentile(0.95)),
	}),
)
await rm(directory, { recursive: true, force: true })
