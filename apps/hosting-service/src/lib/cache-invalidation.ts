/**
 * Cache invalidation subscriber
 *
 * Listens to Redis pub/sub for cache invalidation messages from the firehose-service.
 * When a site is updated/deleted, clears the hosting-service's local caches
 * (tiered storage hot+warm tiers, redirect rules) so stale data isn't served.
 *
 * Also tracks sites that are actively being downloaded ('updating' action) so
 * the serving layer can show a "site updating" page instead of stale/partial content.
 */

import type { StorageTier } from '@wispplace/tiered-storage'
import Redis from 'ioredis'
import { cache } from './cache-manager'
import { hotTier, warmTier } from './storage'

const CHANNEL = 'wisp:cache-invalidate'

// Sites currently being downloaded by the firehose-service.
// Maps `${did}/${rkey}` → timestamp when the update started.
// Used to show an "updating" page instead of serving stale files.
const UPDATING_TTL_MS = 10 * 60 * 1000 // 10 minutes safety timeout
const updatingSites = new Map<string, number>()

export function isSiteUpdating(did: string, rkey: string): boolean {
	const key = `${did}/${rkey}`
	const since = updatingSites.get(key)
	if (since === undefined) return false
	if (Date.now() - since > UPDATING_TTL_MS) {
		// Firehose must have crashed; remove the stale entry
		updatingSites.delete(key)
		return false
	}
	return true
}

let subscriber: Redis | null = null

/**
 * Directly invalidate a tier by listing and deleting all keys with the given prefix.
 * Each tier is invalidated independently so a failure in one doesn't block the others.
 */
async function invalidateTier(tier: StorageTier, tierName: string, prefix: string): Promise<number> {
	try {
		const keys: string[] = []
		for await (const key of tier.listKeys(prefix)) {
			keys.push(key)
		}
		if (keys.length > 0) {
			await tier.deleteMany(keys)
		}
		return keys.length
	} catch (err) {
		console.error(`[CacheInvalidation] Failed to invalidate ${tierName} tier for prefix ${prefix}:`, err)
		return 0
	}
}

export function startCacheInvalidationSubscriber(): void {
	const redisUrl = process.env.REDIS_URL
	if (!redisUrl) {
		console.warn('[CacheInvalidation] REDIS_URL not set; cache invalidation disabled')
		return
	}

	console.log(`[CacheInvalidation] Connecting to Redis for subscribing: ${redisUrl}`)
	subscriber = new Redis(redisUrl, {
		maxRetriesPerRequest: 2,
		enableReadyCheck: true,
	})

	subscriber.on('error', (err) => {
		console.error('[CacheInvalidation] Redis error:', err)
	})

	subscriber.on('ready', () => {
		console.log('[CacheInvalidation] Redis subscriber connected')
	})

	subscriber.subscribe(CHANNEL, (err) => {
		if (err) {
			console.error('[CacheInvalidation] Failed to subscribe:', err)
		} else {
			console.log('[CacheInvalidation] Subscribed to', CHANNEL)
		}
	})

	subscriber.on('message', async (_channel: string, message: string) => {
		try {
			const { did, rkey, action } = JSON.parse(message) as {
				did: string
				rkey: string
				action: 'updating' | 'update' | 'delete' | 'settings'
			}

			if (!did || !rkey) {
				console.warn('[CacheInvalidation] Invalid message:', message)
				return
			}

			console.log(`[CacheInvalidation] Received ${action} for ${did}/${rkey}`)

			if (action === 'updating') {
				// Firehose is about to download new files — mark site as updating
				updatingSites.set(`${did}/${rkey}`, Date.now())
				console.log(`[CacheInvalidation] Marked ${did}/${rkey} as updating`)
				return
			}

			// For update/delete/settings: clear the updating flag and invalidate caches
			updatingSites.delete(`${did}/${rkey}`)

			const prefix = `${did}/${rkey}/`

			// Invalidate each tier independently - a failure in one tier
			// (e.g. S3 listKeys timeout) must NOT prevent hot/warm from being cleared
			const hotDeleted = await invalidateTier(hotTier, 'hot', prefix)
			const warmDeleted = warmTier ? await invalidateTier(warmTier, 'warm', prefix) : 0

			console.log(`[CacheInvalidation] Cleared ${hotDeleted} hot + ${warmDeleted} warm keys for ${did}/${rkey}`)

			// Clear in-memory caches for this site
			cache.delete('redirectRules', `${did}:${rkey}`)
			cache.delete('settings', `${did}:${rkey}`)
			cache.deletePrefix('siteFiles', `${did}:${rkey}:`)
		} catch (err) {
			console.error('[CacheInvalidation] Error processing message:', err)
		}
	})
}

export async function stopCacheInvalidationSubscriber(): Promise<void> {
	if (subscriber) {
		const toClose = subscriber
		subscriber = null
		await toClose.quit()
	}
}
