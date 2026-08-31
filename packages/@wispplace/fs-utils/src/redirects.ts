export interface RedirectRule {
	from: string
	to: string
	status: number
	force: boolean
	conditions?: {
		country?: string[]
		language?: string[]
		role?: string[]
		cookie?: string[]
	}
	fromPattern?: RegExp
	fromParams?: string[]
	queryParams?: Record<string, string>
}

export interface RedirectMatch {
	rule: RedirectRule
	targetPath: string
	status: number
}

const MAX_REDIRECT_RULES = 1000
/** Maximum raw UTF-8 byte length accepted for a stored _redirects file. */
export const MAX_REDIRECT_FILE_BYTES = 1_000_000
const MAX_REDIRECT_FILE_CHARACTERS = MAX_REDIRECT_FILE_BYTES
const MAX_REDIRECT_LINE_LENGTH = 8_192
const MAX_REDIRECT_PATTERN_LENGTH = 2_048
const MAX_REDIRECT_REQUEST_PATH_LENGTH = 8_192
const MAX_REDIRECT_PATH_SEGMENTS = 128
const MAX_REDIRECT_PLACEHOLDERS = 32
const MAX_REDIRECT_QUERY_PARAMS = 32

interface PathSegment {
	prefix: string
	param?: string
	suffix: string
}

interface CompiledPath {
	segments: PathSegment[]
	params: string[]
	regex: RegExp
	splat?: { prefix: string; separator: boolean }
}

const compiledPaths = new WeakMap<RedirectRule, CompiledPath>()

/** Parse a bounded, user-controlled _redirects file. */
export function parseRedirectsFile(content: string): RedirectRule[] {
	const truncated = content.length > MAX_REDIRECT_FILE_CHARACTERS
	const limited = truncated ? content.slice(0, MAX_REDIRECT_FILE_CHARACTERS) : content
	const lines = limited.split('\n')
	if (truncated && !limited.endsWith('\n')) lines.pop()

	const rules: RedirectRule[] = []
	for (const rawLine of lines) {
		if (!rawLine || rawLine.length > MAX_REDIRECT_LINE_LENGTH) continue
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		if (rules.length >= MAX_REDIRECT_RULES) break

		try {
			const rule = parseRedirectLine(line)
			if (rule) rules.push(rule)
		} catch {
			// Invalid rules are ignored.
		}
	}
	return rules
}

type RedirectTextDecoder = (data: Uint8Array) => string
const redirectTextDecoder = new TextDecoder()

function decodeRedirectText(data: Uint8Array): string {
	return redirectTextDecoder.decode(data)
}

/**
 * Parse a stored _redirects byte buffer without ever decoding an oversized
 * value. `null` indicates rejection before decoder or parser allocation.
 */
export function parseRedirectsFileBytes(
	data: Uint8Array,
	decode: RedirectTextDecoder = decodeRedirectText,
): RedirectRule[] | null {
	if (data.byteLength > MAX_REDIRECT_FILE_BYTES) return null
	return parseRedirectsFile(decode(data))
}

function parseRedirectLine(line: string): RedirectRule | null {
	const parts = line.split(/\s+/)
	const from = parts[0]
	if (!from || parts.length < 2) return null

	let index = 1
	let status = 301
	let force = false
	const conditions: NonNullable<RedirectRule['conditions']> = {}
	const queryParams = createStringRecord()
	const queryStart = from.indexOf('?')

	if (queryStart !== -1) {
		for (const pair of from.slice(queryStart + 1).split('&')) {
			const equals = pair.indexOf('=')
			if (equals > 0 && equals < pair.length - 1) {
				setQueryParam(queryParams, safeDecode(pair.slice(0, equals)), safeDecode(pair.slice(equals + 1)))
			}
		}
	}

	while (index < parts.length) {
		const part = parts[index]
		if (!part) {
			index++
			continue
		}
		if (part.startsWith('/') || part.startsWith('http://') || part.startsWith('https://')) break

		const equals = part.indexOf('=')
		if (equals === -1) break
		if (equals > 0 && equals < part.length - 1) {
			setQueryParam(queryParams, part.slice(0, equals), part.slice(equals + 1))
		}
		index++
	}

	const to = parts[index++]
	if (!to) return null

	for (; index < parts.length; index++) {
		const part = parts[index]
		if (!part) continue
		if (/^\d+!?$/.test(part)) {
			const forced = part.endsWith('!')
			if (forced) force = true
			status = parseInt(forced ? part.slice(0, -1) : part, 10)
			continue
		}

		const equals = part.indexOf('=')
		if (equals <= 0 || equals === part.length - 1) continue
		const key = part.slice(0, equals).toLowerCase()
		const value = part.slice(equals + 1)
		switch (key) {
			case 'country':
				conditions.country = value.split(',').map((item) => item.trim().toLowerCase())
				break
			case 'language':
				conditions.language = value.split(',').map((item) => item.trim().toLowerCase())
				break
			case 'role':
				conditions.role = value.split(',').map((item) => item.trim())
				break
			case 'cookie':
				conditions.cookie = value.split(',').map((item) => item.trim().toLowerCase())
				break
		}
	}

	const compiled = compilePath(from)
	const rule: RedirectRule = {
		from,
		to,
		status,
		force,
		conditions: Object.keys(conditions).length ? conditions : undefined,
		queryParams: Object.keys(queryParams).length ? queryParams : undefined,
		fromPattern: compiled.regex,
		fromParams: compiled.params,
	}
	compiledPaths.set(rule, compiled)
	return rule
}

