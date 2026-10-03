export interface RateLimiter {
	/** Spend one token for `key`; false when it has none. */
	take(key: string): boolean
	size(): number
}

interface Bucket {
	tokens: number
	updatedAt: number
}

/**
 * Token buckets per key, bounded in memory: a key whose bucket has fully refilled is
 * indistinguishable from a new one, so those are dropped first when the table is full, and if none
 * can be dropped a new key is refused rather than letting callers grow the table.
 */
export function createRateLimiter(options: {
	capacity: number
	refillPerSecond: number
	maxKeys?: number
	now?: () => number
}): RateLimiter {
	const { capacity, refillPerSecond, maxKeys = 10_000, now = Date.now } = options
	const buckets = new Map<string, Bucket>()

	const refilled = (bucket: Bucket, at: number) =>
		Math.min(capacity, bucket.tokens + ((at - bucket.updatedAt) / 1000) * refillPerSecond)

	const dropIdle = (at: number) => {
		for (const [key, bucket] of buckets) if (refilled(bucket, at) >= capacity) buckets.delete(key)
	}

	return {
		take(key) {
			const at = now()
			let bucket = buckets.get(key)
			if (!bucket) {
				if (buckets.size >= maxKeys) dropIdle(at)
				if (buckets.size >= maxKeys) return false
				bucket = { tokens: capacity, updatedAt: at }
				buckets.set(key, bucket)
			}
			bucket.tokens = refilled(bucket, at)
			bucket.updatedAt = at
			if (bucket.tokens < 1) return false
			bucket.tokens -= 1
			return true
		},
		size: () => buckets.size,
	}
}
