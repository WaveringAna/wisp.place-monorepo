/**
 * Core types for private sites.
 *
 * These deliberately mirror the shape of atproto proposal 0016 (permissioned data) so
 * that a v2 migration is additive rather than a rewrite:
 *
 *   - `siteId` is rkey-syntax-valid, so it can become a permissioned-space `skey` verbatim
 *   - `ownerDid` is the immutable subject of every access decision, matching 0016's
 *     "record authority: user DID"
 *   - grants are first-class rows with stable ids, so they can become member-list entries
 *     or dynamic `checkUserAccess` policy input
 *
 * See docs/private-sites-v2-migration.md.
 */

/** A private site's durable metadata. Never written to a PDS. */
export interface PrivateSite {
	/** TID-shaped, rkey-valid. Future permissioned-space `skey`. */
	siteId: string
	/** Owner's DID. Future space authority / access-decision subject. */
	ownerDid: string
	/** Human-facing label. NOT an identifier; not unique; never used for routing. */
	name: string
	fileCount: number
	totalBytes: number
	/** `null` means this site never expires. */
	expiresAt: Date | null
	createdAt: Date
	updatedAt: Date
}

/** A share-link grant. The token itself is never stored, only its hash. */
export interface PrivateSiteShare {
	/** Stable grant id. Future member-list entry / policy row id. */
	shareId: string
	siteId: string
	/** Lowercase hex sha256 of the share token. */
	tokenHash: string
	/** First 8 chars of the token, for display only. Not sufficient to authenticate. */
	tokenPrefix: string
	label: string | null
	/** `null` means this share does not expire on its own. */
	expiresAt: Date | null
	/** Non-null means permanently revoked. */
	revokedAt: Date | null
	createdAt: Date
	lastUsedAt: Date | null
}

/**
 * Who is asking for access, expressed abstractly.
 *
 * Deliberately NOT "a cookie" or "a query parameter" — the transport that produced the
 * principal is the route layer's concern. This is what lets v2 add a
 * `spaceCredential` principal without touching the decision logic.
 */
export type AccessPrincipal =
	/** Proven account identity (v1: main-app session cookie; v2: also space credential). */
	| { kind: 'owner'; did: string }
	/** Bearer share-link credential (v1: query parameter). Treat as a secret. */
	| { kind: 'shareToken'; token: string }
	/** No credential presented. */
	| { kind: 'anonymous' }

export type AccessDenialReason =
	/** Site does not exist, or exists but must be indistinguishable from missing. */
	| 'notFound'
	/** The site itself has passed its expiry. */
	| 'siteExpired'
	/** A share token matched but that share has expired. */
	| 'shareExpired'
	/** A share token matched but that share was revoked. */
	| 'shareRevoked'
	/** Credential absent or did not match anything. */
	| 'forbidden'

export type AccessDecision =
	| { allowed: true; reason: 'owner' }
	| { allowed: true; reason: 'share'; shareId: string }
	| { allowed: false; reason: AccessDenialReason }

/** Resolved expiry instruction, produced by `resolveExpiry`. */
export interface ResolvedExpiry {
	expiresAt: Date | null
	/** True when the caller explicitly asked for a non-expiring resource (`0`). */
	neverExpires: boolean
	/** True when the caller omitted a value and the configured default was applied. */
	usedDefault: boolean
}