/**
 * Compile a deterministic pathname matcher. Source segments may contain one
 * named placeholder; ambiguous adjacent placeholders and param+splat segments
 * are rejected before a rule can be matched.
 */
function compilePath(rawPattern: string): CompiledPath {
	const queryStart = rawPattern.indexOf('?')
	const path = queryStart === -1 ? rawPattern : rawPattern.slice(0, queryStart)
	if (!path || path.length > MAX_REDIRECT_PATTERN_LENGTH) {
		throw new Error('Redirect path pattern is too long or empty')
	}

	const star = path.indexOf('*')
	if (star !== -1 && (star !== path.length - 1 || path.indexOf('*', star + 1) !== -1)) {
		throw new Error('Redirect splats must appear at most once and at the end of the path')
	}

	const params: string[] = []
	if (star === -1) {
		const segments = parsePathSegments(path, params)
		return { segments, params, regex: new RegExp(`^${pathRegex(segments)}/?$`) }
	}

	const beforeSplat = path.slice(0, -1)
	const slash = beforeSplat.lastIndexOf('/')
	const segments = slash === -1 ? [] : parsePathSegments(beforeSplat.slice(0, slash), params)
	const splat = { prefix: beforeSplat.slice(slash + 1), separator: slash !== -1 }
	if (parsePathSegment(splat.prefix, params).param) {
		throw new Error('Redirect splats cannot share a segment with a named placeholder')
	}
	addParam(params, 'splat')
	return {
		segments,
		params,
		splat,
		regex: new RegExp(`^${pathRegex(segments)}${splat.separator ? '/' : ''}${escapeRegex(splat.prefix)}(.*)$`),
	}
}

function parsePathSegments(path: string, params: string[]): PathSegment[] {
	const segments = path.split('/')
	if (segments.length > MAX_REDIRECT_PATH_SEGMENTS) throw new Error('Redirect path has too many segments')
	return segments.map((segment) => parsePathSegment(segment, params))
}

function parsePathSegment(segment: string, params: string[]): PathSegment {
	const placeholders = [...segment.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)]
	if (placeholders.length > 1) throw new Error('Redirect path segments may contain at most one named placeholder')
	const placeholder = placeholders[0]
	if (!placeholder) return { prefix: segment, suffix: '' }

	const [full, param] = placeholder
	if (!full || !param) throw new Error('Redirect placeholder is missing a name')
	addParam(params, param)
	return {
		prefix: segment.slice(0, placeholder.index),
		param,
		suffix: segment.slice(placeholder.index + full.length),
	}
}

function addParam(params: string[], param: string): void {
	if (params.length >= MAX_REDIRECT_PLACEHOLDERS) throw new Error('Redirect path has too many placeholders')
	params.push(param)
}

