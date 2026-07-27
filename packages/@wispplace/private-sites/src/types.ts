export interface PrivateSite {
	siteId: string
	ownerDid: string
	name: string
	fileCount: number
	totalBytes: number
	expiresAt: Date | null
	createdAt: Date
	updatedAt: Date
}

export interface PrivateSiteShare {
	shareId: string
	siteId: string
	tokenHash: string
	tokenPrefix: string
	label: string | null
	audienceDid: string | null
	expiresAt: Date | null
	revokedAt: Date | null
	createdAt: Date
	lastUsedAt: Date | null
}

export type AccessPrincipal =
	| { kind: 'owner'; did: string }
	| { kind: 'shareToken'; token: string; viewerDid?: string | null }
	| { kind: 'sessionShare'; shareId: string }
	| { kind: 'anonymous' }

export type AccessDenialReason =
	| 'notFound'
	| 'siteExpired'
	| 'shareExpired'
	| 'shareRevoked'
	| 'forbidden'
	| 'audienceMismatch'

export type AccessDecision =
	| { allowed: true; reason: 'owner' }
	| { allowed: true; reason: 'share'; shareId: string }
	| { allowed: false; reason: 'audienceMismatch'; audienceDid: string }
	| { allowed: false; reason: Exclude<AccessDenialReason, 'audienceMismatch'> }

export interface ResolvedExpiry {
	expiresAt: Date | null
	neverExpires: boolean
	usedDefault: boolean
}
