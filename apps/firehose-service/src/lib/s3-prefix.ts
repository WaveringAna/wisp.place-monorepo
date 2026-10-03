const DEFAULT_S3_PREFIX = 'sites/'
const MAX_S3_PREFIX_LENGTH = 512

function hasUnsafeCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0
		return character === '\\' || code <= 0x1f || code === 0x7f || character.trim() === ''
	})
}

/**
 * The key prefix site objects live under. Hosting reads with the same rules: an empty value means
 * the default, and the result always ends in a slash.
 */
export function resolveS3Prefix(value: string | undefined): string {
	const rawPrefix = value === undefined || value === '' ? DEFAULT_S3_PREFIX : value
	const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`
	if (
		prefix.length > MAX_S3_PREFIX_LENGTH ||
		prefix.startsWith('/') ||
		hasUnsafeCharacter(prefix) ||
		prefix.split('/').some((segment) => segment === '.' || segment === '..')
	) {
		throw new Error('Invalid S3_PREFIX')
	}
	return prefix
}
