/**
 * Simple glob pattern matching for key placement rules.
 *
 * Supports:
 * - `*` matches any characters except `/`
 * - `**` matches any characters including `/` (including empty string)
 * - `{a,b,c}` matches any of the alternatives
 * - Exact strings match exactly
 */
export function matchGlob(pattern: string, key: string): boolean {
	// Handle exact match
	if (!pattern.includes('*') && !pattern.includes('{')) {
		return pattern === key
	}

	// Escape regex special chars (except * and {})
	let regex = pattern.replace(/[.+^$|\\()[\]]/g, '\\$&')

	// Handle {a,b,c} alternation
	regex = regex.replace(/\{([^}]+)\}/g, (_match: string, alts: string) => `(${alts.split(',').join('|')})`)

	// Use placeholder to avoid double-processing
	const DOUBLE = '\x00DOUBLE\x00'
	const SINGLE = '\x00SINGLE\x00'

	// Mark ** and * with placeholders
	regex = regex.replace(/\*\*/g, DOUBLE)
	regex = regex.replace(/\*/g, SINGLE)

	// Replace placeholders with regex patterns
	// ** matches anything (including /)
	// When followed by /, it's optional (matches zero or more path segments)
	regex = regex
		.replace(new RegExp(`${DOUBLE}/`, 'g'), '(?:.*/)?') // **/ -> optional path prefix
		.replace(new RegExp(`/${DOUBLE}`, 'g'), '(?:/.*)?') // /** -> optional path suffix
		.replace(new RegExp(DOUBLE, 'g'), '.*') // ** alone -> match anything
		.replace(new RegExp(SINGLE, 'g'), '[^/]*') // * -> match non-slash

	return new RegExp(`^${regex}$`).test(key)
}
