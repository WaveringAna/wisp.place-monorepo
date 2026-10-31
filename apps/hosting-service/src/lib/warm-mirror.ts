import type { SiteCache } from '@wispplace/database'
import { createLogger, type HostingWarmMirrorOutcome, metricsCollector } from '@wispplace/observability'
import type { StreamResult } from '@wispplace/tiered-storage'
import { isSiteUpdating, setSiteUpdatedListener } from './cache-invalidation'
import { listSiteCachePage, readSiteCache } from './db'
import { disposeFileStream } from './file-streams'
import { buildSiteManifest, resolveStorageKey, type SiteManifest } from './site-storage-keys'
import { siteVisits } from './site-visits'
import { getWarmTierUsage, isStorageUnavailableError, storage, warmTier } from './storage'
import { takedowns } from './takedowns'

const logger = createLogger('warm-mirror')

const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 16
const DEFAULT_FILL_PERCENT = 80
const MAX_FILL_PERCENT = 95
const SITE_PAGE_SIZE = 100
// Long enough for the read replica to catch up with the row the update just wrote,
// and for a burst of updates to one site to collapse into one mirror.
const UPDATE_DELAY_MS = 10_000
// After the cold tier's breaker opened or the site listing failed, run the whole pass again;
// keys already warm cost no S3 read the second time.
const RETRY_DELAY_MS = 5 * 60_000
// Visitors evict mirrored files as the warm tier fills, and new visits change what comes first;
// a daily pass puts back what fits. Keys already warm cost no S3 read.
const REPASS_DELAY_MS = 24 * 60 * 60_000
const MAX_PENDING_SITES = 10_000
const CAS_PREFIX = 'cas/'

/** Warm-mirror settings; null from {@link resolveWarmMirrorConfig} means the mirror is off. */
export interface WarmMirrorConfig {
	concurrency: number
	fillPercent: number
}

function parseBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
	const normalized = value?.trim()
	if (!normalized) return fallback
	const parsed = Number(normalized)
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

