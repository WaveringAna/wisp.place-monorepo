import { DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES, MAX_PRIVATE_SITE_EXPIRY_MINUTES } from '@wispplace/constants'
import type { ResolvedExpiry } from './types'

export class InvalidExpiryError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'InvalidExpiryError'
	}
}

export interface ResolveExpiryOptions {
	expiryMinutes?: number | null
	now: Date
	defaultMinutes?: number
	clampTo?: Date | null
}

export const resolveExpiry = ({
	expiryMinutes,
	now,
	defaultMinutes = DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES,
	clampTo = null,
}: ResolveExpiryOptions): ResolvedExpiry => {
	const omitted = expiryMinutes === undefined || expiryMinutes === null
	const requested = omitted ? defaultMinutes : expiryMinutes

	if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested < 0) {
		throw new InvalidExpiryError('expiryMinutes must be a non-negative integer')
	}
	if (requested > MAX_PRIVATE_SITE_EXPIRY_MINUTES) {
		throw new InvalidExpiryError(`expiryMinutes must be at most ${MAX_PRIVATE_SITE_EXPIRY_MINUTES}`)
	}
	if (requested === 0) {
		return {
			expiresAt: clampTo ?? null,
			neverExpires: clampTo === null,
			usedDefault: omitted,
		}
	}

	const expiresAt = new Date(now.getTime() + requested * 60_000)
	const clamped = clampTo !== null && expiresAt.getTime() > clampTo.getTime() ? clampTo : expiresAt

	return { expiresAt: clamped, neverExpires: false, usedDefault: omitted }
}
