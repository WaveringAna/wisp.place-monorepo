import { createLogger } from '@wispplace/observability'
import type { ModerationStore, PageFacts } from './store'
import type { Triage } from './types'

const logger = createLogger('moderation-triage')

const PAGE_BYTES = 512 * 1024
const EXCERPT_CHARS = 400
const MODEL_TEXT_CHARS = 3000
const MAX_ATTEMPTS = 4

const SYSTEM = `You review sites hosted on wisp.place, a free static site host, for its moderator. Flag a site only if it clearly breaks the acceptable use policy: spam (SEO or backlink pages, keyword-stuffed or mass-produced articles, affiliate or casino/crypto/adult doorway pages, local-service ads with phone/WhatsApp numbers), phishing or credential harvesting, impersonation of a brand or login page, malware or cracked-software downloads, scams, sexual content involving minors, or illegal goods. Personal sites, portfolios, blogs, tools, games, docs, empty or placeholder pages, and legal adult art that is not a doorway are fine. When unsure, do not flag. Answer with JSON only.`

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
	},
	required: ['flag', 'category', 'reason', 'confidence'],
}

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

/** Title, outbound hosts and visible text of an HTML page. */
export function readPage(html: string, textChars: number): PageFacts & { text: string } {
	const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '')
	const outbound = [
		...new Set(
			[...html.matchAll(/href=["'](https?:\/\/[^"']+)/gi)].flatMap(([, u]) => {
				try {
					return [new URL(u ?? '').host]
				} catch {
					return []
				}
			}),
		),
	]
		.sort()
		.slice(0, 20)
	const text = decodeEntities(
		html
			.replace(/<(script|style|noscript|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
	).slice(0, textChars)
	return { title, outbound, excerpt: text.slice(0, EXCERPT_CHARS), text }
}

/** GET at most PAGE_BYTES of a page. */
export async function fetchPage(
	url: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; html: string }> {
	const res = await fetchImpl(url, {
		headers: { 'User-Agent': 'wisp-moderation (+https://moderation.wisp.place)' },
		redirect: 'follow',
		signal: AbortSignal.timeout(20_000),
	})
	const reader = res.body?.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	while (reader && size < PAGE_BYTES) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		size += value.length
	}
	await reader?.cancel().catch(() => {})
	return { status: res.status, html: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, PAGE_BYTES)) }
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
		}
	}
}

/**
 * Works through pending site versions one at a time. The page is read from the
 * shared host (sites.wisp.place), never from a custom domain, so a domain
 * pointed at an internal address cannot make this service fetch it.
 */
export function createTriageWorker({
	store,
	classify,
	model,
	sharedHost = 'sites.wisp.place',
	fetchImpl = fetch,
}: {
	store: ModerationStore
	classify: Classifier
	model: string
	sharedHost?: string
	fetchImpl?: typeof fetch
}) {
	async function step(): Promise<boolean> {
		const next = await store.nextPending()
		if (!next) return false
		const pageUrl = `https://${sharedHost}/${next.did}/${next.rkey}/`
		let page: Awaited<ReturnType<typeof fetchPage>>
		try {
			page = await fetchPage(pageUrl, fetchImpl)
		} catch (error) {
			page = { status: 0, html: (error as Error).name }
		}
		const now = new Date().toISOString()
		if (page.status !== 200) {
			// Just-published sites can lag behind the cache; give them a few minutes.
			if (next.attempts + 1 < MAX_ATTEMPTS) {
				await store.deferTriage(next.uri, next.attempts + 1, 60 * 2 ** next.attempts)
				return true
			}
			const reason = page.status ? `the page answered ${page.status}` : `the page did not answer (${page.html})`
			await store.saveTriage(
				next.uri,
				{ flag: false, category: 'none', reason, confidence: 1, model: 'none', at: now },
				null,
			)
			return true
		}
		const facts = readPage(page.html, MODEL_TEXT_CHARS)
		if (!facts.text) {
			await store.saveTriage(
				next.uri,
				{ flag: false, category: 'none', reason: 'no visible text', confidence: 1, model: 'none', at: now },
				facts,
			)
			return true
		}
		const description = [
			`URL: https://${sharedHost}/${next.handle || next.did}/${next.rkey}/`,
			`Owner: @${next.handle || next.did}`,
			`Files: ${next.files}`,
			`Title: ${facts.title || '(none)'}`,
			`Outbound links: ${facts.outbound.join(', ') || 'none'}`,
			`Text: ${facts.text}`,
		].join('\n')
		try {
			const verdict = await classify(description)
			await store.saveTriage(next.uri, { ...verdict, model, at: new Date().toISOString() }, facts)
			if (verdict.flag) logger.info('Flagged a site', { uri: next.uri, category: verdict.category })
		} catch (error) {
			logger.warn('Model call failed; will retry', { uri: next.uri, error: (error as Error).message })
			await store.deferTriage(next.uri, next.attempts, 300)
		}
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