/** `WARM_MIRROR=true` turns the mirror on; anything else leaves it off. */
export function resolveWarmMirrorConfig(env: Readonly<Record<string, string | undefined>>): WarmMirrorConfig | null {
	if (env.WARM_MIRROR?.trim() !== 'true') return null
	return {
		concurrency: parseBoundedInteger(env.WARM_MIRROR_CONCURRENCY, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
		fillPercent: parseBoundedInteger(env.WARM_MIRROR_FILL_PERCENT, DEFAULT_FILL_PERCENT, 1, MAX_FILL_PERCENT),
	}
}

/**
 * The content-addressed bodies a site's manifest names. Only `cas/` keys are mirrored: their name is
 * their content, so a mirrored copy can never go stale and site invalidation has nothing to purge.
 * Per-site mutable objects (pre-rewritten HTML) stay filled on demand by visitors, as before.
 * Paths without a stored body are left to the serving path's repair.
 */
export function siteMirrorKeys(did: string, rkey: string, manifest: SiteManifest): string[] {
	const keys = new Set<string>()
	for (const [path, cid] of Object.entries(manifest.fileCids)) {
		// Serving answers a path only when its manifest CID is set.
		if (typeof cid !== 'string' || cid.length === 0) continue
		const key = resolveStorageKey(did, rkey, path, manifest.fileObjects)
		if (key?.startsWith(CAS_PREFIX)) keys.add(key)
	}
	return [...keys]
}

/**
 * The one storage read the mirror issues: a streamed read that fills warm and leaves hot alone,
 * writing the warm copy as never accessed so an LRU warm tier evicts it before visitors' files.
 */
export interface WarmMirrorStorage {
	getStream(
		key: string,
		options: { signal: AbortSignal; skipHotTier: true; background: true },
	): Promise<StreamResult | null>
}

/** Schedules one callback and returns its cancel handle; tests fire callbacks by hand. */
export type WarmMirrorScheduler = (callback: () => void, delayMs: number) => () => void

export interface WarmMirrorDependencies {
	storage: WarmMirrorStorage
	/** Whether the warm disk tier already holds the key; must not touch the cold tier. */
	warmHas(key: string): Promise<boolean>
	/** Current warm-tier fill, or null when there is no warm tier to fill. */
	warmUsage(): { usedBytes: number; maxBytes: number } | null
	listSites(afterDid: string, afterRkey: string, limit: number): Promise<SiteCache[]>
	getSite(did: string, rkey: string): Promise<SiteCache | null>
	/** Sites this edge's visitors read, most recent first; a pass mirrors these before the rest. */
	recentSites?(): Array<{ did: string; rkey: string }>
	isTakenDown(did: string, rkey: string): boolean
	isSiteUpdating(did: string, rkey: string): boolean
	record(outcome: HostingWarmMirrorOutcome, bytes: number): void
	config: WarmMirrorConfig
	schedule?: WarmMirrorScheduler
	updateDelayMs?: number
	retryDelayMs?: number
	repassDelayMs?: number
	pageSize?: number
}

export interface WarmMirror {
	/** Start the startup pass once `ready` settles (the takedown list's first load). */
	start(ready?: Promise<unknown>): void
	/** Mirror one site's current files after the update delay; repeats within it coalesce. */
	queueSite(did: string, rkey: string): void
	/** Abort in-flight work, drop queued sites, and wait for running reads to unwind. */
	stop(): Promise<void>
	/** Resolve once no pass or queued-site work is running. */
	settled(): Promise<void>
}

type PassStats = {
	sites: number
	skippedSites: number
	keys: number
	fetched: number
	alreadyWarm: number
	skipped: number
	failed: number
	bytes: number
}

type StopReason = 'budget' | 'cold-unavailable'

const scheduleRealTimer: WarmMirrorScheduler = (callback, delayMs) => {
	const timer = setTimeout(callback, delayMs)
	timer.unref?.()
	return () => clearTimeout(timer)
}

function emptyStats(): PassStats {
	return { sites: 0, skippedSites: 0, keys: 0, fetched: 0, alreadyWarm: 0, skipped: 0, failed: 0, bytes: 0 }
}

function siteKeyOf(did: string, rkey: string): string {
	return `${did}/${rkey}`
}

/**
 * Keep this edge's warm disk tier holding public sites' files, so first reads stop paying the object
 * store's cold-read latency. A pass copies each key not already on disk, sites this edge's visitors
 * read first and then the rest of `site_cache`, up to the configured share of the warm tier; it runs at
 * startup and again daily. Each site update mirrors just that site. Copies are written as never
 * accessed, so when visitors need room the warm tier's LRU evicts unread mirrored files first. Reads
 * skip the hot tier, so promotions keep its invalidation fences and memory is left to visitors.
 */
export function createWarmMirror(deps: WarmMirrorDependencies): WarmMirror {
	const {
		storage,
		warmHas,
		warmUsage,
		listSites,
		getSite,
		recentSites = () => [],
		isTakenDown,
		isSiteUpdating,
		record,
		config,
		schedule = scheduleRealTimer,
		updateDelayMs = UPDATE_DELAY_MS,
		retryDelayMs = RETRY_DELAY_MS,
		repassDelayMs = REPASS_DELAY_MS,
		pageSize = SITE_PAGE_SIZE,
	} = deps
	const abort = new AbortController()
	const pending = new Map<string, { did: string; rkey: string; dueAt: number }>()
	const slotWaiters: Array<() => void> = []
	let activeSlots = 0
	let started = false
	let stopped = false
	let budgetLogged = false
	let pass: Promise<void> | null = null
	let updates: Promise<void> | null = null
	let cancelUpdateTimer: (() => void) | null = null
	let cancelRetryTimer: (() => void) | null = null
	let cancelRepassTimer: (() => void) | null = null

	/** Shared by the pass and site updates, so together they never exceed the configured fetches. */
	async function acquireSlot(): Promise<() => void> {
		if (activeSlots >= config.concurrency) {
			await new Promise<void>((resolve) => slotWaiters.push(resolve))
		} else {
			activeSlots++
		}
		return () => {
			const next = slotWaiters.shift()
			if (next) next()
			else activeSlots--
		}
	}

	function budgetBytes(maxBytes: number): number {
		return Math.floor((maxBytes * config.fillPercent) / 100)
	}

	function hasRoomFor(size: number): boolean {
		const usage = warmUsage()
		if (!usage) return false
		const budget = budgetBytes(usage.maxBytes)
		if (usage.usedBytes + size <= budget) {
			budgetLogged = false
			return true
		}
		if (!budgetLogged) {
			budgetLogged = true
			logger.warn('Warm mirror reached its share of the warm tier; not filling further', {
				usedBytes: usage.usedBytes,
				budgetBytes: budget,
				fillPercent: config.fillPercent,
			})
		}
		return false
	}

	function count(stats: PassStats, outcome: HostingWarmMirrorOutcome, bytes = 0): void {
		if (outcome === 'fetched') stats.fetched++
		else if (outcome === 'already-warm') stats.alreadyWarm++
		else if (outcome === 'skipped') stats.skipped++
		else stats.failed++
		stats.bytes += bytes
		record(outcome, bytes)
	}

	/** Copy one key into warm unless it is already there. Never throws. */
	async function mirrorKey(key: string, stats: PassStats): Promise<StopReason | undefined> {
		const { signal } = abort
		let result: StreamResult | null = null
		try {
			// Checked apart from the read: a warm read counts as a visit and would reorder the LRU.
			if (await warmHas(key)) {
				count(stats, 'already-warm')
				return
			}
			if (!hasRoomFor(0)) return 'budget'
			result = await storage.getStream(key, { signal, skipHotTier: true, background: true })
			if (!result) {
				// Not in the object store either: serving repairs it on demand.
				count(stats, 'skipped')
				return
			}
			if (result.source !== 'cold') {
				// A visitor's read filled it between the check and this read.
				disposeFileStream(result.stream)
				count(stats, 'already-warm')
				return
			}
			if (!hasRoomFor(result.metadata.size)) {
				disposeFileStream(result.stream)
				count(stats, 'skipped')
				return 'budget'
			}
			// Draining the stream is what commits the staged warm copy; chunks are dropped as they pass.
			let bytes = 0
			for await (const chunk of result.stream) bytes += (chunk as Uint8Array).byteLength
			count(stats, 'fetched', bytes)
		} catch (error) {
			if (result) disposeFileStream(result.stream)
			if (signal.aborted) return
			count(stats, 'failed')
			logger.debug('Warm mirror could not copy a key', {
				key,
				errorName: error instanceof Error ? error.name : 'UnknownError',
			})
			// An open breaker means every read would fail; one key's failure is just that key.
			if (isStorageUnavailableError(error) && error.kind === 'circuit-open') return 'cold-unavailable'
		}
	}

	/** The keys to mirror for one row, or null when serving would not read any of them. */
	function keysForSite(row: SiteCache): string[] | null {
		if (row.absent_since !== null && row.absent_since !== undefined) return null
		if (isTakenDown(row.did, row.rkey)) return null
		// Its update event mirrors the new files once the download finishes.
		if (isSiteUpdating(row.did, row.rkey)) return null
		return siteMirrorKeys(row.did, row.rkey, buildSiteManifest(row))
	}

	/**
	 * Mirror keys with bounded concurrency until they run out or a stop reason appears. Keys already
	 * seen in `visited` are not visited again, so a CAS body shared by many sites is checked once.
	 */
	async function mirrorKeys(
		keys: Iterable<string>,
		stats: PassStats,
		visited: Set<string>,
		inFlight: Set<Promise<void>>,
		stop: { reason?: StopReason },
	): Promise<void> {
		for (const key of keys) {
			if (stop.reason || abort.signal.aborted) return
			if (visited.has(key)) continue
			visited.add(key)
			const release = await acquireSlot()
			if (stop.reason || abort.signal.aborted) {
				release()
				return
			}
			stats.keys++
			const task: Promise<void> = mirrorKey(key, stats)
				.then((reason) => {
					if (reason) stop.reason ??= reason
				})
				.finally(() => {
					release()
					inFlight.delete(task)
				})
			inFlight.add(task)
		}
	}

	async function runPass(): Promise<void> {
		const startedAt = Date.now()
		const stats = emptyStats()
		const visited = new Set<string>()
		const inFlight = new Set<Promise<void>>()
		const stop: { reason?: StopReason } = {}
		const mirroredSites = new Set<string>()
		let afterDid = ''
		let afterRkey = ''
		let listFailed = false
		try {
			// Sites this edge's visitors read go first, so a warm tier too small for every site
			// holds the ones people here actually open.
			for (const { did, rkey } of recentSites()) {
				if (stop.reason || abort.signal.aborted) break
				const siteKey = siteKeyOf(did, rkey)
				if (mirroredSites.has(siteKey)) continue
				mirroredSites.add(siteKey)
				const row = await getSite(did, rkey)
				const keys = row ? keysForSite(row) : null
				if (keys === null) {
					stats.skippedSites++
					continue
				}
				stats.sites++
				await mirrorKeys(keys, stats, visited, inFlight, stop)
			}
			while (!stop.reason && !abort.signal.aborted) {
				const rows = await listSites(afterDid, afterRkey, pageSize)
				for (const row of rows) {
					afterDid = row.did
					afterRkey = row.rkey
					if (mirroredSites.has(siteKeyOf(row.did, row.rkey))) continue
					const keys = keysForSite(row)
					if (keys === null) {
						stats.skippedSites++
						continue
					}
					stats.sites++
					await mirrorKeys(keys, stats, visited, inFlight, stop)
					if (stop.reason || abort.signal.aborted) break
				}
				if (rows.length < pageSize) break
			}
		} catch {
			// Database errors can carry connection details; the summary below says it ended early.
			listFailed = true
		}
		await Promise.all(inFlight)
		let outcome: StopReason | 'aborted' | 'database-unavailable' | 'complete' = stop.reason ?? 'complete'
		if (listFailed) outcome = 'database-unavailable'
		if (abort.signal.aborted) outcome = 'aborted'
		logger.info('Warm mirror pass finished', { outcome, ...stats, durationMs: Date.now() - startedAt })
		if (stopped || outcome === 'aborted') return
		const retry = outcome === 'cold-unavailable' || outcome === 'database-unavailable'
		const cancel = schedule(
			() => {
				if (retry) cancelRetryTimer = null
				else cancelRepassTimer = null
				startPass()
			},
			retry ? retryDelayMs : repassDelayMs,
		)
		if (retry) cancelRetryTimer = cancel
		else cancelRepassTimer = cancel
	}

	function startPass(ready?: Promise<unknown>): void {
		if (stopped || pass) return
		pass = (async () => {
			await Promise.resolve(ready).catch(() => undefined)
			if (!stopped) await runPass()
		})().finally(() => {
			pass = null
		})
	}

	function scheduleUpdates(): void {
		if (stopped || cancelUpdateTimer || updates || pending.size === 0) return
		let dueAt = Number.POSITIVE_INFINITY
		for (const entry of pending.values()) dueAt = Math.min(dueAt, entry.dueAt)
		cancelUpdateTimer = schedule(
			() => {
				cancelUpdateTimer = null
				updates = runUpdates().finally(() => {
					updates = null
					scheduleUpdates()
				})
			},
			Math.max(0, dueAt - Date.now()),
		)
	}

	async function runUpdates(): Promise<void> {
		const now = Date.now()
		const due = [...pending.values()].filter((entry) => entry.dueAt <= now)
		for (const { did, rkey } of due) {
			if (stopped) return
			const siteKey = siteKeyOf(did, rkey)
			// Another event for the site while earlier ones ran pushed it back; it waits its own delay.
			const current = pending.get(siteKey)
			if (!current || current.dueAt > Date.now()) continue
			if (isSiteUpdating(did, rkey)) {
				pending.set(siteKey, { did, rkey, dueAt: Date.now() + updateDelayMs })
				continue
			}
			pending.delete(siteKey)
			const startedAt = Date.now()
			const stats = emptyStats()
			const inFlight = new Set<Promise<void>>()
			const stop: { reason?: StopReason } = {}
			try {
				const row = await getSite(did, rkey)
				const keys = row ? keysForSite(row) : null
				if (keys === null) continue
				stats.sites = 1
				await mirrorKeys(keys, stats, new Set(), inFlight, stop)
			} catch {
				logger.warn('Warm mirror could not load an updated site', { did, rkey })
			}
			await Promise.all(inFlight)
			logger.info('Warm mirror site update finished', {
				did,
				rkey,
				outcome: stop.reason ?? 'complete',
				...stats,
				durationMs: Date.now() - startedAt,
			})
		}
	}

	async function settled(): Promise<void> {
		while (pass || updates) await Promise.all([pass, updates])
	}

	return {
		start(ready) {
			if (started) return
			started = true
			startPass(ready)
		},
		queueSite(did, rkey) {
			if (stopped) return
			const siteKey = siteKeyOf(did, rkey)
			pending.delete(siteKey)
			pending.set(siteKey, { did, rkey, dueAt: Date.now() + updateDelayMs })
			while (pending.size > MAX_PENDING_SITES) {
				const oldest = pending.keys().next().value
				if (oldest === undefined) break
				pending.delete(oldest)
			}
			scheduleUpdates()
		},
		async stop() {
			stopped = true
			abort.abort()
			cancelUpdateTimer?.()
			cancelRetryTimer?.()
			cancelRepassTimer?.()
			cancelUpdateTimer = null
			cancelRetryTimer = null
			cancelRepassTimer = null
			pending.clear()
			await settled()
		},
		settled,
	}
}

/**
 * Start the process's warm mirror when `WARM_MIRROR=true` and there is a warm tier to fill; otherwise
 * nothing is created, scheduled or registered.
 */
export function startWarmMirror(
	env: Readonly<Record<string, string | undefined>>,
	ready?: Promise<unknown>,
): WarmMirror | null {
	const config = resolveWarmMirrorConfig(env)
	if (!config) return null
	const warm = warmTier
	if (!warm || !getWarmTierUsage()) {
		logger.warn('WARM_MIRROR needs an object-store cold tier with a warm disk tier; leaving it off')
		return null
	}
	const mirror = createWarmMirror({
		storage,
		warmHas: (key) => warm.exists(key),
		warmUsage: getWarmTierUsage,
		listSites: listSiteCachePage,
		// Uncached: a replica row read early must not become the lookup cache's copy for serving.
		getSite: readSiteCache,
		recentSites: siteVisits.recent,
		isTakenDown: takedowns.isTakenDown,
		isSiteUpdating,
		record: metricsCollector.recordHostingWarmMirror,
		config,
	})
	setSiteUpdatedListener(mirror.queueSite)
	logger.info('Warm mirror enabled', { ...config })
	mirror.start(ready)
	return mirror
}
