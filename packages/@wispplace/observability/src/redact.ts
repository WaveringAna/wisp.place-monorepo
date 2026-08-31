// Redact at the observability boundary so callers cannot accidentally leak credentials.
const SECRET_SEGMENT_PREFIXES = ['/p/']

const REDACTED = '<redacted>'
const CIRCULAR = '<circular>'
const TRUNCATED = '<truncated>'
const UNREADABLE = '<unreadable>'
const MAX_DEPTH = 8
const MAX_NODES = 200
const MAX_COLLECTION_ENTRIES = 50
const MAX_STRING_LENGTH = 4096

const SENSITIVE_KEY_NAMES = new Set([
	'auth',
	'authorization',
	'proxyauthorization',
	'authentication',
	'cookie',
	'cookies',
	'setcookie',
	'password',
	'passwd',
	'pwd',
	'token',
	'accesstoken',
	'refreshtoken',
	'idtoken',
	'bearertoken',
	'jwt',
	'secret',
	'secretkey',
	'clientsecret',
	'privatekey',
	'signingkey',
	'encryptionkey',
	'apikey',
	'accesskey',
	'credential',
	'credentials',
	'connectionstring',
	'connectionurl',
	'connectionuri',
	'databaseurl',
	'databaseuri',
	'dburl',
	'dburi',
	'postgresurl',
	'postgresqlurl',
	'redisurl',
	'redissurl',
	'dsn',
	'session',
	'sessiontoken',
	'sessionid',
])

const SENSITIVE_KEY_SUFFIXES = [
	'authorization',
	'authentication',
	'cookie',
	'password',
	'passwd',
	'credential',
	'token',
	'secret',
	'apikey',
]
const SENSITIVE_QUERY_PARAMETER_NAMES = new Set([
	'code',
	'state',
	'signature',
	'sig',
	'key',
	'session',
	'sid',
	'k',
	'g',
])

