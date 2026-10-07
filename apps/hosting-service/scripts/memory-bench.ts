#!/usr/bin/env bun
/**
 * Local memory benchmark for hosting-service.
 *
 * Seeds a disk-source object store, starts `src/index.ts` with a fake postgres
 * (scripts/memory-bench-preload.ts) and no Redis or S3, then serves a mix of
 * small and large sites over HTTP and reports process memory after a full GC.
 *
 *   bun apps/hosting-service/scripts/memory-bench.ts [--sites 2000] [--passes 4] [--idle 75] [--concurrency 16]
 *
 * Extra environment (HOT_CACHE_SIZE, MANIFEST_CACHE_SIZE, ...) is passed to the
 * server unchanged. Run it with the bun that production uses (1.4.2) for
 * comparable numbers.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DiskStorageTier, TieredStorage } from '@wispplace/tiered-storage'
import {
	BENCH_BASE_HOST,
	buildObjectPool,
	type ObjectPool,
	type PoolObject,
	siteHasVideo,
	siteHost,
} from './memory-bench-fixtures'

const { values: options } = parseArgs({
	options: {
		sites: { type: 'string', default: '2000' },
		passes: { type: 'string', default: '4' },
		idle: { type: 'string', default: '75' },
		concurrency: { type: 'string', default: '16' },
		port: { type: 'string', default: '39301' },
	},
})
const SITES = Number(options.sites)
const PASSES = Number(options.passes)
const IDLE_SECONDS = Number(options.idle)
const CONCURRENCY = Number(options.concurrency)
const PORT = Number(options.port)

interface Sample {
	rss: number
	heapSize: number
	arrayBuffers: number
	siteCacheEntries: number
	siteCacheBytes: number
	hotItems: number
	hotBytes: number
	logRing: number
	metricRing: number
}

async function seedObjects(cacheDir: string, pool: ObjectPool<PoolObject>): Promise<void> {
	const storage = new TieredStorage<Uint8Array>({
		tiers: { cold: new DiskStorageTier({ directory: cacheDir, encodeColons: false }) },
		compression: false,
		serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
	})
	for (const object of Object.values(pool).flat()) {
		await storage.set(object.key, object.stored, {
			metadata: {
				mimeType: object.mimeType,
				sourceCid: object.cid,
				uncompressedSize: String(object.uncompressedSize),
				...(object.encoding && { encoding: object.encoding }),
			},
		})
	}
}

function siteRequests(site: number): string[] {
	const paths = ['/', '/assets/style.css', '/assets/app.js']
	if (siteHasVideo(site)) paths.push('/media/video.mp4')
	return paths
}

/** A fixed permutation per pass, so every run requests the same sequence. */
function passOrder(pass: number): number[] {
	return Array.from({ length: SITES }, (_, index) => (index * 7919 + pass * 104_729) % SITES)
}

let requestsServed = 0
const statusCounts = new Map<number, number>()
// Date, the serving tier and the framing that follows it (a streamed tier is
// chunked, a hot hit may carry Content-Length) vary between requests; every
// other header and the body must not.
const VOLATILE_HEADERS = new Set(['date', 'x-cache-tier', 'content-length', 'transfer-encoding'])
const responseDigests = new Map<string, string>()
let changedResponses = 0

function responseDigest(response: Response, body: ArrayBuffer): string {
	const hash = new Bun.CryptoHasher('sha256')
	hash.update(String(response.status))
	for (const [name, value] of [...response.headers].sort(([a], [b]) => a.localeCompare(b))) {
		if (!VOLATILE_HEADERS.has(name)) hash.update(`\n${name}: ${value}`)
	}
	hash.update(new Uint8Array(body))
	return hash.digest('hex')
}

function recordResponse(request: string, digest: string): void {
	const previous = responseDigests.get(request)
	if (previous !== undefined && previous !== digest) changedResponses++
	responseDigests.set(request, digest)
}

/** One digest over every distinct request's status, stable headers and body. */
function corpusDigest(): string {
	const hash = new Bun.CryptoHasher('sha256')
	for (const [request, digest] of [...responseDigests].sort(([a], [b]) => a.localeCompare(b))) {
		hash.update(`${request} ${digest}\n`)
	}
	return hash.digest('hex').slice(0, 16)
}

