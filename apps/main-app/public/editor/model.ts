import type {
	CustomDomain,
	CustomHeader,
	PrivateSiteRecord,
	PublicSiteRecord,
	SiteDomain,
	SiteSettings,
	WebhookEvent,
	WebhookRecordValue,
	WispDomain,
} from './api'

export const SITES_HOST = 'sites.wisp.place'

export interface PublicSite {
	kind: 'public'
	key: string
	rkey: string
	name: string
	createdAt: number
	updatedAt: number
	domains: SiteDomain[]
}

export interface PrivateSite {
	kind: 'private'
	key: string
	siteId: string
	name: string
	createdAt: number
	expiresAt: string | null
	expired: boolean
	shareCount: number
	url: string
	fileCount: number
	totalBytes: number
}

export type Site = PublicSite | PrivateSite

/** Custom domains first: they are what visitors are most likely to use. */
const byDomainPreference = (a: SiteDomain, b: SiteDomain) => Number(a.type === 'wisp') - Number(b.type === 'wisp')

export const toPublicSite = (record: PublicSiteRecord): PublicSite => ({
	kind: 'public',
	key: `public:${record.rkey}`,
	rkey: record.rkey,
	name: record.display_name || record.rkey,
	createdAt: record.created_at * 1000,
	updatedAt: record.updated_at * 1000,
	domains: [...(record.domains ?? [])].sort(byDomainPreference),
})

export const toPrivateSite = (record: PrivateSiteRecord): PrivateSite => ({
	kind: 'private',
	key: `private:${record.siteId}`,
	siteId: record.siteId,
	name: record.name,
	createdAt: Date.parse(record.createdAt),
	expiresAt: record.expiresAt,
	expired: record.expired,
	shareCount: record.shareCount,
	url: record.url,
	fileCount: record.fileCount,
	totalBytes: record.totalBytes,
})

export const newestFirst = (a: Site, b: Site) => b.createdAt - a.createdAt

export const defaultSiteAddress = (handle: string, rkey: string) => `${SITES_HOST}/${handle}/${rkey}`

/** What a visitor types: the preferred mapped domain, else the shared sites host. */
export const siteAddress = (site: PublicSite, handle: string) =>
	site.domains[0]?.domain ?? defaultSiteAddress(handle, site.rkey)

/* ── Site settings ─────────────────────────────────────────────────────── */

export type RoutingMode = 'default' | 'spa' | 'directory' | 'custom404'

export interface SettingsDraft {
	routing: RoutingMode
	spaFile: string
	notFoundFile: string
	indexFiles: string
	cleanUrls: boolean
	cors: boolean
	corsOrigin: string
}

const CORS_HEADER = 'access-control-allow-origin'
const isCorsHeader = (header: CustomHeader) => header.name.toLowerCase() === CORS_HEADER

const routingOf = (settings: SiteSettings): RoutingMode => {
	if (settings.spaMode) return 'spa'
	if (settings.directoryListing) return 'directory'
	if (settings.custom404) return 'custom404'
	return 'default'
}

export function toSettingsDraft(settings: SiteSettings): SettingsDraft {
	const cors = settings.headers?.find(isCorsHeader)
	return {
		routing: routingOf(settings),
		spaFile: settings.spaMode || 'index.html',
		notFoundFile: settings.custom404 || '404.html',
		indexFiles: (settings.indexFiles?.length ? settings.indexFiles : ['index.html']).join(' '),
		cleanUrls: settings.cleanUrls ?? false,
		cors: Boolean(cors),
		corsOrigin: cors?.value ?? '*',
	}
}

/**
 * Turns the form back into a settings record. Headers the dashboard does not
 * edit (set from the CLI or by hand) are carried over untouched.
 */
