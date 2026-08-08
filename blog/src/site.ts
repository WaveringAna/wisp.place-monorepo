/**
 * Site-wide configuration for the wisp.place engineering blog.
 */

export const site = {
	title: 'wisp.place blog',
	tagline: 'Releases, write-ups, and the occasional postmortem',
	description: 'Announcements, engineering notes, and postmortems from wisp.place — static hosting on the AT Protocol.',
	url: 'https://blog.wisp.place',
	language: 'en',
} as const

/** Top-level nav. `external` links open a new tab. */
export const nav = [
	{ label: 'Blog', href: '/' },
	{ label: 'wisp.place', href: 'https://wisp.place', external: true },
	{ label: 'Docs', href: 'https://docs.wisp.place', external: true },
	{ label: 'Status', href: 'https://status.wisp.place', external: true },
] as const

/** Formats an ISO date as "7 Aug 2026" without pulling in a date library. */
export function formatDate(iso: string): string {
	return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC',
	})
}

/** Machine-readable timestamp for <time datetime> and RSS. */
export function toRFC822(iso: string): string {
	return new Date(`${iso}T00:00:00Z`).toUTCString()
}
