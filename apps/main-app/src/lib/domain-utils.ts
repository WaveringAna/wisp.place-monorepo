import { BASE_HOST } from '@wispplace/constants'

const RESERVED_HANDLES = new Set([
	'www',
	'api',
	'admin',
	'static',
	'public',
	'preview',
	'slingshot',
	'plc',
	'constellation',
	'cdn',
	'pds',
	'staging',
	'auth'
])

const RESERVED_CUSTOM_DOMAINS = new Set([
	'localhost',
	'example.com',
	'example.org',
	'example.net',
	'test',
	'invalid',
	'local'
])

const RESERVED_CUSTOM_PATTERNS = [
	/^(?:10|127|172\.(?:1[6-9]|2[0-9]|3[01])|192\.168)\./,
	/^(?:\d{1,3}\.){3}\d{1,3}$/
]

const CUSTOM_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

export const normalizeDomain = (domain: string): string => {
	return domain.trim().toLowerCase().replace(/\.$/, '')
}

export const isValidHandle = (handle: string): boolean => {
	const normalized = handle.trim().toLowerCase()

	if (normalized.length < 3 || normalized.length > 63) return false
	if (!/^[a-z0-9-]+$/.test(normalized)) return false
	if (normalized.startsWith('-') || normalized.endsWith('-')) return false
	if (normalized.includes('--')) return false
	if (RESERVED_HANDLES.has(normalized)) return false

	return true
}

export const toDomain = (handle: string): string => `${handle.toLowerCase()}.${BASE_HOST}`

export const extractWispHandle = (domain: string): string | null => {
	const normalized = normalizeDomain(domain)
	const suffix = `.${BASE_HOST}`

	if (!normalized.endsWith(suffix)) {
		return null
	}

	const handle = normalized.slice(0, -suffix.length)
	if (handle.length === 0 || handle.includes('.')) {
		return null
	}

	return handle
}

export const validateCustomDomain = (domain: string): string | null => {
	const normalized = normalizeDomain(domain)

	if (normalized.length < 3 || normalized.length > 253) {
		return 'domain must be 3-253 characters'
	}

	if (!CUSTOM_DOMAIN_PATTERN.test(normalized)) {
		return 'invalid domain format'
	}

	const labels = normalized.split('.')
	for (const label of labels) {
		if (label.length === 0 || label.length > 63) {
			return 'domain labels must be 1-63 characters'
		}
		if (label.startsWith('-') || label.endsWith('-')) {
			return 'domain labels cannot start or end with hyphen'
		}
	}

	const tld = labels[labels.length - 1]
	if (tld.length < 2 || /^\d+$/.test(tld)) {
		return 'tld must be at least 2 characters and not all numeric'
	}

	if (!/^[a-z0-9.-]+$/.test(normalized)) {
		return 'domain must use ascii alphanumeric characters, dots, and hyphens'
	}

	if (RESERVED_CUSTOM_DOMAINS.has(normalized)) {
		return 'reserved or blocked domain'
	}

	for (const pattern of RESERVED_CUSTOM_PATTERNS) {
		if (pattern.test(normalized)) {
			return 'ip addresses are not allowed'
		}
	}

	return null
}
