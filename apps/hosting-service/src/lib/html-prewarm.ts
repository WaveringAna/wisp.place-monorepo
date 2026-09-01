import { createLogger } from '@wispplace/observability'
import { storage } from './storage'

const logger = createLogger('html-prewarm')

const warmedSites = new Set<string>()
const prewarmGeneration = new Map<string, number>()
const prewarmInFlight = new Map<string, { generation: number; promise: Promise<void> }>()
const MAX_HTML_PREWARM_KEYS = 1_000
let prewarmEpoch = 0

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

async function loadSiteHtmlKeysIntoHotTier(
	did: string,
	rkey: string,
	manifestPaths: readonly string[],
): Promise<{ scannedKeys: number; warmedHtmlKeys: number; failedKeys: number }> {
	const prefix = `${did}/${rkey}/`
	const htmlKeys = new Set<string>()
	for (const manifestPath of manifestPaths) {
		if (htmlKeys.size >= MAX_HTML_PREWARM_KEYS) break
		if (typeof manifestPath !== 'string' || !isPrewarmEligiblePath(manifestPath)) continue
		const normalizedPath = manifestPath.startsWith('/') ? manifestPath.slice(1) : manifestPath
		if (isHtmlStorageKey(normalizedPath)) htmlKeys.add(`${prefix}${normalizedPath}`)
	}

	let warmedHtmlKeys = 0
	let failedKeys = 0
	for (const key of htmlKeys) {
		// Isolate each key: one unreadable entry (e.g. a concurrent invalidation removing it
		// mid-warmup) must not abandon the rest of the site's HTML.
		try {
			// getWithMetadata uses eager promotion and moves the key into hot tier.
			const result = await storage.getWithMetadata(key)
			if (result) warmedHtmlKeys++
		} catch (err) {
			failedKeys++
			logger.debug(`HTML prewarm skipped ${key}`, { error: err })
		}
	}

	return { scannedKeys: htmlKeys.size, warmedHtmlKeys, failedKeys }
}

export function triggerSiteHtmlHotCacheWarmup(did: string, rkey: string, manifestPaths?: readonly string[]): void {
	const siteKey = getSiteKey(did, rkey)
	// A manifest is authoritative and already loaded on the request path. Legacy
	// callers without one intentionally do nothing: never start an unbounded cold
	// LIST as a side effect of a request.
	if (!manifestPaths || warmedSites.has(siteKey)) return

	const generation = prewarmGeneration.get(siteKey) ?? 0
	const epoch = prewarmEpoch
	const existing = prewarmInFlight.get(siteKey)
	if (existing && existing.generation === generation) return

	const entry = {
		generation,
		promise: (async () => {
			try {
				const { scannedKeys, warmedHtmlKeys, failedKeys } = await loadSiteHtmlKeysIntoHotTier(did, rkey, manifestPaths)
				const latestGeneration = prewarmGeneration.get(siteKey) ?? 0
				if (prewarmEpoch !== epoch || latestGeneration !== generation) return

				// Remember a completed warmup even when there are no matching keys so repeated
				// requests for the same site do not repeat manifest-backed reads. Individually
				// skipped keys are re-fetched on demand by the normal serving path.
				warmedSites.add(siteKey)

				logger.debug(`HTML prewarm finished for ${did}/${rkey}`, {
					scannedKeys,
					warmedHtmlKeys,
					failedKeys,
				})
			} catch (err) {
				logger.warn(`HTML prewarm failed for ${did}/${rkey}`, { error: err })
			}
		})(),
	}

	prewarmInFlight.set(siteKey, entry)
	entry.promise.finally(() => {
		const current = prewarmInFlight.get(siteKey)
		if (current === entry) {
			prewarmInFlight.delete(siteKey)
		}
	})
}

export function resetSiteHtmlHotCacheWarmup(did: string, rkey: string): void {
	const siteKey = getSiteKey(did, rkey)
	warmedSites.delete(siteKey)
	prewarmGeneration.set(siteKey, (prewarmGeneration.get(siteKey) ?? 0) + 1)
	prewarmInFlight.delete(siteKey)
}

/** Reset all local prewarm state after a broad cache recovery. */
export function resetAllHtmlHotCacheWarmups(): void {
	// Fence existing background scans before forgetting their bookkeeping. A scan
	// that started before broad cache recovery must not mark stale hot data warm.
	prewarmEpoch += 1
	warmedSites.clear()
	prewarmGeneration.clear()
	prewarmInFlight.clear()
}

export function resetHtmlHotCacheWarmupForTests(): void {
	resetAllHtmlHotCacheWarmups()
}

export async function waitForSiteHtmlHotCacheWarmupForTests(did: string, rkey: string): Promise<void> {
	const siteKey = getSiteKey(did, rkey)
	const inFlight = prewarmInFlight.get(siteKey)
	if (inFlight) {
		await inFlight.promise
	}
}
