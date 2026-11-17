import { createLogger } from '@wispplace/observability'
import {
	credentialExfil,
	type FetchedFile,
	type FileFacts,
	fetchSite,
	fileKind,
	isBlank,
	readFile,
	SITE_LIMITS,
	type SiteLimits,
} from './site-files'
import type { ModerationStore, PageFacts } from './store'
import type { Triage } from './types'

const logger = createLogger('moderation-triage')

const EXCERPT_CHARS = 400
const MAX_ATTEMPTS = 4

const SYSTEM = `You review sites hosted on wisp.place, a free static site host, for its moderator. Flag a site only if it clearly breaks the acceptable use policy: spam (SEO or backlink pages, keyword-stuffed or mass-produced articles, affiliate or casino/crypto/adult doorway pages, local-service ads with phone/WhatsApp numbers), phishing or credential harvesting, impersonation of a brand or login page, malware or cracked-software downloads, scams, sexual content involving minors, or illegal goods. Personal sites, portfolios, blogs, tools, games, docs, empty or placeholder pages, and legal adult art that is not a doorway are fine. When unsure, do not flag.
A site has many files and any of them can be the problem, not only its front page. Each file read is a section starting "== <path>"; "/" is the front page. Signals come from simple pattern checks and can be wrong, so weigh them against the content. A page that asks for a password or card details and sends what is typed to a webhook, a bot API or a host unrelated to the site is phishing. Name the file path or paths your answer rests on in reason, and list them in files. Answer with JSON only.`

const SCHEMA = {
	type: 'object',
	properties: {
		flag: { type: 'boolean' },
		category: {
			type: 'string',
			enum: ['none', 'spam', 'phishing', 'impersonation', 'malware', 'scam', 'csam', 'illegal', 'other'],
		},
		reason: { type: 'string', maxLength: 240 },
		confidence: { type: 'number' },
		files: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 5 },
	},
	required: ['flag', 'category', 'reason', 'confidence', 'files'],
}

export type Classifier = (description: string) => Promise<Omit<Triage, 'at' | 'model'>>

