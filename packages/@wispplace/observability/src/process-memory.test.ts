import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AggregationTemporality, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics'
import {
	CGROUP_MEMORY_KINDS,
	createProcessMemoryInstruments,
	PROCESS_MEMORY_KINDS,
	type ProcessMemoryOptions,
	readCgroupMemory,
} from './process-memory'

class CollectingReader extends MetricReader {
	constructor(temporality: AggregationTemporality) {
		super({ aggregationTemporalitySelector: () => temporality })
	}
	protected async onShutdown(): Promise<void> {}
	protected async onForceFlush(): Promise<void> {}
}

const USAGE: NodeJS.MemoryUsage = {
	rss: 210_000_000,
	heapUsed: 48_000_000,
	heapTotal: 64_000_000,
	external: 9_000_000,
	arrayBuffers: 3_000_000,
}

const STAT = ['anon 150000000', 'file 40000000', 'kernel 1000000', 'shmem 4096', 'file_mapped 2000000', ''].join('\n')

const roots: string[] = []

function cgroupFixture(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'wisp-cgroup-'))
	roots.push(root)
	for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
	return root
}

function fullCgroup(max = '536870912\n'): string {
	return cgroupFixture({
		'memory.current': '200000000\n',
		'memory.stat': STAT,
		'memory.swap.current': '0\n',
		'memory.peak': '260000000\n',
		'memory.max': max,
	})
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function byKind(points: { attributes: Record<string, unknown>; value: unknown }[] | undefined) {
	return Object.fromEntries((points ?? []).map((point) => [point.attributes.kind, point.value]))
}

async function collector(options: ProcessMemoryOptions, temporality = AggregationTemporality.CUMULATIVE) {
	const reader = new CollectingReader(temporality)
	const provider = new MeterProvider({ readers: [reader] })
	createProcessMemoryInstruments(provider.getMeter('process-memory-test'), options)
	const collect = async () => {
		const { resourceMetrics, errors } = await reader.collect()
		expect(errors).toEqual([])
		return Object.fromEntries(
			resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).map((metric) => [metric.descriptor.name, metric]),
		)
	}
	return { collect, shutdown: () => provider.shutdown() }
}

describe('readCgroupMemory', () => {
	test('reads cgroup v2 current, stat, swap, peak and limit', () => {
		expect(readCgroupMemory(fullCgroup())).toEqual({
			current: 200_000_000,
			anon: 150_000_000,
			file: 40_000_000,
			shmem: 4096,
			swap: 0,
			peak: 260_000_000,
			limit: 536_870_912,
		})
	})

	test('an unlimited container (memory.max = max) has no limit kind', () => {
		const memory = readCgroupMemory(fullCgroup('max\n'))
		expect(memory.limit).toBeUndefined()
		expect(memory.current).toBe(200_000_000)
	})

	test('missing files leave their kinds out, a missing root yields nothing', () => {
		expect(readCgroupMemory(cgroupFixture({ 'memory.current': '123\n' }))).toEqual({ current: 123 })
		expect(readCgroupMemory(join(tmpdir(), 'wisp-cgroup-does-not-exist'))).toEqual({})
	})

	test('malformed memory.stat lines and values are skipped', () => {
		const root = cgroupFixture({
			'memory.current': 'garbage\n',
			'memory.stat': ['anon', 'file -5', 'shmem 12 extra', 'anon 1e9', 'file 777', '\u0000\u0001'].join('\n'),
		})
		expect(readCgroupMemory(root)).toEqual({ file: 777 })
	})
})

describe('process memory instruments', () => {
	test('gauges report process.memoryUsage, uptime and the cgroup files', async () => {
		const { collect, shutdown } = await collector({
			memoryUsage: () => USAGE,
			uptime: () => 3600.5,
			cgroupRoot: fullCgroup(),
		})
		const metrics = await collect()
		await shutdown()

		expect(byKind(metrics.process_memory_bytes?.dataPoints)).toEqual({
			rss: 210_000_000,
			heap_used: 48_000_000,
			heap_total: 64_000_000,
			external: 9_000_000,
			array_buffers: 3_000_000,
		})
		expect(metrics.process_uptime_seconds?.dataPoints.map((point) => point.value)).toEqual([3600.5])
		expect(byKind(metrics.cgroup_memory_bytes?.dataPoints)).toEqual({
			current: 200_000_000,
			anon: 150_000_000,
			file: 40_000_000,
			shmem: 4096,
			swap: 0,
			peak: 260_000_000,
			limit: 536_870_912,
		})
		expect(metrics.process_memory_bytes?.descriptor.unit).toBe('By')
		expect(metrics.process_uptime_seconds?.descriptor.unit).toBe('s')
	})

	test('labels are exactly the closed kind set however often it is collected', async () => {
		const { collect, shutdown } = await collector({ cgroupRoot: fullCgroup() })
		for (let i = 0; i < 50; i++) await collect()
		const metrics = await collect()
		await shutdown()

		const processPoints = metrics.process_memory_bytes?.dataPoints ?? []
		const cgroupPoints = metrics.cgroup_memory_bytes?.dataPoints ?? []
		expect(processPoints.map((point) => point.attributes.kind).sort()).toEqual([...PROCESS_MEMORY_KINDS].sort())
		expect(cgroupPoints.map((point) => point.attributes.kind).sort()).toEqual([...CGROUP_MEMORY_KINDS].sort())
		for (const point of [...processPoints, ...cgroupPoints]) expect(Object.keys(point.attributes)).toEqual(['kind'])
		for (const point of metrics.process_uptime_seconds?.dataPoints ?? []) expect(point.attributes).toEqual({})
	})

	// A cumulative reader repeats the last observation of a kind that stopped
	// reporting (SDK behaviour); delta shows what the callback itself observed.
	test('cgroup files vanishing between collections stop observations without throwing', async () => {
		const root = fullCgroup()
		const { collect, shutdown } = await collector(
			{ memoryUsage: () => USAGE, cgroupRoot: root },
			AggregationTemporality.DELTA,
		)
		expect((await collect()).cgroup_memory_bytes?.dataPoints).toHaveLength(CGROUP_MEMORY_KINDS.length)
		rmSync(root, { recursive: true, force: true })
		const after = await collect()
		await shutdown()

		expect(after.cgroup_memory_bytes?.dataPoints ?? []).toHaveLength(0)
		expect(after.process_memory_bytes?.dataPoints).toHaveLength(PROCESS_MEMORY_KINDS.length)
	})

	test('defaults read this process without throwing where there is no cgroup v2', async () => {
		const { collect, shutdown } = await collector({})
		const metrics = await collect()
		await shutdown()

		const rss = byKind(metrics.process_memory_bytes?.dataPoints).rss
		expect(typeof rss).toBe('number')
		expect(rss as number).toBeGreaterThan(0)
		expect(metrics.process_uptime_seconds?.dataPoints[0]?.value as number).toBeGreaterThan(0)
	})
})