async function visit(site: number): Promise<void> {
	for (const path of siteRequests(site)) {
		const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
			headers: {
				host: siteHost(site),
				accept: path === '/' ? 'text/html' : '*/*',
				'accept-encoding': 'gzip',
			},
			decompress: false,
			signal: AbortSignal.timeout(60_000),
		})
		recordResponse(`${site}${path}`, responseDigest(response, await response.arrayBuffer()))
		requestsServed++
		statusCounts.set(response.status, (statusCounts.get(response.status) ?? 0) + 1)
	}
}

async function runPass(order: number[]): Promise<void> {
	let next = 0
	await Promise.all(
		Array.from({ length: CONCURRENCY }, async () => {
			while (next < order.length) {
				const site = order[next++]
				if (site !== undefined) await visit(site)
			}
		}),
	)
}

const scratch = mkdtempSync(join(tmpdir(), 'wisp-hosting-memory-bench-'))
const cacheDir = join(scratch, 'sites')
const poolFile = join(scratch, 'pool.json')
const pool = buildObjectPool(SITES)
await seedObjects(cacheDir, pool)
writeFileSync(
	poolFile,
	JSON.stringify(
		Object.fromEntries(
			Object.entries(pool).map(([kind, objects]) => [kind, objects.map(({ cid, key }) => ({ cid, key }))]),
		),
	),
)

const server = Bun.spawn([process.execPath, '--preload', './scripts/memory-bench-preload.ts', 'src/index.ts'], {
	cwd: join(import.meta.dir, '..'),
	env: {
		...process.env,
		NODE_ENV: 'production',
		HOSTING_ALLOW_DISK_SOURCE: 'true',
		CACHE_DIR: cacheDir,
		PORT: String(PORT),
		BASE_HOST: BENCH_BASE_HOST,
		BENCH_POOL_FILE: poolFile,
		BENCH_SITES: String(SITES),
		BENCH_CONTROL_PORT: String(PORT + 1),
		REDIS_URL: '',
		S3_BUCKET: '',
		PRIVATE_S3_BUCKET: '',
		GRAFANA_LOKI_URL: '',
		GRAFANA_PROMETHEUS_URL: '',
	},
	stdout: 'ignore',
	stderr: 'inherit',
})

function sample(): Promise<Sample> {
	return fetch(`http://127.0.0.1:${PORT + 1}/`).then((response) => response.json() as Promise<Sample>)
}

async function waitForServer(): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			if ((await fetch(`http://127.0.0.1:${PORT}/live`)).ok) return
		} catch {}
		await Bun.sleep(50)
	}
	throw new Error('hosting did not start')
}

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
const rows: Array<[string, Sample, number]> = []
function record(label: string, value: Sample): void {
	rows.push([label, value, requestsServed])
	console.error(`${label}: ${requestsServed} requests, rss ${mib(value.rss)} MiB`)
}

try {
	await waitForServer()
	record('started', await sample())
	await runPass(passOrder(0))
	record('after warmup', await sample())
	for (let pass = 1; pass <= PASSES; pass++) await runPass(passOrder(pass))
	record('steady state', await sample())
	if (IDLE_SECONDS > 0) {
		await Bun.sleep(IDLE_SECONDS * 1000)
		record(`idle ${IDLE_SECONDS}s`, await sample())
	}
} finally {
	server.kill('SIGTERM')
	await server.exited
	rmSync(scratch, { recursive: true, force: true })
}

console.log(
	`bun ${Bun.version}, ${SITES} sites, ${PASSES} steady passes, concurrency ${CONCURRENCY}, statuses ${JSON.stringify(Object.fromEntries(statusCounts))}`,
)
console.log(
	`responses: ${responseDigests.size} distinct requests, digest ${corpusDigest()}, ${changedResponses} changed between passes`,
)
console.log(
	'| phase | requests | RSS MiB | JS heap MiB | ArrayBuffers MiB | manifests (est. MiB) | hot items (MiB) | log/metric ring |',
)
console.log('|---|---|---|---|---|---|---|---|')
for (const [label, value, requests] of rows) {
	console.log(
		`| ${label} | ${requests} | ${mib(value.rss)} | ${mib(value.heapSize)} | ${mib(value.arrayBuffers)} | ${value.siteCacheEntries} (${mib(value.siteCacheBytes)}) | ${value.hotItems} (${mib(value.hotBytes)}) | ${value.logRing}/${value.metricRing} |`,
	)
}
