export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
	}
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
	body?: BodyInit
	json?: unknown
}

const failureMessage = (body: unknown, response: Response): string => {
	const error = (body as { error?: unknown } | null)?.error
	return typeof error === 'string' && error ? error : `${response.status} ${response.statusText}`.trim()
}

/** Error responses are not always JSON (proxies, crashes), so a parse failure is just "no body". */
const readJson = (response: Response): Promise<unknown> => response.json().catch(() => null)

/** Every dashboard call goes through here: non-2xx and `{ success: false }` both reject with the server's message. */
export async function request<T>(path: string, { json, headers, ...init }: RequestOptions = {}): Promise<T> {
	const response = await fetch(path, {
		...init,
		...(json === undefined ? {} : { body: JSON.stringify(json) }),
		headers: json === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
	})
	const body: unknown = await readJson(response)
	if (!response.ok || (body as { success?: unknown } | null)?.success === false) {
		throw new ApiError(failureMessage(body, response), response.status)
	}
	return body as T
}

const post = <T = unknown>(path: string, json?: unknown) => request<T>(path, { method: 'POST', json })
const remove = <T = unknown>(path: string) => request<T>(path, { method: 'DELETE' })
const segment = encodeURIComponent

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error')

export interface UserInfo {
	did: string
	handle: string
	isSupporter: boolean
}

export interface SiteDomain {
	type: 'wisp' | 'custom'
	domain: string
	verified?: boolean
	id?: string
}

export interface PublicSiteRecord {
	did: string
	rkey: string
	display_name: string | null
	created_at: number
	updated_at: number
	domains?: SiteDomain[]
}

export interface PrivateSiteRecord {
	siteId: string
	name: string
	fileCount: number
	totalBytes: number
	expiresAt: string | null
	createdAt: string
	expired: boolean
	shareCount: number
	url: string
}

export interface PrivateShare {
	shareId: string
	tokenPrefix: string
	label: string | null
	audienceDid: string | null
	expiresAt: string | null
	revokedAt: string | null
	createdAt: string
	lastUsedAt: string | null
	status: 'active' | 'expired' | 'revoked'
}

export interface CustomHeader {
	name: string
	value: string
	path?: string
}

export interface SiteSettings {
	directoryListing?: boolean
	spaMode?: string
	custom404?: string
	indexFiles?: string[]
	cleanUrls?: boolean
	headers?: CustomHeader[]
}

export interface WispDomain {
	domain: string
	rkey: string | null
}

export interface CustomDomain {
	id: string
	domain: string
	did: string
	rkey: string | null
	verified: boolean
	last_verified_at: number | null
	created_at: number
}

/** One record in a marque.at zone. */
export interface MarqueEntry {
	name: string
	recordType: string
	value: string
	ttl: number
}

/** Whether marque.at serves a custom domain's dns, and whether wisp may add its records there. */
export type MarqueStatus = { canWrite: boolean } & (
	| { managed: false }
	| { managed: true; apex: string; state: 'ready' | 'done' | 'conflict'; conflicts: MarqueEntry[] }
)

export interface VerifyResult {
	verified: boolean
	error?: string
	warning?: string
}

export interface WebhookRecordValue {
	scope?: { aturi?: string; backlinks?: boolean; backlinksOnly?: boolean }
	url?: string
	events?: string[]
	enabled?: boolean
	createdAt?: string
	secretId?: string
}

export type WebhookEvent = 'create' | 'update' | 'delete'

export interface WebhookInput {
	scopeAturi: string
	url: string
	backlinks: boolean
	backlinksOnly?: boolean
	events: WebhookEvent[]
	secretId?: string
	enabled: boolean
}

export interface WebhookDelivery {
	rkey: string
	url: string
	eventKind: string
	eventDid: string
	eventCollection: string
	eventRkey: string
	deliveredAt: string
	status: 'ok' | 'failed'
}

export interface SecretMeta {
	name: string
	createdAt: string
	lastRotatedAt?: string
}

export interface PreviewRepo {
	rkey: string
	name: string
	spindle?: string
	knot?: string
	preview: { claim: string; hookRkey: string } | null
	blocked: 'no-spindle' | null
	secret: 'set' | 'missing' | 'unknown'
}

export interface PreviewsInfo {
	/** Null when this deployment has previews turned off. */
	previewHost: string | null
	repos: PreviewRepo[]
	claims: string[]
	canSetSecrets: boolean
}

export interface UploadStarted {
	jobId?: string
}

