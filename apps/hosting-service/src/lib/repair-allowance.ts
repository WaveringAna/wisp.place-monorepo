/**
 * How many repairs of sites with no cached row one client may ask for.
 *
 * Anyone can name an account and a made-up site, and each such request asks
 * the shared revalidation stream for a repair. A real visitor needs one; a
 * token bucket per client keeps a single source from filling the stream.
 * Buckets are per process, so each edge counts on its own.
 */
export interface RepairAllowance {
	allow(client: string): boolean
}

export interface RepairAllowanceOptions {
	burst: number
	refillPerMinute: number
	maxClients: number
	now?: () => number
}

export const DEFAULT_REPAIR_ALLOWANCE: RepairAllowanceOptions = { burst: 3, refillPerMinute: 3, maxClients: 10_000 }

export function createRepairAllowance({
	burst,
	refillPerMinute,
	maxClients,
	now = Date.now,
}: RepairAllowanceOptions): RepairAllowance {
	const buckets = new Map<string, { tokens: number; at: number }>()
	const perMs = refillPerMinute / 60_000
	return {
		allow(client) {
			const time = now()
			const bucket = buckets.get(client)
			const tokens = bucket ? Math.min(burst, bucket.tokens + (time - bucket.at) * perMs) : burst
			// Reinserting keeps the map in last-use order, so the oldest client is evicted first.
			buckets.delete(client)
			if (buckets.size >= maxClients) {
				const oldest = buckets.keys().next().value
				if (oldest !== undefined) buckets.delete(oldest)
			}
			const allowed = tokens >= 1
			buckets.set(client, { tokens: allowed ? tokens - 1 : tokens, at: time })
			return allowed
		},
	}
}

/**
 * The client a request came from. Caddy replaces X-Forwarded-For with the
 * address it saw, so its last entry is the visitor and cannot be supplied by
 * them. An IPv6 visitor is counted per /64, which one host usually holds whole.
 */
export function requestClient(headers: Record<string, string> | undefined): string {
	const address = headers?.['x-forwarded-for']?.split(',').pop()?.trim()
	if (!address) return 'unknown'
	if (!address.includes(':')) return address
	const [head = '', tail = ''] = address.split('::')
	const groups = head.split(':').filter(Boolean)
	const tailGroups = tail.split(':').filter(Boolean)
	const full = [...groups, ...Array(Math.max(0, 8 - groups.length - tailGroups.length)).fill('0'), ...tailGroups]
	return `${full.slice(0, 4).join(':')}::/64`
}
