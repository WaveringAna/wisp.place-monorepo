/**
 * Process and container memory gauges, read when the metric reader collects:
 * nothing runs per request and no timer of its own. Every label is the closed
 * `kind` set below; the service and instance come from the OTel resource.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Meter } from '@opentelemetry/api'

export const PROCESS_MEMORY_KINDS = ['rss', 'heap_used', 'heap_total', 'external', 'array_buffers'] as const
export const CGROUP_MEMORY_KINDS = ['current', 'anon', 'file', 'shmem', 'swap', 'peak', 'limit'] as const

export type ProcessMemoryKind = (typeof PROCESS_MEMORY_KINDS)[number]
export type CgroupMemoryKind = (typeof CGROUP_MEMORY_KINDS)[number]
export type CgroupMemory = Partial<Record<CgroupMemoryKind, number>>

export type ProcessMemoryOptions = {
	/** cgroup v2 directory of this container; tests point it at fixtures. */
	cgroupRoot?: string
	memoryUsage?: () => NodeJS.MemoryUsage
	uptime?: () => number
}

const DEFAULT_CGROUP_ROOT = '/sys/fs/cgroup'
const STAT_KINDS = ['anon', 'file', 'shmem'] as const

function readText(root: string, file: string): string | undefined {
	try {
		return readFileSync(join(root, file), 'utf8')
	} catch {
		return undefined
	}
}

/** A non-negative integer byte count; `max`, blanks and garbage are undefined. */
function parseBytes(text: string | undefined): number | undefined {
	const trimmed = text?.trim()
	if (!trimmed || !/^\d+$/.test(trimmed)) return undefined
	return Number(trimmed)
}

function parseStat(text: string | undefined): Map<string, number> {
	const entries = new Map<string, number>()
	for (const line of text?.split('\n') ?? []) {
		const [key, value, ...rest] = line.trim().split(/\s+/)
		const bytes = rest.length === 0 ? parseBytes(value) : undefined
		if (key && bytes !== undefined) entries.set(key, bytes)
	}
	return entries
}

/**
 * Reads the cgroup v2 memory files under `root`. Missing, unreadable or
 * malformed files (macOS, cgroup v1, a vanished container) leave their kind
 * out; this never throws.
 */
export function readCgroupMemory(root: string = DEFAULT_CGROUP_ROOT): CgroupMemory {
	const stat = parseStat(readText(root, 'memory.stat'))
	const values: CgroupMemory = {
		current: parseBytes(readText(root, 'memory.current')),
		swap: parseBytes(readText(root, 'memory.swap.current')),
		peak: parseBytes(readText(root, 'memory.peak')),
		limit: parseBytes(readText(root, 'memory.max')),
	}
	for (const kind of STAT_KINDS) values[kind] = stat.get(kind)
	return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}

function processMemory(usage: NodeJS.MemoryUsage): Record<ProcessMemoryKind, number> {
	return {
		rss: usage.rss,
		heap_used: usage.heapUsed,
		heap_total: usage.heapTotal,
		external: usage.external,
		array_buffers: usage.arrayBuffers,
	}
}

/**
 * Registers `process_memory_bytes{kind}`, `process_uptime_seconds` and
 * `cgroup_memory_bytes{kind}`. At most 5 + 1 + 7 series per instance.
 */
export function createProcessMemoryInstruments(meter: Meter, options: ProcessMemoryOptions = {}): void {
	const cgroupRoot = options.cgroupRoot ?? DEFAULT_CGROUP_ROOT
	const memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
	const uptime = options.uptime ?? (() => process.uptime())

	const processBytes = meter.createObservableGauge('process_memory_bytes', {
		description: 'Process memory from process.memoryUsage(), by kind',
		unit: 'By',
	})
	const uptimeSeconds = meter.createObservableGauge('process_uptime_seconds', {
		description: 'Seconds since the process started, to compare memory at equal uptime across restarts',
		unit: 's',
	})
	const cgroupBytes = meter.createObservableGauge('cgroup_memory_bytes', {
		description: "Container memory from this process's cgroup v2 files, by kind; limit is absent when unlimited",
		unit: 'By',
	})

	processBytes.addCallback((result) => {
		for (const [kind, bytes] of Object.entries(processMemory(memoryUsage()))) result.observe(bytes, { kind })
	})
	uptimeSeconds.addCallback((result) => {
		result.observe(uptime())
	})
	cgroupBytes.addCallback((result) => {
		for (const [kind, bytes] of Object.entries(readCgroupMemory(cgroupRoot))) result.observe(bytes, { kind })
	})
}
