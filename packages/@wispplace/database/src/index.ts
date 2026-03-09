/**
 * Shared database utilities for wisp.place
 *
 * This package provides database query functions that work across both
 * main-app (Bun SQL) and hosting-service (postgres) environments.
 *
 * The actual database client is passed in by the consuming application.
 */

// Re-export types
export type {
	AdminUser,
	CookieSecret,
	CustomDomainLookup,
	DomainLookup,
	OAuthKey,
	OAuthSession,
	OAuthState,
	SiteCache,
	SiteRecord,
	SiteSettingsCache,
	Supporter,
} from './types'
export * from './types'
