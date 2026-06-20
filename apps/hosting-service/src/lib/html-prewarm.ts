import { createLogger } from '@wispplace/observability'
import { storage } from './storage'

const logger = createLogger('html-prewarm')

const warmedSites = new Set<string>()
const prewarmGeneration = new Map<string, number>()
const prewarmInFlight = new Map<string, { generation: number; promise: Promise<void> }>()

function getSiteKey(did: string, rkey: string): string {
	return `${did}/${rkey}`
}

function isHtmlStorageKey(key: string): boolean {
	const normalized = key.toLowerCase()
	return normalized.endsWith('.html') || normalized.endsWith('.htm')
}

async function loadSiteHtmlKeysIntoHotTier(
	did: string,
	rkey: string,
): Promise<{ scannedKeys: number; warmedHtmlKeys: number }> {
	const prefix = `${did}/${rkey}/`
	let scannedKeys = 0
	let warmedHtmlKeys = 0

	for await (const key of storage.listKeys(prefix)) {
		scannedKeys++
		if (!isHtmlStorageKey(key)) continue

		// getWithMetadata uses eager promotion and moves the key into hot tier.
		const result = await storage.getWithMetadata(key)
		if (result) {
			warmedHtmlKeys++
		}
	}

	return { scannedKeys, warmedHtmlKeys }
}

export function triggerSiteHtmlHotCacheWarmup(did: string, rkey: string): void {
	const siteKey = getSiteKey(did, rkey)
	if (warmedSites.has(siteKey)) return

	const generation = prewarmGeneration.get(siteKey) ?? 0
	const existing = prewarmInFlight.get(siteKey)
	if (existing && existing.generation === generation) return

	const entry = {
		generation,
		promise: (async () => {
			try {
				const { scannedKeys, warmedHtmlKeys } = await loadSiteHtmlKeysIntoHotTier(did, rkey)
				const latestGeneration = prewarmGeneration.get(siteKey) ?? 0
				if (latestGeneration !== generation) return

				// Remember successful scans even when there are no matching keys so repeated
				// requests for the same missing/empty prefix cannot force repeated storage scans.
				warmedSites.add(siteKey)

				logger.debug(`HTML prewarm finished for ${did}/${rkey}`, {
					scannedKeys,
					warmedHtmlKeys,
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

export function resetHtmlHotCacheWarmupForTests(): void {
	warmedSites.clear()
	prewarmGeneration.clear()
	prewarmInFlight.clear()
}

export async function waitForSiteHtmlHotCacheWarmupForTests(did: string, rkey: string): Promise<void> {
	const siteKey = getSiteKey(did, rkey)
	const inFlight = prewarmInFlight.get(siteKey)
	if (inFlight) {
		await inFlight.promise
	}
}
