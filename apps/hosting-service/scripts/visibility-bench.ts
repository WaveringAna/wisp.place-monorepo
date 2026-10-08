#!/usr/bin/env bun
/**
 * Cost of hosting's latency and 404 visibility (src/lib/request-visibility.ts).
 *
 * Runs the same Hono stack hosting uses (cors, observability middleware, a
 * site handler) with and without the visibility middleware, with the OTLP
 * metrics exporter enabled as in production but never flushed, and reports:
 *
 * - ns per request for a served page and for an unknown-host 404;
 * - ns per call of the recording step alone;
 * - heap and RSS after a 404 flood where every request names a new host.
 *
 *   bun apps/hosting-service/scripts/visibility-bench.ts [--requests 200000] [--flood 1000000] [--runs 3]
 *
 * Prints one JSON object; medians are over --runs, variants interleaved.
 */
import { parseArgs } from 'node:util'
import { initializeGrafanaExporters, metricsCollector, setInMemoryRetention } from '@wispplace/observability'
import { observabilityMiddleware } from '@wispplace/observability/middleware/hono'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createNotFoundLog } from '../src/lib/not-found-log'
import { hostingResponseEntry, requestVisibility, tagNotFound } from '../src/lib/request-visibility'

const { values: options } = parseArgs({
	options: {
		requests: { type: 'string', default: '200000' },
		flood: { type: 'string', default: '1000000' },
		runs: { type: 'string', default: '3' },
	},
})
const REQUESTS = Number(options.requests)
const FLOOD = Number(options.flood)
const RUNS = Number(options.runs)

setInMemoryRetention({ logs: 0, metrics: 0 })
// Enabled exporter so every record reaches a real OTel instrument; the flush never fires.
initializeGrafanaExporters({ prometheusUrl: 'http://127.0.0.1:9', flushIntervalMs: 86_400_000, serviceName: 'bench' })

const PAGE = '<!doctype html><h1>hello</h1>'
const notFoundLog = createNotFoundLog({ emit: () => {} })

function buildApp(visible: boolean): Hono {
	const app = new Hono()
	app.use('*', cors({ origin: '*', allowMethods: ['GET', 'HEAD', 'OPTIONS'], credentials: false }))
	app.use('*', observabilityMiddleware('hosting-service'))
	if (visible) {
		app.use(
			'*',
			requestVisibility({
				recordNotFound: (reason, host) => {
					metricsCollector.recordHostingNotFound(reason)
					notFoundLog.record(reason, host)
				},
			}),
		)
	}
	app.get('/*', (c) => {
		if (new URL(c.req.url).hostname.startsWith('missing-')) {
			if (visible) tagNotFound(c.req.raw, 'unknown-custom-domain')
			return c.text('Custom domain not found or not verified', 404)
		}
		return new Response(PAGE, { headers: { 'Content-Type': 'text/html', 'X-Cache-Tier': 'hot' } })
	})
	return app
}

const apps = { base: buildApp(false), visibility: buildApp(true) }
type Variant = keyof typeof apps

async function nsPerRequest(app: Hono, url: (i: number) => string, count: number): Promise<number> {
	const started = Bun.nanoseconds()
	for (let i = 0; i < count; i++) await app.fetch(new Request(url(i)))
	return (Bun.nanoseconds() - started) / count
}

function nsPerRecord(count: number): number {
	const response = new Response(PAGE, { headers: { 'Content-Type': 'text/html', 'X-Cache-Tier': 'hot' } })
	const started = Bun.nanoseconds()
	for (let i = 0; i < count; i++) {
		const entry = hostingResponseEntry(response, 1.5)
		if (entry) metricsCollector.recordHostingResponse(entry)
	}
	return (Bun.nanoseconds() - started) / count
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN
const round = (value: number) => Math.round(value)
const mib = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10

function memory() {
	Bun.gc(true)
	const { heapUsed, rss } = process.memoryUsage()
	return { heapUsed, rss }
}

async function flood(variant: Variant, run: number) {
	notFoundLog.flush()
	const before = memory()
	await nsPerRequest(apps[variant], (i) => `https://missing-${run}-${i}.flood.example/wp-login.php?i=${i}`, FLOOD)
	const after = memory()
	const trackedHosts = notFoundLog.trackedHosts()
	notFoundLog.flush()
	return { heapGrowth: after.heapUsed - before.heapUsed, rss: after.rss, trackedHosts }
}

const page = (i: number) => `https://site.example/index.html?i=${i % 64}`
const missing = (i: number) => `https://missing-${i}.example/`
for (const app of Object.values(apps)) {
	await nsPerRequest(app, page, 20_000)
	await nsPerRequest(app, missing, 20_000)
}
nsPerRecord(100_000)

const samples: Record<string, number[]> = {}
const sample = (name: string, value: number) => {
	samples[name] ??= []
	samples[name].push(value)
}
for (let run = 0; run < RUNS; run++) {
	for (const variant of Object.keys(apps) as Variant[]) {
		sample(`${variant}.pageNs`, await nsPerRequest(apps[variant], page, REQUESTS))
		sample(`${variant}.notFoundNs`, await nsPerRequest(apps[variant], missing, REQUESTS))
		notFoundLog.flush()
	}
	sample('recordNs', nsPerRecord(REQUESTS * 5))
	for (const variant of Object.keys(apps) as Variant[]) {
		const result = await flood(variant, run)
		sample(`${variant}.floodHeapGrowthMiB`, mib(result.heapGrowth))
		sample(`${variant}.floodRssMiB`, mib(result.rss))
		sample(`${variant}.floodTrackedHosts`, result.trackedHosts)
	}
}

const medians = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, median(values)]))
const pageDelta = (medians['visibility.pageNs'] ?? 0) - (medians['base.pageNs'] ?? 0)
const notFoundDelta = (medians['visibility.notFoundNs'] ?? 0) - (medians['base.notFoundNs'] ?? 0)
console.log(
	JSON.stringify(
		{
			bun: Bun.version,
			requests: REQUESTS,
			flood: FLOOD,
			runs: RUNS,
			medians: Object.fromEntries(Object.entries(medians).map(([name, value]) => [name, round(value * 10) / 10])),
			overheadNs: { page: round(pageDelta), notFound: round(notFoundDelta) },
			samples,
		},
		null,
		2,
	),
)
process.exit(0)
