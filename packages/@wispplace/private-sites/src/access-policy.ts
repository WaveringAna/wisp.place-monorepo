import { hashShareTokenSync, timingSafeEqualHex } from './token'
import type { AccessDecision, AccessPrincipal, PrivateSite, PrivateSiteShare } from './types'

export interface EvaluateAccessInput {
	site: PrivateSite | null
	shares: readonly PrivateSiteShare[]
	principal: AccessPrincipal
	now: Date
}

export const isExpired = (expiresAt: Date | null, now: Date): boolean => {
	if (expiresAt === null) return false
	return expiresAt.getTime() <= now.getTime()
}

export const evaluateAccess = ({ site, shares, principal, now }: EvaluateAccessInput): AccessDecision => {
	if (!site) return { allowed: false, reason: 'notFound' }

	if (principal.kind === 'owner' && principal.did === site.ownerDid) {
		return { allowed: true, reason: 'owner' }
	}

	if (isExpired(site.expiresAt, now)) {
		return { allowed: false, reason: 'siteExpired' }
	}

	// The session lookup has already rechecked the backing share's expiry and revocation.
	if (principal.kind === 'sessionShare') {
		return { allowed: true, reason: 'share', shareId: principal.shareId }
	}

	if (principal.kind !== 'shareToken') {
		return { allowed: false, reason: 'forbidden' }
	}

	const presented = hashShareTokenSync(principal.token)
	const matched =
		shares.find((share) => share.siteId === site.siteId && timingSafeEqualHex(share.tokenHash, presented)) ?? null

	if (!matched) {
		return { allowed: false, reason: 'forbidden' }
	}

	if (matched.revokedAt !== null) {
		return { allowed: false, reason: 'shareRevoked' }
	}

	if (isExpired(matched.expiresAt, now)) {
		return { allowed: false, reason: 'shareExpired' }
	}

	if (matched.audienceDid !== null && matched.audienceDid !== principal.viewerDid) {
		return { allowed: false, reason: 'audienceMismatch', audienceDid: matched.audienceDid }
	}

	return { allowed: true, reason: 'share', shareId: matched.shareId }
}