/** Ask an OpenAI-compatible llama.cpp server for a verdict in the schema above. */
export function createModelClassifier({
	endpoint,
	model,
	fetchImpl = fetch,
}: {
	endpoint: string
	model: string
	fetchImpl?: typeof fetch
}): Classifier {
	return async (description) => {
		const res = await fetchImpl(`${endpoint}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal: AbortSignal.timeout(120_000),
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: SYSTEM },
					{ role: 'user', content: description },
				],
				temperature: 0,
				max_tokens: 400,
				// With thinking on, bonsai argued itself out of an obvious adult doorway page and took ten times as long.
				chat_template_kwargs: { enable_thinking: false },
				response_format: { type: 'json_schema', json_schema: { name: 'verdict', schema: SCHEMA } },
			}),
		})
		if (!res.ok) throw new Error(`model answered ${res.status}`)
		const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
		const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? '') as Record<string, unknown>
		return {
			flag: parsed.flag === true,
			category: String(parsed.category ?? 'other'),
			reason: String(parsed.reason ?? '').slice(0, 240),
			confidence: Number(parsed.confidence) || 0,
			files: Array.isArray(parsed.files) ? parsed.files.map(String).slice(0, 5) : [],
		}
	}
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function describeFile(f: FileFacts, chars: number): string {
	const lines = [`== ${f.path} (200, ${f.kind}, ${f.bytes} bytes${f.truncated ? ', truncated' : ''})`]
	if (f.title) lines.push(`Title: ${f.title}`)
	for (const form of f.forms)
		lines.push(`Form: ${form.method} to ${form.action || '(no action)'}; inputs ${form.inputs.join(', ') || 'none'}`)
	if (f.scripts.inline || f.scripts.src.length)
		lines.push(`Scripts: ${f.scripts.inline} inline${f.scripts.src.length ? `; src ${f.scripts.src.join(', ')}` : ''}`)
	if (f.urls.length) lines.push(`URLs: ${f.urls.join(', ')}`)
	if (f.scripts.excerpt) lines.push(`Code: ${f.scripts.excerpt}`)
	if (f.text) lines.push(`Text: ${f.text}`)
	return clip(lines.join('\n'), chars)
}

const unread = (f: FetchedFile) => f.error ?? (f.status ? String(f.status) : 'no answer')

/**
 * The model's view of a site: its manifest paths, then one section per file read,
 * files with signals first, within a fixed character budget.
 */
export function describeSite(
	site: { did: string; rkey: string; handle: string; paths: readonly string[] },
	fetched: readonly FetchedFile[],
	facts: readonly FileFacts[],
	sharedHost: string,
	limits: SiteLimits = SITE_LIMITS,
): string {
	const owner = site.handle || site.did
	const listed = [...site.paths].sort().slice(0, limits.listedPaths)
	const extra = site.paths.length - listed.length
	const signalled = facts.filter((f) => f.signals.length)
	const head = [
		`URL: https://${sharedHost}/${owner}/${site.rkey}/`,
		`Owner: @${owner}`,
		`Files: ${site.paths.length} in the manifest, ${facts.filter((f) => f.status === 200).length} read`,
		`Paths: ${clip(listed.join(', '), 2400) || '(none)'}${extra > 0 ? ` (+${extra} more)` : ''}`,
		`Signals: ${signalled.map((f) => `${f.path}: ${f.signals.join(', ')}`).join('; ') || 'none'}`,
		`Not read: ${
			fetched
				.filter((f) => f.status !== 200)
				.map((f) => `${f.path} (${unread(f)})`)
				.join(', ') || 'none'
		}`,
	].join('\n')
	const sections: string[] = []
	let left = limits.descriptionChars - head.length
	const ordered = [...facts.filter((f) => f.signals.length), ...facts.filter((f) => !f.signals.length)]
	for (const f of ordered) {
		if (f.status !== 200) continue
		if (left < 200) {
			sections.push(`(${ordered.filter((o) => o.status === 200).length - sections.length} more files not shown)`)
			break
		}
		const section = describeFile(f, Math.min(limits.sectionChars, left))
		sections.push(section)
		left -= section.length + 1
	}
	return [head, ...sections].join('\n')
}

/**
 * Make the reason name its files, and let a credential-exfiltration shape flag a
 * site the model let through: a moderator looks at it either way.
 */
export function settleVerdict(
	verdict: Omit<Triage, 'at' | 'model'>,
	facts: readonly FileFacts[],
): Omit<Triage, 'at' | 'model'> {
	const read = facts.filter((f) => f.status === 200).map((f) => f.path)
	const rule = credentialExfil(facts)
	if (!verdict.flag && rule)
		return {
			flag: true,
			category: 'phishing',
			reason: clip(
				`rules: ${rule.join(', ')} ask for a password or card and hold a webhook or bot endpoint; model said: ${verdict.reason}`,
				240,
			),
			confidence: 0.9,
			files: rule,
		}
	const named = (verdict.files ?? [])
		.map((p) => (p === '/' ? p : p.replace(/^\/+/, '')))
		.filter((p) => read.includes(p))
	const signalled = facts.filter((f) => f.signals.length).map((f) => f.path)
	const files = named.length ? named : verdict.flag && signalled.length ? signalled.slice(0, 3) : read.slice(0, 3)
	const reason = files.some((p) => p !== '/' && verdict.reason.includes(p))
		? verdict.reason
		: `${files.join(', ')}: ${verdict.reason}`
	return { ...verdict, reason: clip(reason, 240), files }
}

/** Title, excerpt and outbound hosts for the queue card: the front page's when it answered, else the first page read. */
function pageFacts(facts: readonly FileFacts[]): PageFacts {
	const ok = facts.filter((f) => f.status === 200)
	const page = ok.find((f) => f.kind === 'html') ?? ok[0]
	return {
		title: page?.title ?? '',
		excerpt: page?.text.slice(0, EXCERPT_CHARS) ?? '',
		outbound: [...new Set(ok.flatMap((f) => f.hosts))].sort().slice(0, 20),
	}
}

/**
 * Works through pending site versions one at a time. Every path in the site's
 * manifest is a candidate; the files are read from the shared host
 * (sites.wisp.place/<did>/<rkey>/<path>), never from a custom domain, and
 * redirects are followed only within the site, so neither a domain nor a
 * _redirects rule can make this service fetch another address.
 */
export function createTriageWorker({
	store,
	classify,
	model,
	sharedHost = 'sites.wisp.place',
	fetchImpl = fetch,
	limits = SITE_LIMITS,
}: {
	store: ModerationStore
	classify: Classifier
	model: string
	sharedHost?: string
	fetchImpl?: typeof fetch
	limits?: SiteLimits
}) {
	async function save(uri: string, verdict: Omit<Triage, 'at' | 'model'>, by: string, facts: PageFacts | null) {
		await store.saveTriage(uri, { ...verdict, model: by, at: new Date().toISOString() }, facts)
		if (verdict.flag) logger.info('Flagged a site', { uri, category: verdict.category, files: verdict.files })
	}

	async function step(): Promise<boolean> {
		const next = await store.nextPending()
		if (!next) return false
		const fetched = await fetchSite(`https://${sharedHost}/${next.did}/${next.rkey}/`, next.paths, {
			fetchImpl,
			limits,
		})
		const answered = fetched.filter((f) => f.status === 200)
		// Just-published sites can lag behind the cache; give them a few minutes.
		const lagging = fetched.some((f) => f.status >= 500 || f.error === 'timeout' || f.error === 'network')
		if ((answered.length === 0 || lagging) && next.attempts + 1 < MAX_ATTEMPTS) {
			await store.deferTriage(next.uri, next.attempts + 1, 60 * 2 ** next.attempts)
			return true
		}
		if (answered.length === 0) {
			const why = fetched
				.slice(0, 5)
				.map((f) => `${f.path} ${unread(f)}`)
				.join(', ')
			await save(
				next.uri,
				{ flag: false, category: 'none', reason: `no file answered: ${why}`, confidence: 1 },
				'none',
				null,
			)
			return true
		}
		const facts = fetched.map((f) => readFile(f, sharedHost, limits.sectionChars))
		const page = pageFacts(facts)
		const read = answered.map((f) => f.path)
		const downloads = next.paths.some((p) => fileKind(p) === 'download')
		if (facts.every(isBlank) && !downloads) {
			const reason = clip(`no visible text in ${read.join(', ')}`, 240)
			await save(next.uri, { flag: false, category: 'none', reason, confidence: 1, files: read }, 'none', page)
			return true
		}
		const description = describeSite(next, fetched, facts, sharedHost, limits)
		let verdict: Omit<Triage, 'at' | 'model'>
		try {
			verdict = await classify(description)
		} catch (error) {
			const rule = credentialExfil(facts)
			if (rule) {
				const fallback = { flag: false, category: 'none', reason: 'model unavailable', confidence: 0 }
				await save(next.uri, settleVerdict(fallback, facts), 'rules', page)
				return true
			}
			logger.warn('Model call failed; will retry', { uri: next.uri, error: (error as Error).message })
			await store.deferTriage(next.uri, next.attempts, 300)
			return true
		}
		await save(next.uri, settleVerdict(verdict, facts), model, page)
		return true
	}

	let running = false
	return {
		step,
		/** Drain pending work; overlapping calls are ignored. */
		async drain(): Promise<number> {
			if (running) return 0
			running = true
			let done = 0
			try {
				while (await step()) done++
			} finally {
				running = false
			}
			return done
		},
	}
}
