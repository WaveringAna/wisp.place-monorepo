import type { FileObjects } from '@wispplace/fs-utils'
import { createLogger } from '@wispplace/observability'
import { resolveStorageKey } from './site-storage-keys'
import { storage } from './storage'

const logger = createLogger('html-prewarm')

const MAX_HTML_PREWARM_KEYS = 1_000
const MAX_PREWARMED_SITES = 1_000
const MAX_CONCURRENT_PREWARMS = 2

/** The one storage read a warmup needs: an eager-promoting buffered read. */
export interface HtmlPrewarmStorage {
	getWithMetadata(key: string, options: { borrowData: true }): Promise<unknown>
}

export interface HtmlPrewarmDependencies {
	storage: HtmlPrewarmStorage
}

/** Per-host warmup bookkeeping, built once for the process by the module-level instance. */
export interface HtmlPrewarm {
	trigger(
		did: string,
		rkey: string,
		manifestPaths?: readonly string[] | (() => readonly string[]),
		fileObjects?: FileObjects | null,
	): void
	resetSite(did: string, rkey: string): void
	/** Reset all local prewarm state after a broad cache recovery. */
	resetAll(): void
	/** Resolve once the site's in-flight warmup, if any, has finished. */
	settled(did: string, rkey: string): Promise<void>
}

function getSiteKey(did: string, rkey: string): string {
	return `${did}/${rkey}`
}

function isHtmlStorageKey(key: string): boolean {
	const normalized = key.toLowerCase()
	return normalized.endsWith('.html') || normalized.endsWith('.htm')
}

function isPrewarmEligiblePath(path: string): boolean {
	const normalized = (path.startsWith('/') ? path.slice(1) : path).toLowerCase()
	return (
		!normalized.startsWith('.rewritten/') && !normalized.endsWith('.metadata.json') && !normalized.endsWith('.meta')
	)
}

export function createHtmlPrewarm({ storage }: HtmlPrewarmDependencies): HtmlPrewarm {
	const warmedSites = new Set<string>()
	const prewarmInFlight = new Map<string, { promise: Promise<void> }>()
	let activePrewarmCount = 0
	let prewarmEpoch = 0

	/** Keep FIFO per-site warmup bookkeeping bounded as sites rotate through the host. */
	function enforcePrewarmStateLimit(): void {
		while (warmedSites.size > MAX_PREWARMED_SITES) {
			const oldestSite = warmedSites.values().next().value
			if (oldestSite === undefined) return
			warmedSites.delete(oldestSite)
		}
	}

	async function loadSiteHtmlKeysIntoHotTier(
		did: string,
		rkey: string,
		manifestPaths: readonly string[],
		fileObjects: FileObjects | null,
	): Promise<{ scannedKeys: number; warmedHtmlKeys: number; failedKeys: number }> {
		const htmlKeys = new Set<string>()
		for (const manifestPath of manifestPaths) {
			if (htmlKeys.size >= MAX_HTML_PREWARM_KEYS) break
			if (typeof manifestPath !== 'string' || !isPrewarmEligiblePath(manifestPath)) continue
			const normalizedPath = manifestPath.startsWith('/') ? manifestPath.slice(1) : manifestPath
			if (!isHtmlStorageKey(normalizedPath)) continue
			const key = resolveStorageKey(did, rkey, normalizedPath, fileObjects)
			if (key !== null) htmlKeys.add(key)
		}

		let warmedHtmlKeys = 0
		let failedKeys = 0
		for (const key of htmlKeys) {
			// Isolate each key: one unreadable entry (e.g. a concurrent invalidation removing it
			// mid-warmup) must not abandon the rest of the site's HTML.
			try {
				// getWithMetadata uses eager promotion and moves the key into hot tier.
				const result = await storage.getWithMetadata(key, { borrowData: true })
				if (result) warmedHtmlKeys++
			} catch (err) {
				failedKeys++
				logger.debug(`HTML prewarm skipped ${key}`, { error: err })
			}
		}

		return { scannedKeys: htmlKeys.size, warmedHtmlKeys, failedKeys }
	}

	function trigger(
		did: string,
		rkey: string,
		manifestPaths?: readonly string[] | (() => readonly string[]),
		fileObjects: FileObjects | null = null,
	): void {
		const siteKey = getSiteKey(did, rkey)
		// A manifest is authoritative and already loaded on the request path. Legacy
		// callers without one intentionally do nothing: never start an unbounded cold
		// LIST as a side effect of a request.
		if (!manifestPaths || warmedSites.has(siteKey)) return

		const epoch = prewarmEpoch
		const existing = prewarmInFlight.get(siteKey)
		if (existing || activePrewarmCount >= MAX_CONCURRENT_PREWARMS) return
		// Every request of a site calls this, and listing a large manifest costs more than the request
		// itself: the list is only built here, once a warmup is actually going to start.
		const paths = typeof manifestPaths === 'function' ? manifestPaths() : manifestPaths
		activePrewarmCount++

		const entry: { promise: Promise<void> } = {
			promise: Promise.resolve().then(async () => {
				try {
					const { scannedKeys, warmedHtmlKeys, failedKeys } = await loadSiteHtmlKeysIntoHotTier(
						did,
						rkey,
						paths,
						fileObjects,
					)
					if (prewarmEpoch !== epoch || prewarmInFlight.get(siteKey) !== entry) return

					// Remember a completed warmup even when there are no matching keys so repeated
					// requests for the same site do not repeat manifest-backed reads. Individually
					// skipped keys are re-fetched on demand by the normal serving path.
					warmedSites.add(siteKey)
					enforcePrewarmStateLimit()

					logger.debug(`HTML prewarm finished for ${did}/${rkey}`, {
						scannedKeys,
						warmedHtmlKeys,
						failedKeys,
					})
				} catch (err) {
					logger.warn(`HTML prewarm failed for ${did}/${rkey}`, { error: err })
				}
			}),
		}

		prewarmInFlight.set(siteKey, entry)
		entry.promise.finally(() => {
			activePrewarmCount--
			const current = prewarmInFlight.get(siteKey)
			if (current === entry) {
				prewarmInFlight.delete(siteKey)
			}
		})
	}

	function resetSite(did: string, rkey: string): void {
		const siteKey = getSiteKey(did, rkey)
		warmedSites.delete(siteKey)
		prewarmInFlight.delete(siteKey)
	}

	function resetAll(): void {
		// Fence existing background scans before forgetting their bookkeeping. A scan
		// that started before broad cache recovery must not mark stale hot data warm.
		prewarmEpoch += 1
		warmedSites.clear()
		prewarmInFlight.clear()
	}

	async function settled(did: string, rkey: string): Promise<void> {
		await prewarmInFlight.get(getSiteKey(did, rkey))?.promise
	}

	return { trigger, resetSite, resetAll, settled }
}

const htmlPrewarm = createHtmlPrewarm({ storage })

export const triggerSiteHtmlHotCacheWarmup = htmlPrewarm.trigger
export const resetSiteHtmlHotCacheWarmup = htmlPrewarm.resetSite
export const resetAllHtmlHotCacheWarmups = htmlPrewarm.resetAll
