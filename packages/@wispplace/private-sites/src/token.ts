import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const SHARE_TOKEN_PREFIX = 'wss_'
const SHARE_TOKEN_BYTES = 16
const DISPLAY_PREFIX_LENGTH = 6

export interface GeneratedShareToken {
	token: string
	tokenHash: string
	tokenPrefix: string
}

export const generateShareToken = (): GeneratedShareToken => {
	const token = `${SHARE_TOKEN_PREFIX}${randomBytes(SHARE_TOKEN_BYTES).toString('base64url')}`
	return {
		token,
		tokenHash: hashShareTokenSync(token),
		tokenPrefix: token.slice(0, SHARE_TOKEN_PREFIX.length + DISPLAY_PREFIX_LENGTH),
	}
}

export const hashShareTokenSync = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

export const timingSafeEqualHex = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false
	try {
		return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
	} catch {
		return false
	}
}
