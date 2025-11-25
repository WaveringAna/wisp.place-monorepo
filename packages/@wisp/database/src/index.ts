/**
 * Shared database utilities for wisp.place
 *
 * This package provides database query functions that work across both
 * main-app (Bun SQL) and hosting-service (postgres) environments.
 *
 * The actual database client is passed in by the consuming application.
 */

export * from './types';

// Re-export types
export type {
	DomainLookup,
	CustomDomainLookup,
	SiteRecord,
	OAuthState,
	OAuthSession,
	OAuthKey,
	CookieSecret,
	AdminUser
} from './types';
