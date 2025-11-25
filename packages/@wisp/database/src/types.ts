/**
 * Shared database types used across main-app and hosting-service
 */

export interface DomainLookup {
	did: string;
	rkey: string | null;
}

export interface CustomDomainLookup {
	id: string;
	domain: string;
	did: string;
	rkey: string | null;
	verified: boolean;
}

export interface SiteRecord {
	did: string;
	rkey: string;
	display_name?: string;
	created_at?: number;
	updated_at?: number;
}

export interface OAuthState {
	key: string;
	data: string;
	created_at?: number;
	expires_at?: number;
}

export interface OAuthSession {
	sub: string;
	data: string;
	updated_at?: number;
	expires_at?: number;
}

export interface OAuthKey {
	kid: string;
	jwk: string;
	created_at?: number;
}

export interface CookieSecret {
	id: string;
	secret: string;
	created_at?: number;
}

export interface AdminUser {
	username: string;
	password_hash: string;
	created_at?: number;
}