export function fromSettingsDraft(draft: SettingsDraft, previous: SiteSettings): SiteSettings {
	const headers = [
		...(previous.headers ?? []).filter((header) => !isCorsHeader(header)),
		...(draft.cors ? [{ name: 'Access-Control-Allow-Origin', value: draft.corsOrigin.trim() || '*' }] : []),
	]
	const indexFiles = draft.indexFiles.split(/[\s,]+/).filter(Boolean)
	return {
		directoryListing: draft.routing === 'directory',
		cleanUrls: draft.cleanUrls,
		indexFiles: indexFiles.length ? indexFiles : ['index.html'],
		...(draft.routing === 'spa' ? { spaMode: draft.spaFile.trim() || 'index.html' } : {}),
		...(draft.routing === 'custom404' ? { custom404: draft.notFoundFile.trim() || '404.html' } : {}),
		...(headers.length ? { headers } : {}),
	}
}

/* ── Domain mapping ────────────────────────────────────────────────────── */

export type DomainKey = `wisp:${string}` | `custom:${string}`

export const wispKey = (domain: WispDomain): DomainKey => `wisp:${domain.domain}`
export const customKey = (domain: CustomDomain): DomainKey => `custom:${domain.id}`

export const mappedDomainKeys = (rkey: string, wisp: WispDomain[], custom: CustomDomain[]): Set<DomainKey> =>
	new Set([
		...wisp.filter((domain) => domain.rkey === rkey).map(wispKey),
		...custom.filter((domain) => domain.rkey === rkey).map(customKey),
	])

/** The keys to point at the site and the keys to release, given the current and wanted mappings. */
export function domainMappingChanges(current: ReadonlySet<DomainKey>, wanted: ReadonlySet<DomainKey>) {
	return {
		map: [...wanted].filter((key) => !current.has(key)),
		unmap: [...current].filter((key) => !wanted.has(key)),
	}
}

/* ── Webhooks ──────────────────────────────────────────────────────────── */

export interface Webhook {
	rkey: string
	url: string
	scope: string
	backlinks: boolean
	backlinksOnly: boolean
	events: string[]
	enabled: boolean
	secretId?: string
}

export const toWebhook = ({ uri, value = {} }: { uri: string; value?: WebhookRecordValue }): Webhook => ({
	rkey: uri.split('/').pop() ?? '',
	url: value.url ?? '',
	scope: value.scope?.aturi ?? '',
	backlinks: value.scope?.backlinks ?? false,
	backlinksOnly: value.scope?.backlinksOnly ?? false,
	events: value.events ?? [],
	enabled: value.enabled ?? true,
	secretId: value.secretId,
})

/** The part of a scope after the DID, which is what tells webhooks apart. */
export const scopePath = (aturi: string) => aturi.replace(/^at:\/\/[^/]+\/?/, '') || 'all records'

export const WEBHOOK_APPS = [
	{ id: 'bluesky', label: 'bluesky', path: 'app.bsky.*' },
	{ id: 'tangled', label: 'tangled', path: 'sh.tangled.*' },
	{ id: 'leaflet', label: 'leaflet', path: 'pub.leaflet.*' },
	{ id: 'wisp', label: 'wisp', path: 'place.wisp.*' },
	{ id: 'blento', label: 'blento', path: 'blue.blento.*' },
	{ id: 'other', label: 'other', path: '' },
] as const

export type WebhookApp = (typeof WEBHOOK_APPS)[number]['id']
export type OtherScope = 'all' | 'collection' | 'record'

export interface ScopeDraft {
	did: string
	app: WebhookApp | null
	path: string
	other: OtherScope
	collection: string
	rkey: string
}

/** Builds the scope AT-URI, or '' while the draft is still incomplete. */
export function buildScope({ did, app, path, other, collection, rkey }: ScopeDraft): string {
	if (!did || !app) return ''
	if (app !== 'other') return path.trim() ? `at://${did}/${path.trim()}` : `at://${did}`
	if (other === 'all') return `at://${did}`
	if (!collection.trim()) return ''
	if (other === 'collection') return `at://${did}/${collection.trim()}`
	return rkey.trim() ? `at://${did}/${collection.trim()}/${rkey.trim()}` : ''
}

export const ALL_WEBHOOK_EVENTS: readonly WebhookEvent[] = ['create', 'update', 'delete']

/** The API treats an empty list as "every event". */
export const eventsFilter = (events: readonly WebhookEvent[]): WebhookEvent[] =>
	events.length === ALL_WEBHOOK_EVENTS.length ? [] : [...events]
