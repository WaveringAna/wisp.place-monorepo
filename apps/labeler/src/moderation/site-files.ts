/**
 * What triage reads of a site: every path in its manifest (site_cache.file_cids,
 * which the firehose writes after expanding subfs records), ranked so entry pages,
 * HTML and scripts come first, fetched within fixed bounds from the shared host.
 */

export const SITE_LIMITS = {
	/** Files fetched besides `/`. */
	files: 16,
	rootBytes: 512 * 1024,
	fileBytes: 256 * 1024,
	totalBytes: 2 * 1024 * 1024,
	fileTimeoutMs: 20_000,
	deadlineMs: 90_000,
	redirects: 3,
	/** Paths listed to the model, fetched or not. */
	listedPaths: 80,
	descriptionChars: 16_000,
	sectionChars: 3_000,
}
export type SiteLimits = typeof SITE_LIMITS

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	'#39': "'",
	apos: "'",
	nbsp: ' ',
}
export const decodeEntities = (s: string) =>
	s.replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (m, e: string) => {
		const named = NAMED_ENTITIES[e.toLowerCase()]
		if (named) return named
		const code = e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
		return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
	})

export type FileKind = 'html' | 'script' | 'text' | 'style' | 'download' | 'other'

const EXTENSION_KINDS: Record<string, FileKind> = {
	html: 'html',
	htm: 'html',
	xhtml: 'html',
	svg: 'html',
	js: 'script',
	mjs: 'script',
	cjs: 'script',
	txt: 'text',
	md: 'text',
	json: 'text',
	xml: 'text',
	webmanifest: 'text',
	css: 'style',
}
const DOWNLOAD = /\.(exe|msi|scr|bat|cmd|ps1|vbs|jar|apk|ipa|dmg|pkg|deb|rpm|appimage|zip|rar|7z|iso)$/i
const KIND_ORDER: FileKind[] = ['html', 'script', 'text', 'style']
const LURE = /(log-?in|sign-?in|verif|account|secure|password|wallet|bank|mail|update|confirm|auth|recover)/i

export function fileKind(path: string, contentType = ''): FileKind {
	const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
	if (type === 'text/html' || type === 'application/xhtml+xml' || type === 'image/svg+xml') return 'html'
	if (type.includes('javascript')) return 'script'
	if (type === 'text/css') return 'style'
	if (DOWNLOAD.test(path)) return 'download'
	const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? ''
	return EXTENSION_KINDS[ext] ?? (type.startsWith('text/') ? 'text' : 'other')
}

/** A manifest path that stays inside the site once it is put in a URL. */
export function isSafePath(path: string): boolean {
	if (!path || path.length > 512) return false
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
	if (/[\u0000-\u001f\u007f\\]/.test(path)) return false
	return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

/**
 * The paths to fetch besides `/`, best first: HTML, then scripts, text and styles;
 * within a kind, top-level and login-looking pages first, then by depth.
 */
export function planFiles(paths: readonly string[], limit: number): string[] {
	const rank = (path: string) => {
		const kind = KIND_ORDER.indexOf(fileKind(path))
		const depth = path.split('/').length - 1
		const entry = kind === 0 && (depth === 0 || LURE.test(path)) ? 0 : 1
		return [kind, entry, depth, path.length] as const
	}
	return paths
		.filter((p) => isSafePath(p) && KIND_ORDER.includes(fileKind(p)))
		.map((path) => ({ path, rank: rank(path) }))
		.sort((a, b) => {
			for (let i = 0; i < a.rank.length; i++) {
				const d = (a.rank[i] ?? 0) - (b.rank[i] ?? 0)
				if (d) return d
			}
			return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
		})
		.slice(0, limit)
		.map((f) => f.path)
}

/** Why a file has no body: no response in time, a network error, an off-site redirect, or no budget left. */
export type FetchError = 'timeout' | 'network' | 'redirect' | 'budget'

export type FetchedFile = {
	/** `/` for the site root, else the manifest path. */
	path: string
	/** 0 when nothing answered. */
	status: number
	error?: FetchError
	/** Where an off-site redirect pointed; it is not followed. */
	redirect?: string
	contentType: string
	body: string
	bytes: number
	truncated: boolean
}

async function readCapped(
	res: Response,
	maxBytes: number,
): Promise<{ body: string; bytes: number; truncated: boolean }> {
	const reader = res.body?.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	while (reader && size < maxBytes) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		size += value.length
	}
	const truncated = size >= maxBytes
	await reader?.cancel().catch(() => {})
	const bytes = Math.min(size, maxBytes)
	return { body: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes)), bytes, truncated }
}

