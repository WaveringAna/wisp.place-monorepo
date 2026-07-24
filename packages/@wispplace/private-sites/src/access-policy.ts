/**
 * The single authorization decision point for private sites.
 *
 * This module is pure: no database, no HTTP, no cookies, no query parsing. Callers build
 * an `AccessPrincipal` from whatever transport they speak and then obey the returned
 * `AccessDecision`. Keeping every decision here is what makes the v2 migration tractable —
 * under atproto proposal 0016 this function becomes the body of the managing app's
 * `com.atproto.simplespace.checkUserAccess`.
 */

import { hashShareTokenSync, timingSafeEqualHex } from './token'
import type { AccessDecision, AccessPrincipal, PrivateSite, PrivateSiteShare } from './types'

export interface EvaluateAccessInput {
	site: PrivateSite | null
	shares: readonly PrivateSiteShare[]
	principal: AccessPrincipal
	now: Date
}

/** True when `expiresAt` is set and already in the past. `null` never expires. */
export const isExpired = (expiresAt: Date | null, now: Date): boolean => {
	if (expiresAt === null) return false
	return expiresAt.getTime() <= now.getTime()
}

/**
 * Decide whether `principal` may read `site`.
 *
 * Ordering matters and is deliberate:
 *   1. a missing site is `notFound` for everyone
 *   2. the owner is checked before site expiry, so an owner can still see and clean up
 *      their own expired site (it is their data)
 *   3. for everyone else, site expiry closes the site regardless of share validity
 *   4. a share is checked revoked-then-expired-then-match, so a revoked share reports
 *      revocation rather than silently falling through to `forbidden`
 */
export const evaluateAccess = ({ site, shares, principal, now }: EvaluateAccessInput): AccessDecision => {
	if (!site) {
		return { allowed: false, reason: 'notFound' }
	}

	if (principal.kind === 'owner' && principal.did === site.ownerDid) {
		return { allowed: true, reason: 'owner' }
	}

	// Past this point the requester is not the owner, so an expired site is closed.
	if (isExpired(site.expiresAt, now)) {
		return { allowed: false, reason: 'siteExpired' }
	}

	if (principal.kind !== 'shareToken') {
		return { allowed: false, reason: 'forbidden' }
	}

	const presented = hashShareTokenSync(principal.token)

	// Walk every share rather than returning on first hash match, so that revoked and
	// expired shares produce their specific reason instead of a generic denial.
	let matched: PrivateSiteShare | null = null
	for (const share of shares) {
		if (share.siteId !== site.siteId) continue
		if (!timingSafeEqualHex(share.tokenHash, presented)) continue
		matched = share
		break
	}

	if (!matched) {
		return { allowed: false, reason: 'forbidden' }
	}

	if (matched.revokedAt !== null) {
		return { allowed: false, reason: 'shareRevoked' }
	}

	if (isExpired(matched.expiresAt, now)) {
		return { allowed: false, reason: 'shareExpired' }
	}

	return { allowed: true, reason: 'share', shareId: matched.shareId }
}

/**
 * HTTP status for a denial.
 *
 * Every denial that is not an owner-visible state collapses to 404 so that an
 * unauthenticated probe cannot distinguish "this private site exists" from "it does not".
 * Revoked and expired shares also return 404 for the same reason: a holder of a dead link
 * learns nothing about whether the underlying site is still live.
 */
export const denialStatus = (): 404 => 404
