import { createLogger, type HostingNotFoundReason } from '@wispplace/observability'

/**
 * Aggregated visibility for hosting 404s.
 *
 * Each 404 is counted under its reason and the public host (or shared-site
 * key) it asked for, and one summary line per reason is logged when the window
 * flushes, naming the busiest hosts. Distinct hosts per reason are capped, so
 * a scanner sending random Host headers cannot grow memory: once a reason is
 * full, further new hosts are only counted as `untracked`. Lines never carry
 * paths, query strings or client addresses.
 */

export type NotFoundSummary = {
	reason: HostingNotFoundReason
	count: number
	hosts: number
	untracked: number
	top: Array<{ host: string; count: number }>
	firstAt: string
	lastAt: string
}

type Bucket = { count: number; hosts: Map<string, number>; untracked: number; firstAt: number; lastAt: number }

export type NotFoundLogOptions = {
	maxHostsPerReason?: number
	topHosts?: number
	windowMs?: number
	emit?: (summary: NotFoundSummary) => void
	now?: () => number
}

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_HOSTS_PER_REASON = 256
const DEFAULT_TOP_HOSTS = 5
const MAX_HOST_LENGTH = 80
const IP_LITERAL_HOST = 'ip-literal'
const IPV4_HOST_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/
const UNSAFE_HOST_CHARACTERS = /[^A-Za-z0-9._:~/-]/g

const logger = createLogger('hosting-service')

function logSummary(summary: NotFoundSummary): void {
	logger.info('[NotFound] 404 summary', summary)
}

/** A public host or `host/identifier/site` key, made safe and short enough to log. */
export function notFoundHostKey(host: string): string {
	if (host.startsWith('[') || IPV4_HOST_PATTERN.test(host)) return IP_LITERAL_HOST
	return host.slice(0, MAX_HOST_LENGTH).replace(UNSAFE_HOST_CHARACTERS, '?')
}

function toSummary(reason: HostingNotFoundReason, bucket: Bucket, topHosts: number): NotFoundSummary {
	const top = [...bucket.hosts]
		.sort((a, b) => b[1] - a[1])
		.slice(0, topHosts)
		.map(([host, count]) => ({ host, count }))
	return {
		reason,
		count: bucket.count,
		hosts: bucket.hosts.size,
		untracked: bucket.untracked,
		top,
		firstAt: new Date(bucket.firstAt).toISOString(),
		lastAt: new Date(bucket.lastAt).toISOString(),
	}
}

export function createNotFoundLog(options: NotFoundLogOptions = {}) {
	const maxHosts = options.maxHostsPerReason ?? DEFAULT_MAX_HOSTS_PER_REASON
	const topHosts = options.topHosts ?? DEFAULT_TOP_HOSTS
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
	const emit = options.emit ?? logSummary
	const now = options.now ?? Date.now
	// The reason set is closed and hosts per reason are capped, so the cap bounds the whole window.
	let reasons = new Map<HostingNotFoundReason, Bucket>()
	let timer: ReturnType<typeof setInterval> | null = null

	function record(reason: HostingNotFoundReason, host: string): void {
		const at = now()
		let bucket = reasons.get(reason)
		if (!bucket) {
			bucket = { count: 0, hosts: new Map(), untracked: 0, firstAt: at, lastAt: at }
			reasons.set(reason, bucket)
		}
		bucket.count++
		bucket.lastAt = at
		const key = notFoundHostKey(host)
		const seen = bucket.hosts.get(key)
		if (seen !== undefined) bucket.hosts.set(key, seen + 1)
		else if (bucket.hosts.size < maxHosts) bucket.hosts.set(key, 1)
		else bucket.untracked++
	}

	/** Emit one line per reason seen since the last flush and start a new window. */
	function flush(): number {
		const finished = reasons
		reasons = new Map()
		for (const [reason, bucket] of finished) emit(toSummary(reason, bucket, topHosts))
		return finished.size
	}

	function start(): void {
		if (timer) return
		timer = setInterval(flush, windowMs)
		// Visibility must never keep the process alive.
		timer.unref?.()
	}

	function stop(): number {
		if (timer) clearInterval(timer)
		timer = null
		return flush()
	}

	function trackedHosts(): number {
		let total = 0
		for (const bucket of reasons.values()) total += bucket.hosts.size
		return total
	}

	return { record, flush, start, stop, trackedHosts }
}

export const notFoundLog = createNotFoundLog()