/**
 * GET one file under `base` (https://<shared host>/<did>/<rkey>/). Redirects are
 * followed only while they stay under `base`, so a site's _redirects cannot point
 * this service at another host.
 */
export async function fetchSiteFile(
	base: string,
	path: string,
	maxBytes: number,
	{
		fetchImpl = fetch,
		signal,
		limits = SITE_LIMITS,
	}: { fetchImpl?: typeof fetch; signal?: AbortSignal; limits?: SiteLimits } = {},
): Promise<FetchedFile> {
	const empty = { path, contentType: '', body: '', bytes: 0, truncated: false }
	const prefix = new URL(base)
	let url = new URL(path === '/' ? '' : path.split('/').map(encodeURIComponent).join('/'), prefix)
	const timeout = AbortSignal.timeout(limits.fileTimeoutMs)
	const both = signal ? AbortSignal.any([signal, timeout]) : timeout
	try {
		for (let hop = 0; ; hop++) {
			const res = await fetchImpl(url, {
				headers: { 'User-Agent': 'wisp-moderation (+https://moderation.wisp.place)' },
				redirect: 'manual',
				signal: both,
			})
			const location = res.headers.get('location')
			if (res.status >= 300 && res.status < 400 && location) {
				await res.body?.cancel().catch(() => {})
				const next = new URL(location, url)
				const inside = next.origin === prefix.origin && next.pathname.startsWith(prefix.pathname)
				if (!inside || hop >= limits.redirects)
					return { ...empty, status: res.status, error: 'redirect', redirect: shortUrl(next.href) }
				url = next
				continue
			}
			const contentType = res.headers.get('content-type') ?? ''
			if (res.status !== 200) {
				await res.body?.cancel().catch(() => {})
				return { ...empty, status: res.status, contentType }
			}
			return { ...empty, status: 200, contentType, ...(await readCapped(res, maxBytes)) }
		}
	} catch (error) {
		const name = (error as Error).name
		return { ...empty, status: 0, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' }
	}
}

/** `/` and then the planned files, one at a time, within the byte and time budget. */
export async function fetchSite(
	base: string,
	paths: readonly string[],
	{ fetchImpl = fetch, limits = SITE_LIMITS }: { fetchImpl?: typeof fetch; limits?: SiteLimits } = {},
): Promise<FetchedFile[]> {
	const deadline = AbortSignal.timeout(limits.deadlineMs)
	const options = { fetchImpl, signal: deadline, limits }
	const root = await fetchSiteFile(base, '/', limits.rootBytes, options)
	// `/` already serves the top-level index page when it answers
	const planned = planFiles(
		paths.filter((p) => root.status !== 200 || !/^index\.html?$/i.test(p)),
		limits.files,
	)
	const out = [root]
	let left = limits.totalBytes - root.bytes
	for (const path of planned) {
		if (left <= 0 || deadline.aborted) {
			out.push({ path, status: 0, error: 'budget', contentType: '', body: '', bytes: 0, truncated: false })
			continue
		}
		const file = await fetchSiteFile(base, path, Math.min(limits.fileBytes, left), options)
		left -= file.bytes
		out.push(file)
	}
	return out
}

/** What a model sees of a URL: host and the first path segments, with token- or id-like segments and the query dropped. */
export function shortUrl(href: string): string {
	try {
		const u = new URL(href)
		const segments = u.pathname.split('/').filter(Boolean)
		const kept = segments.slice(0, 3).map((s) => (s.length > 24 || /\d{8}/.test(s) ? '…' : s))
		return `${u.host}${kept.length ? `/${kept.join('/')}` : ''}${segments.length > 3 ? '/…' : ''}`
	} catch {
		return ''
	}
}

export type Signal =
	| 'password field'
	| 'payment card field'
	| 'webhook or bot endpoint'
	| 'sends data'
	| 'captures keystrokes'
	| 'looks up visitor IP'
	| 'blocks inspection'
	| 'form posts off-site'
	| 'redirects off-site'

/** Endpoints a static page has no honest reason to send a visitor's input to. */
const EXFIL =
	/(discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|hooks\.slack\.com\/|webhook\.site|\.m\.pipedream\.net|script\.google\.com\/macros)/i
const SIGNAL_PATTERNS: [Signal, RegExp][] = [
	['password field', /<input\b[^<>]*\btype\s*=\s*["']?password|\.type\s*=\s*["']password["']/i],
	['payment card field', /autocomplete\s*=\s*["']?cc-(number|csc)|\b(name|id)\s*=\s*["']?(card.?number|cvv|cvc)\b/i],
	['webhook or bot endpoint', EXFIL],
	['sends data', /\bfetch\s*\(|XMLHttpRequest|sendBeacon|\$\.(ajax|post)\s*\(|\baxios\.(post|get)\s*\(/],
	[
		'captures keystrokes',
		/addEventListener\(\s*["'](keydown|keyup|keypress|input)["']|\bonkey(down|up|press)\s*=|\.on(keydown|keyup|keypress|input)\s*=/i,
	],
	[
		'looks up visitor IP',
		/(api\.ipify\.org|ipapi\.co|ip-api\.com|ipinfo\.io|ipwho\.is|ipgeolocation\.io|geolocation-db\.com)/i,
	],
	['blocks inspection', /["']contextmenu["'][\s\S]{0,120}preventDefault|["']F12["']|keyCode\s*===?\s*123\b/],
]

export type FormFacts = { action: string; method: string; inputs: string[] }

export type FileFacts = {
	path: string
	status: number
	kind: FileKind
	bytes: number
	truncated: boolean
	title: string
	text: string
	forms: FormFacts[]
	scripts: { inline: number; src: string[]; excerpt: string }
	/** Absolute URLs anywhere in the file, shortened. */
	urls: string[]
	hosts: string[]
	signals: Signal[]
}

const attr = (tag: string, name: string) =>
	decodeEntities(
		tag
			.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
			?.slice(1)
			.find((v) => v !== undefined) ?? '',
	)

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const LOOKS_HTML = /<(!doctype html|html|head|body|title|form|script|div|p|h1|a)\b/i
const TAG_END = /[\s/>]/

type Block = { open: string; inner: string; start: number; end: number }

/**
 * The `<tag ...>inner</tag>` blocks of a page by plain index scanning. A regex with a
 * lazy body backtracks to the end of the page for every unclosed tag, which a hostile
 * 512 KiB page turns into minutes; this stays linear. An unclosed block runs to the end.
 */
function blocks(body: string, lower: string, tag: string, limit = Number.POSITIVE_INFINITY): Block[] {
	const out: Block[] = []
	let at = 0
	while (out.length < limit) {
		const start = lower.indexOf(`<${tag}`, at)
		if (start < 0) break
		if (!TAG_END.test(lower[start + tag.length + 1] ?? '')) {
			at = start + 1
			continue
		}
		const openEnd = lower.indexOf('>', start)
		if (openEnd < 0) break
		const close = lower.indexOf(`</${tag}`, openEnd)
		const innerEnd = close < 0 ? body.length : close
		const end = close < 0 ? body.length : lower.indexOf('>', close) + 1 || body.length
		out.push({ open: body.slice(start, openEnd + 1), inner: body.slice(openEnd + 1, innerEnd), start, end })
		at = end
	}
	return out
}

/** Text a reader sees: no scripts, styles or title, no tags. */
function visibleText(body: string, lower: string): string {
	const hidden = ['script', 'style', 'noscript', 'title']
		.flatMap((tag) => blocks(body, lower, tag))
		.sort((a, b) => a.start - b.start)
	let kept = ''
	let at = 0
	for (const b of hidden) {
		if (b.start < at) continue
		kept += `${body.slice(at, b.start)} `
		at = b.end
	}
	kept += body.slice(at)
	// [^<>] rather than [^>]: an unclosed `<` then fails at the next `<`, not at the end of the page
	return decodeEntities(squash(kept.replace(/<[^<>]*>/g, ' ')))
}

function formFacts(form: Block): FormFacts {
	const inputs = [...form.inner.matchAll(/<(input|textarea|select)\b[^<>]*>/gi)]
		.map(([t, tag]) => {
			const type = attr(t, 'type') || (tag?.toLowerCase() === 'input' ? 'text' : (tag?.toLowerCase() ?? 'text'))
			const name = attr(t, 'name') || attr(t, 'id')
			return name ? `${name}:${type}` : type
		})
		.filter((i) => !/(^|:)(hidden|submit|button)$/.test(i))
	return {
		action: attr(form.open, 'action'),
		method: (attr(form.open, 'method') || 'get').toLowerCase(),
		inputs: inputs.slice(0, 12),
	}
}

/** Title, visible text, forms, scripts, absolute URLs and risk signals of one fetched file. */
export function readFile(file: FetchedFile, sharedHost: string, textChars: number): FileFacts {
	const body = file.body
	// ASCII-only, so every index into `lower` is an index into `body`
	const lower = body.replace(/[A-Z]+/g, (c) => c.toLowerCase())
	const declared = file.status === 200 ? fileKind(file.path, file.contentType) : 'other'
	// `/` and extensionless paths often come without a useful type; read markup as markup
	const kind = (declared === 'text' || declared === 'other') && LOOKS_HTML.test(body.slice(0, 2048)) ? 'html' : declared
	const html = kind === 'html'
	const hrefs = [...body.matchAll(/https?:\/\/[^\s"'`<>()\\]+/gi)].map(([u]) => u)
	const urls = [...new Set(hrefs.map(shortUrl).filter((u) => u && !u.startsWith(`${sharedHost}/`)))].slice(0, 20)
	const hosts = [...new Set(urls.map((u) => u.split('/')[0] ?? ''))].filter(Boolean).sort()
	const forms = html ? blocks(body, lower, 'form', 5).map(formFacts) : []
	const scripts = html ? blocks(body, lower, 'script', 50) : []
	const inline = scripts.filter((b) => !/\bsrc\s*=/i.test(b.open)).map((b) => b.inner)
	const src = scripts
		.map((b) => attr(b.open, 'src'))
		.filter(Boolean)
		.slice(0, 10)
	const code = kind === 'script' ? body : inline.join('\n')
	const signals = SIGNAL_PATTERNS.filter(([, re]) => re.test(body)).map(([s]) => s)
	const offSite = (action: string) => {
		try {
			return /^https?:/i.test(action) && new URL(action).host !== sharedHost
		} catch {
			return false
		}
	}
	if (forms.some((f) => offSite(f.action))) signals.push('form posts off-site')
	const refresh = (tag: string) => /http-equiv\s*=\s*["']?refresh/i.test(tag) && /url\s*=\s*["']?https?:/i.test(tag)
	if (file.redirect || (html && [...body.matchAll(/<meta\b[^<>]*>/gi)].some(([tag]) => refresh(tag))))
		signals.push('redirects off-site')
	const visible = html || kind === 'text' ? visibleText(body, lower) : ''
	return {
		path: file.path,
		status: file.status,
		kind,
		bytes: file.bytes,
		truncated: file.truncated,
		title: html ? decodeEntities(squash(blocks(body, lower, 'title', 1)[0]?.inner ?? '')) : '',
		text: visible.slice(0, textChars),
		forms,
		scripts: {
			inline: inline.length,
			src,
			excerpt: squash(code.replace(/https?:\/\/[^\s"'`<>()\\]+/gi, (u) => shortUrl(u))).slice(0, 600),
		},
		urls: file.redirect ? [file.redirect, ...urls].slice(0, 20) : urls,
		hosts,
		signals,
	}
}

/** True when a file has nothing for a model to read. */
export const isBlank = (f: FileFacts) =>
	!f.text && !f.title && f.forms.length === 0 && !f.scripts.excerpt && f.urls.length === 0 && f.signals.length === 0

/**
 * A credential or card field plus a webhook/bot endpoint anywhere in the site:
 * the shape of a phishing kit, whatever the model makes of the page.
 */
export function credentialExfil(files: readonly FileFacts[]): string[] | null {
	const fields = files.filter((f) => f.signals.includes('password field') || f.signals.includes('payment card field'))
	const sinks = files.filter((f) => f.signals.includes('webhook or bot endpoint'))
	return fields.length && sinks.length ? [...new Set([...fields, ...sinks].map((f) => f.path))] : null
}
