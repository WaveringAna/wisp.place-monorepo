const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Compact past-tense distance: "just now", "12m ago", "3h ago", "4d ago", then a date. */
export function timeAgo(at: number | string, now = Date.now()): string {
	const then = typeof at === 'number' ? at : Date.parse(at)
	const elapsed = Math.max(0, now - then)
	if (elapsed < MINUTE) return 'just now'
	if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`
	if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`
	if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d ago`
	return new Date(then).toLocaleDateString()
}

export function expiresIn(expiresAt: string | null, now = Date.now()): string {
	if (!expiresAt) return 'never expires'
	const remaining = Date.parse(expiresAt) - now
	if (remaining <= 0) return 'expired'
	if (remaining < HOUR) return `expires in ${Math.ceil(remaining / MINUTE)}m`
	if (remaining < DAY) return `expires in ${Math.round(remaining / HOUR)}h`
	return `expires in ${Math.round(remaining / DAY)}d`
}