const URL_USERINFO_PATTERN = /\b((?:postgres(?:ql)?|rediss?|https?):\/\/)[^/?#\s]*@/gi
const URL_START_PATTERN = /\b(?:postgres(?:ql)?|rediss?|https?):\/\//gi
const URL_SECRET_PATH_PATTERN = /\b(https?:\/\/[^/?#\s]+)\/p\/[^/?#\s]+/gi
const SECRET_PATH_PATTERN = /(^|[\s("'=])\/p\/[^/?#\s]+/g
const AUTH_VALUE_PATTERN = /\b(Bearer|Basic)\s+[^\s,;]+/gi
const PRIVATE_QUERY_PARAMETER_PATTERN = /([?&;]|%(?:3f|26|3b))(k|g)(=|%3d)[^&#\s]*/gi
const BARE_PRIVATE_QUERY_PARAMETER_PATTERN = /([?&;]|%(?:3f|26|3b))(k|g)(?=(?:[&#;\s]|%(?:26|3b|3f)|$))/gi
const QUERY_PARAMETER_PATTERN = /([?&;])([^=&#\s]+)=([^&#\s]*)/g
const PRIVATE_TOKEN_PATTERN = /(^|[^A-Za-z0-9]|%3d)(?:wss|wsh|wsx)(?:_|%5f)[A-Za-z0-9%._-]+/gi
const INLINE_SECRET_PATTERN =
	/((?:^|[\s{,;])["']?([A-Za-z_$][A-Za-z0-9_$.-]*)["']?\s*[:=]\s*)(?:(?:Bearer|Basic)\s+[^\s,;}\]]+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}\]]+)/gi

export type SanitizedValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| SanitizedValue[]
	| { [key: string]: SanitizedValue }

export interface SanitizedError {
	name: string
	message: string
	stack?: string
}

interface SanitizationState {
	seen: WeakSet<object>
	remainingNodes: number
}

const unreadableValue = Symbol('unreadable')

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitiveKeyName(key: string): boolean {
	const normalized = normalizeKey(key)
	return (
		SENSITIVE_KEY_NAMES.has(normalized) ||
		SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
		/(?:api|access|secret|private|signing|encryption|client|aws)key$/.test(normalized)
	)
}

function isSensitiveQueryParameter(name: string): boolean {
	try {
		name = decodeURIComponent(name.replace(/\+/g, ' '))
	} catch {
		// Keep malformed query parameter names unchanged.
	}
	const normalized = normalizeKey(name)
	return SENSITIVE_QUERY_PARAMETER_NAMES.has(normalized) || normalized.endsWith('signature') || isSensitiveKeyName(name)
}

function truncateUnfinishedUrl(value: string): string {
	let unsafeStart = -1
	URL_START_PATTERN.lastIndex = 0
	for (let match = URL_START_PATTERN.exec(value); match; match = URL_START_PATTERN.exec(value)) {
		if (!/[/?#\s@]/.test(value.slice(match.index + match[0].length))) unsafeStart = match.index
	}
	return unsafeStart === -1 ? value : value.slice(0, unsafeStart)
}

/** Sanitize credentials in free-form text such as messages and stacks. */
export function sanitizeLogString(value: string): string {
	const wasTruncated = value.length > MAX_STRING_LENGTH
	let bounded = wasTruncated ? value.slice(0, MAX_STRING_LENGTH) : value
	if (wasTruncated) bounded = truncateUnfinishedUrl(bounded)

	const sanitized = bounded
		.replace(URL_USERINFO_PATTERN, '$1<redacted>@')
		.replace(URL_SECRET_PATH_PATTERN, '$1/p/<redacted>')
		.replace(SECRET_PATH_PATTERN, '$1/p/<redacted>')
		.replace(
			PRIVATE_QUERY_PARAMETER_PATTERN,
			(_match, separator: string, name: string, assignment: string) => `${separator}${name}${assignment}${REDACTED}`,
		)
		.replace(
			BARE_PRIVATE_QUERY_PARAMETER_PATTERN,
			(_match, separator: string, name: string) => `${separator}${name}=${REDACTED}`,
		)
		.replace(QUERY_PARAMETER_PATTERN, (match, separator: string, name: string) =>
			isSensitiveQueryParameter(name) ? `${separator}${name}=${REDACTED}` : match,
		)
		.replace(PRIVATE_TOKEN_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
		.replace(AUTH_VALUE_PATTERN, '$1 <redacted>')
		.replace(INLINE_SECRET_PATTERN, (match, prefix: string, key: string) => {
			if (!isSensitiveKeyName(key)) return match
			const rawValue = match.slice(prefix.length)
			const quote = rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue[0] : ''
			return `${prefix}${quote}${REDACTED}${quote}`
		})

	return wasTruncated ? `${sanitized}${TRUNCATED}` : sanitized
}

function readProperty(value: object, key: string): unknown | typeof unreadableValue {
	try {
		return (value as Record<string, unknown>)[key]
	} catch {
		return unreadableValue
	}
}

function isError(value: object): boolean {
	try {
		return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]'
	} catch {
		return false
	}
}

function errorDetails(error: object): SanitizedError {
	const name = readProperty(error, 'name')
	const message = readProperty(error, 'message')
	const stack = readProperty(error, 'stack')
	const details: SanitizedError = {
		name: typeof name === 'string' ? sanitizeLogString(name) : 'Error',
		message: typeof message === 'string' ? sanitizeLogString(message) : '',
	}
	if (typeof stack === 'string') details.stack = sanitizeLogString(stack)
	return details
}

function sanitizeProperties(
	value: object,
	output: { [key: string]: SanitizedValue },
	state: SanitizationState,
	depth: number,
	ignoredKeys: ReadonlySet<string> = new Set(),
): void {
	let keys: string[]
	try {
		keys = Object.keys(value)
	} catch {
		output.details = UNREADABLE
		return
	}

	for (const key of keys.slice(0, MAX_COLLECTION_ENTRIES)) {
		if (state.remainingNodes <= 0) {
			output.__truncated__ = TRUNCATED
			return
		}
		if (ignoredKeys.has(key)) continue

		const property = readProperty(value, key)
		output[sanitizeLogString(key)] = isSensitiveKeyName(key)
			? REDACTED
			: property === unreadableValue
				? UNREADABLE
				: sanitizeValue(property, state, depth + 1)
	}

	if (keys.length > MAX_COLLECTION_ENTRIES) output.__truncated__ = TRUNCATED
}

function sanitizeErrorValue(error: object, state: SanitizationState, depth: number): SanitizedValue {
	const details = errorDetails(error)
	const output = Object.create(null) as { [key: string]: SanitizedValue }
	output.name = details.name
	output.message = details.message
	if (details.stack) output.stack = details.stack

	const cause = readProperty(error, 'cause')
	if (cause !== unreadableValue && cause !== undefined) output.cause = sanitizeValue(cause, state, depth + 1)
	sanitizeProperties(error, output, state, depth, new Set(['name', 'message', 'stack', 'cause']))
	return output
}

function sanitizeArray(value: unknown[], state: SanitizationState, depth: number): SanitizedValue[] {
	const output: SanitizedValue[] = []
	const length = Math.min(value.length, MAX_COLLECTION_ENTRIES)
	for (let index = 0; index < length; index++) {
		if (state.remainingNodes <= 0) {
			output.push(TRUNCATED)
			break
		}
		const item = readProperty(value, String(index))
		output.push(item === unreadableValue ? UNREADABLE : sanitizeValue(item, state, depth + 1))
	}
	if (value.length > length) output.push(TRUNCATED)
	return output
}

function sanitizeValue(value: unknown, state: SanitizationState, depth: number): SanitizedValue {
	if (state.remainingNodes <= 0 || depth > MAX_DEPTH) return TRUNCATED
	state.remainingNodes--

	if (typeof value === 'string') return sanitizeLogString(value)
	if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
	if (typeof value === 'bigint') return `${value}n`
	if (typeof value === 'symbol') return '<symbol>'
	if (typeof value === 'function') return '<function>'
	if (state.seen.has(value)) return CIRCULAR
	state.seen.add(value)

	if (isError(value)) return sanitizeErrorValue(value, state, depth)
	try {
		if (typeof URL !== 'undefined' && value instanceof URL) return sanitizeLogString(value.toString())
		if (value instanceof Date) return value.toISOString()
		if (ArrayBuffer.isView(value)) return `[${Object.prototype.toString.call(value)} length=${value.byteLength}]`
		if (value instanceof ArrayBuffer) return `[ArrayBuffer length=${value.byteLength}]`
		if (Array.isArray(value)) return sanitizeArray(value, state, depth)
	} catch {
		return UNREADABLE
	}

	const output: { [key: string]: SanitizedValue } = Object.create(null) as { [key: string]: SanitizedValue }
	sanitizeProperties(value, output, state, depth)
	return output
}

/** Return a JSON-safe, bounded copy that is safe to store or export. */
export function sanitizeForLog(value: unknown): SanitizedValue {
	return sanitizeValue(value, { seen: new WeakSet(), remainingNodes: MAX_NODES }, 0)
}

/** Preserve Error kind/message fields while sanitizing their textual details. */
export function sanitizeError(error: unknown): SanitizedError | undefined {
	if (typeof error !== 'object' || error === null || !isError(error)) return undefined
	return errorDetails(error)
}

/** Convert caller context into a safe record without retaining input references. */
export function sanitizeContext(context: unknown): Record<string, SanitizedValue> | undefined {
	if (context === undefined) return undefined
	const sanitized = sanitizeForLog(context)
	if (typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)) return sanitized
	return { value: sanitized }
}

export const redactSecretPath = (pathname: string): string => {
	const sanitizedPath = sanitizeLogString(pathname)
	for (const prefix of SECRET_SEGMENT_PREFIXES) {
		if (sanitizedPath.startsWith(prefix)) {
			const rest = sanitizedPath.slice(prefix.length)
			if (rest.length === 0) return sanitizedPath
			const slash = rest.indexOf('/')
			return slash === -1 ? `${prefix}<redacted>` : `${prefix}<redacted>${rest.slice(slash)}`
		}
	}
	return sanitizedPath
}