export const api = {
	user: () => request<UserInfo>('/api/user/info'),
	logout: () => post('/api/auth/logout'),

	sites: () => request<{ sites?: PublicSiteRecord[] }>('/api/user/sites'),
	/** Queues sites that are on the PDS but not cached yet; `synced` counts what the PDS has. */
	syncSites: () => post<{ synced: number; queued: number }>('/api/user/sync'),
	privateSites: () => request<{ sites?: PrivateSiteRecord[] }>('/api/user/private-sites'),
	deleteSite: (rkey: string) => remove(`/api/site/${segment(rkey)}`),
	deletePrivateSite: (siteId: string) => remove(`/api/user/private-sites/${segment(siteId)}`),
	openPrivateSite: (siteId: string) => post<{ url: string }>(`/api/user/private-sites/${segment(siteId)}/open`),
	siteSettings: (rkey: string) => request<SiteSettings>(`/api/site/${segment(rkey)}/settings`),
	saveSiteSettings: (rkey: string, settings: SiteSettings) => post(`/api/site/${segment(rkey)}/settings`, settings),

	shares: (siteId: string) => request<{ shares?: PrivateShare[] }>(`/api/user/private-sites/${segment(siteId)}/shares`),
	createShare: (siteId: string, input: { label?: string; audienceDid?: string }) =>
		post<{ url: string }>(`/api/user/private-sites/${segment(siteId)}/shares`, input),
	revokeShare: (siteId: string, shareId: string) =>
		remove(`/api/user/private-sites/${segment(siteId)}/shares/${segment(shareId)}`),
	resolveHandle: (handle: string) =>
		request<{ found: boolean; did?: string }>(`/api/user/private-sites/resolve-handle?handle=${segment(handle)}`),

	domains: () => request<{ wispDomains?: WispDomain[]; customDomains?: CustomDomain[] }>('/api/user/domains'),
	checkWispDomain: (handle: string) =>
		request<{ available: boolean; reason?: string }>(`/api/domain/check?handle=${segment(handle)}`),
	claimWispDomain: (handle: string) => post('/api/domain/claim', { handle }),
	deleteWispDomain: (domain: string) => remove(`/api/domain/wisp/${segment(domain)}`),
	mapWispDomain: (domain: string, siteRkey: string | null) => post('/api/domain/wisp/map-site', { domain, siteRkey }),
	addCustomDomain: (domain: string) => post<{ id: string }>('/api/domain/custom/add', { domain }),
	verifyCustomDomain: (id: string) => post<VerifyResult>('/api/domain/custom/verify', { id }),
	deleteCustomDomain: (id: string) => remove(`/api/domain/custom/${segment(id)}`),
	marqueStatus: (id: string) => request<MarqueStatus>(`/api/domain/custom/${segment(id)}/marque`),
	setUpMarque: (id: string, replace = false) => post(`/api/domain/custom/${segment(id)}/marque`, { replace }),
	mapCustomDomain: (id: string, siteRkey: string | null) =>
		post(`/api/domain/custom/${segment(id)}/map-site`, { siteRkey }),

	webhooks: () => request<{ records?: { uri: string; value?: WebhookRecordValue }[] }>('/api/webhook'),
	createWebhook: (input: WebhookInput) => post('/api/webhook', input),
	deleteWebhook: (rkey: string) => remove(`/api/webhook/${segment(rkey)}`),
	webhookDeliveries: () => request<{ events?: WebhookDelivery[] }>('/api/webhook/events'),

	secrets: () => request<{ secrets?: SecretMeta[] }>('/api/secret'),
	createSecret: (name: string) => post<{ token: string }>('/api/secret', { name }),
	rotateSecret: (name: string) => post<{ token: string }>(`/api/secret/${segment(name)}/rotate`),
	deleteSecret: (name: string) => remove(`/api/secret/${segment(name)}`),

	previews: () => request<PreviewsInfo>('/api/previews/'),
	enablePreview: (repo: string, input: { claim: string; appPassword?: string }) =>
		request(`/api/previews/${segment(repo)}`, { method: 'PUT', json: input }),
	disablePreview: (repo: string) => remove(`/api/previews/${segment(repo)}`),

	uploadSite: (form: FormData) => request<UploadStarted>('/wisp/upload-files', { method: 'POST', body: form }),
	/** Private uploads are stored synchronously, so they never return a job to follow. */
	uploadPrivateSite: (form: FormData) =>
		request<UploadStarted>('/api/user/private-sites', { method: 'POST', body: form }),
}
