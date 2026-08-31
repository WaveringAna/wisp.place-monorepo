import { PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES } from './public-upload-memory-budget'

// Two small requests may parse concurrently, but the weighted budget prevents
// concurrent maximum-size supporter bodies from being retained in memory.
export const MAX_ACTIVE_PUBLIC_UPLOAD_REQUESTS = 2
export const MAX_ACTIVE_PUBLIC_UPLOAD_REQUESTS_PER_SOURCE = 1
// The budget is a strictly parsed deployment setting. Its safe default is
// intentionally small for edge nodes; high-memory upload nodes opt in to more.
export const MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES = PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES

export interface PublicUploadRequestLease {
	readonly id: string
	readonly sourceKey: string
	readonly reservedBytes: number
}

export class PublicUploadRequestGate {
	private readonly activeLeaseIds = new Set<string>()
	private readonly activeBySource = new Map<string, number>()
	private reservedBytes = 0

	tryAcquire(sourceKey: string, bytes: number): PublicUploadRequestLease | null {
		if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES) return null
		if (this.activeLeaseIds.size >= MAX_ACTIVE_PUBLIC_UPLOAD_REQUESTS) return null
		if (this.reservedBytes > MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES - bytes) return null
		if ((this.activeBySource.get(sourceKey) ?? 0) >= MAX_ACTIVE_PUBLIC_UPLOAD_REQUESTS_PER_SOURCE) return null

		const lease = { id: crypto.randomUUID(), sourceKey, reservedBytes: bytes }
		this.activeLeaseIds.add(lease.id)
		this.activeBySource.set(sourceKey, (this.activeBySource.get(sourceKey) ?? 0) + 1)
		this.reservedBytes += bytes
		return lease
	}

	release(lease: PublicUploadRequestLease): void {
		if (!this.activeLeaseIds.delete(lease.id)) return
		this.reservedBytes -= lease.reservedBytes
		const next = (this.activeBySource.get(lease.sourceKey) ?? 0) - 1
		if (next > 0) this.activeBySource.set(lease.sourceKey, next)
		else this.activeBySource.delete(lease.sourceKey)
	}

	stats(): { active: number; sources: number; reservedBytes: number; maxReservedBytes: number } {
		return {
			active: this.activeLeaseIds.size,
			sources: this.activeBySource.size,
			reservedBytes: this.reservedBytes,
			maxReservedBytes: MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES,
		}
	}
}

export const publicUploadRequestGate = new PublicUploadRequestGate()

export function getPublicUploadRequestGateStats(): {
	active: number
	sources: number
	reservedBytes: number
	maxReservedBytes: number
} {
	return publicUploadRequestGate.stats()
}

/**
 * The global weighted cap is authoritative. This per-source hint is useful
 * only behind a proxy that strips client-supplied forwarding headers and sets
 * them itself. Store HMAC fingerprints, never raw IP addresses or cookies.
 */
const sourceFingerprintKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32)))

export function publicUploadSourceKey(request: Request): string {
	// This header is intentionally only a fairness key. It is trustworthy only
	// when the configured reverse proxy replaces client-provided values.
	const source = request.headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim() || 'unattributed'
	return fingerprint(source.slice(0, 128))
}

function fingerprint(value: string): string {
	return new Bun.CryptoHasher('sha256', sourceFingerprintKey).update(value).digest('hex').slice(0, 32)
}
