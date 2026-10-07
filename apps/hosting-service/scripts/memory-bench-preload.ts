/**
 * Preloaded into the hosting process by scripts/memory-bench.ts.
 *
 * Replaces the postgres driver with an in-memory fake that answers the three
 * public lookups hosting makes, and serves a memory sample taken after a full
 * GC on BENCH_CONTROL_PORT.
 */

import { heapStats } from 'bun:jsc'
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { type ObjectPool, siteCacheRow, siteDid, siteFromHost, siteRkey } from './memory-bench-fixtures'

const poolFile = process.env.BENCH_POOL_FILE
if (!poolFile) throw new Error('BENCH_POOL_FILE is required')
const pool = JSON.parse(readFileSync(poolFile, 'utf8')) as ObjectPool
const siteCount = Number(process.env.BENCH_SITES)

function siteOf(did: unknown, rkey: unknown): number | null {
	if (typeof rkey !== 'string' || !rkey.startsWith('site-')) return null
	const site = Number(rkey.slice('site-'.length))
	return Number.isSafeInteger(site) && site < siteCount && did === siteDid(site) && rkey === siteRkey(site)
		? site
		: null
}

function answer(query: string, values: unknown[]): unknown[] {
	if (query.includes('FROM domains')) {
		const site = typeof values[0] === 'string' ? siteFromHost(values[0]) : null
		return site !== null && site < siteCount ? [{ did: siteDid(site), rkey: siteRkey(site) }] : []
	}
	if (query.includes('FROM site_cache')) {
		const site = siteOf(values[0], values[1])
		// Round-trip through JSON so every query returns fresh strings, as the driver's jsonb parsing does.
		return site === null ? [] : [JSON.parse(JSON.stringify(siteCacheRow(site, pool)))]
	}
	return []
}

function fakePostgres() {
	const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
		Promise.resolve(answer(strings.join('?'), values))
	return Object.assign(sql, { end: async () => {} })
}

mock.module('postgres', () => ({ default: fakePostgres }))

async function takeSample() {
	const { cache } = await import('../src/lib/cache-manager')
	const { hotTier } = await import('../src/lib/storage')
	const { logCollector, metricsCollector } = await import('@wispplace/observability')
	const siteCache = cache.getStats().siteCache
	// The inner tier reports without the TTL wrapper's pruning side effects.
	const hot = await hotTier.inner.getStats()
	Bun.gc(true)
	const memory = process.memoryUsage()
	return {
		rss: memory.rss,
		heapSize: heapStats().heapSize,
		arrayBuffers: memory.arrayBuffers,
		siteCacheEntries: siteCache.entries,
		siteCacheBytes: siteCache.sizeBytes,
		hotItems: hot.items,
		hotBytes: hot.bytes,
		logRing: logCollector.getLogs({ limit: Number.MAX_SAFE_INTEGER }).length,
		metricRing: metricsCollector.getMetrics().length,
	}
}

Bun.serve({
	hostname: '127.0.0.1',
	port: Number(process.env.BENCH_CONTROL_PORT),
	fetch: async () => Response.json(await takeSample()),
})