// Retained for RedirectRule compatibility; matching below is fully token based.
function pathRegex(segments: PathSegment[]): string {
	return segments
		.map(({ prefix, param, suffix }) => `${escapeRegex(prefix)}${param ? '([^/?]+)' : ''}${escapeRegex(suffix)}`)
		.join('/')
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getCompiledPath(rule: RedirectRule): CompiledPath | null {
	const cached = compiledPaths.get(rule)
	if (cached) return cached
	try {
		const compiled = compilePath(rule.from)
		compiledPaths.set(rule, compiled)
		return compiled
	} catch {
		return null
	}
}

function matchPath(compiled: CompiledPath, path: string, requestSegments: string[]): string[] | null {
	if (!compiled.splat) {
		const exact = matchSegments(compiled.segments, requestSegments)
		if (exact) return exact
		return requestSegments[requestSegments.length - 1] === ''
			? matchSegments(compiled.segments, requestSegments.slice(0, -1))
			: null
	}

	const captures = matchSegments(compiled.segments, requestSegments, false)
	if (!captures) return null
	let start = requestSegments.slice(0, compiled.segments.length).join('/').length
	if (compiled.splat.separator && path[start++] !== '/') return null
	if (!path.startsWith(compiled.splat.prefix, start)) return null
	return [...captures, path.slice(start + compiled.splat.prefix.length)]
}

function matchSegments(pattern: PathSegment[], request: string[], complete = true): string[] | null {
	if (request.length < pattern.length || (complete && request.length !== pattern.length)) return null

	const captures: string[] = []
	for (let index = 0; index < pattern.length; index++) {
		const segment = pattern[index]
		const value = request[index]
		if (!segment || value === undefined) return null
		if (!segment.param) {
			if (value !== segment.prefix) return null
			continue
		}
		if (!value.startsWith(segment.prefix) || !value.endsWith(segment.suffix)) return null

		const capture = value.slice(segment.prefix.length, value.length - segment.suffix.length)
		if (!capture || capture.includes('?')) return null
		captures.push(capture)
	}
	return captures
}

export interface MatchRedirectContext {
	queryParams?: Record<string, string>
	headers?: Record<string, string>
	cookies?: Record<string, string>
}

export function matchRedirectRule(
	requestPath: string,
	rules: RedirectRule[],
	context?: MatchRedirectContext,
	visitedPaths: Set<string> = new Set(),
): RedirectMatch | null {
	const path = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
	if (path.length > MAX_REDIRECT_REQUEST_PATH_LENGTH || visitedPaths.has(path)) return null
	visitedPaths.add(path)
	if (visitedPaths.size > 10) return null

	const requestSegments = path.split('/')
	for (const rule of rules) {
		if (!matchesQuery(rule.queryParams, context) || !matchesConditions(rule.conditions, context)) continue

		const compiled = getCompiledPath(rule)
		const captures = compiled && matchPath(compiled, path, requestSegments)
		if (!compiled || !captures) continue

		let targetPath = rule.to
		for (const [index, param] of (rule.fromParams ?? compiled.params).entries()) {
			const value = captures[index]
			if (!param || value === undefined) continue
			const encoded = encodeURIComponent(value)
			targetPath = targetPath.replace(
				param === 'splat' ? ':splat' : `:${param}`,
				param === 'splat' ? encoded.replace(/%2F/g, '/') : encoded,
			)
		}

		if (rule.queryParams && context?.queryParams) {
			for (const [key, placeholder] of Object.entries(rule.queryParams)) {
				const value = context.queryParams[key]
				const param = placeholder?.startsWith(':') ? placeholder.slice(1) : ''
				if (value && param) targetPath = targetPath.replace(`:${param}`, encodeURIComponent(value))
			}
		}

		if ([200, 301, 302].includes(rule.status) && context?.queryParams && !targetPath.includes('?')) {
			const query = Object.entries(context.queryParams)
				.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
				.join('&')
			if (query) targetPath += `?${query}`
		}
		return { rule, targetPath, status: rule.status }
	}
	return null
}

function matchesQuery(expected: RedirectRule['queryParams'], context?: MatchRedirectContext): boolean {
	if (!expected) return true
	const actual = context?.queryParams
	return Boolean(
		actual &&
			Object.entries(expected).every(([key, value]) => {
				const received = actual[key]
				return received !== undefined && (!value || value.startsWith(':') || received === value)
			}),
	)
}

function matchesConditions(conditions: RedirectRule['conditions'], context?: MatchRedirectContext): boolean {
	if (!conditions) return true
	if (conditions.role) return false

	if (conditions.country) {
		const country = context?.headers?.['cf-ipcountry']?.toLowerCase() || context?.headers?.['x-country']?.toLowerCase()
		if (!country || !conditions.country.includes(country)) return false
	}
	if (conditions.language) {
		const header = context?.headers?.['accept-language']
		if (!header) return false
		const languages = header
			.split(',')
			.map((value) => (value.split(';')[0] || '').trim().toLowerCase())
			.filter((value) => value !== '')
		if (
			!conditions.language.some((language) =>
				languages.some((value) => value === language || value.startsWith(`${language}-`)),
			)
		) {
			return false
		}
	}
	if (conditions.cookie) {
		const cookies = context?.cookies
		if (!cookies || !conditions.cookie.some((name) => name in cookies)) return false
	}
	return true
}

export function parseCookies(cookieHeader?: string): Record<string, string> {
	if (!cookieHeader) return {}
	const cookies = createStringRecord()
	for (const part of cookieHeader.split(';')) {
		const equals = part.indexOf('=')
		if (equals > 0) cookies[part.slice(0, equals).trim()] = part.slice(equals + 1).trim()
	}
	return cookies
}

/** Empty pairs/keys are ignored; bare keys have empty values; bad escapes stay raw. */
export function parseQueryString(url: string): Record<string, string> {
	const start = url.indexOf('?')
	if (start === -1) return {}

	const params = createStringRecord()
	for (const pair of url.slice(start + 1).split('&')) {
		if (!pair) continue
		const equals = pair.indexOf('=')
		const key = equals === -1 ? pair : pair.slice(0, equals)
		if (key) setQueryParam(params, safeDecode(key), safeDecode(equals === -1 ? '' : pair.slice(equals + 1)))
	}
	return params
}

function createStringRecord(): Record<string, string> {
	return Object.create(null) as Record<string, string>
}

function setQueryParam(params: Record<string, string>, key: string, value: string): void {
	if (!key || (!(key in params) && Object.keys(params).length >= MAX_REDIRECT_QUERY_PARAMS)) return
	params[key] = value
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}
