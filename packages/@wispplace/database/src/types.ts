/**
 * Shared database types used across main-app and hosting-service
 */

export interface DomainLookup {
	did: string
	rkey: string | null
}

export interface CustomDomainLookup {
	id: string
	domain: string
	did: string
	rkey: string | null
	verified: boolean
}

export interface SiteRecord {
	did: string
	rkey: string
	display_name?: string
	created_at?: number
	updated_at?: number
}

export interface OAuthState {
	key: string
	data: string
	created_at?: number
	expires_at?: number
}

export interface OAuthSession {
	sub: string
	data: string
	updated_at?: number
	expires_at?: number
}

export interface OAuthKey {
	kid: string
	jwk: string
	created_at?: number
}

export interface CookieSecret {
	id: string
	secret: string
	created_at?: number
}

export interface AdminUser {
	username: string
	password_hash: string
	created_at?: number
}

/**
 * Site cache - stores CIDs for cached sites
 * Used by firehose-service (writes) and hosting-service (reads)
 */
export interface SiteCache {
	did: string
	rkey: string
	record_cid: string
	file_cids: Record<string, string> // path -> CID mapping
	cached_at: number
	updated_at: number
}

/**
 * Cached site settings from place.wisp.settings lexicon
 */
export interface SiteSettingsCache {
	did: string
	rkey: string
	record_cid: string
	directory_listing: boolean
	spa_mode: string | null
	custom_404: string | null
	index_files: string[] | null
	clean_urls: boolean
	headers: Array<{ name: string; value: string; path?: string }> | null
	cached_at: number
	updated_at: number
}

/**
 * Supporter - list of supporter DIDs
 */
export interface Supporter {
	did: string
	created_at?: number
}
