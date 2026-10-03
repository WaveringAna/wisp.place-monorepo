import { type PreviewRow, parsePreviewRows, renderComment } from './comment'
import type { Ports } from './ports'
import type { RateLimiter } from './rate-limit'
import { isWellFormed, type PreviewRequest, type Rejection, verifyPreview } from './verify'

const MAX_BODY_BYTES = 2048

const STATUS: Record<Rejection, number> = {
	'bad-request': 400,
	'repo-not-found': 422,
	'repo-ambiguous': 422,
	'repo-unusable': 422,
	'pipeline-not-found': 422,
	'not-a-pull-request': 422,
	'fork-pull-request': 422,
	'repo-mismatch': 422,
	'pull-not-found': 422,
	'pull-repo-mismatch': 422,
	'pull-has-no-rounds': 422,
	'claim-not-owned': 422,
	'label-too-long': 422,
	// The deploy may simply not be served yet; the workflow can retry.
	'preview-not-serving': 409,
}

export interface HandlerOptions {
	ports: Ports
	config: { previewHost: string }
	clientKey: (request: Request) => string
	perClient: RateLimiter
	perOwner: RateLimiter
	log: (event: string, fields?: Record<string, unknown>) => void
}

const reply = (status: number, body: unknown) => Response.json(body, { status })

/** Read at most MAX_BODY_BYTES; null when the body is larger, without buffering the rest. */
async function readBounded(request: Request): Promise<string | null> {
	const declared = Number(request.headers.get('content-length') ?? 0)
	if (declared > MAX_BODY_BYTES || !request.body) return declared > MAX_BODY_BYTES ? null : ''
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > MAX_BODY_BYTES) {
			await reader.cancel()
			return null
		}
		chunks.push(value)
	}
	return new TextDecoder().decode(Buffer.concat(chunks))
}

function parseRequest(text: string): PreviewRequest | null {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return null
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
	const { owner, repo, pipeline, claim } = value as Record<string, unknown>
	if ([owner, repo, pipeline, claim].some((field) => typeof field !== 'string')) return null
	return { owner, repo, pipeline, claim } as PreviewRequest
}

/** Serializes find-then-write per pull request so concurrent requests cannot both create. */
function createKeyedLock() {
	const tails = new Map<string, Promise<unknown>>()
	return async <T>(key: string, run: () => Promise<T>): Promise<T> => {
		const previous = tails.get(key) ?? Promise.resolve()
		const current = previous.then(run, run)
		const tail = current.catch(() => {})
		tails.set(key, tail)
		try {
			return await current
		} finally {
			if (tails.get(key) === tail) tails.delete(key)
		}
	}
}

export function createHandler(options: HandlerOptions): (request: Request) => Promise<Response> {
	const { ports, config, log } = options
	const withPullLock = createKeyedLock()

	async function writeComment(
		verified: Extract<Awaited<ReturnType<typeof verifyPreview>>, { ok: true }>,
	): Promise<'created' | 'updated' | 'unchanged'> {
		return withPullLock(verified.pull.uri, async () => {
			const existing = await ports.findComment(verified.pull.uri)
			const added: PreviewRow = { sha7: verified.sha7, url: verified.url }
			const earlier = existing ? parsePreviewRows(existing.body, config.previewHost) : []
			const body = renderComment([added, ...earlier.filter((row) => row.sha7 !== added.sha7)])
			const input = { pull: verified.pull, roundIdx: verified.roundIdx, body }
			if (!existing) {
				await ports.createComment(input)
				return 'created'
			}
			if (existing.body === body) return 'unchanged'
			await ports.updateComment(existing.rkey, input)
			return 'updated'
		})
	}

	return async (request) => {
		const url = new URL(request.url)
		if (url.pathname !== '/v1/preview') return reply(404, { error: 'not-found' })
		if (request.method !== 'POST') return reply(405, { error: 'method-not-allowed' })
		if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
			return reply(415, { error: 'unsupported-media-type' })
		}

		const text = await readBounded(request)
		if (text === null) return reply(413, { error: 'too-large' })
		const parsed = parseRequest(text)
		if (!parsed || !isWellFormed(parsed)) return reply(400, { error: 'bad-request' })

		if (!options.perClient.take(options.clientKey(request)) || !options.perOwner.take(parsed.owner)) {
			return reply(429, { error: 'rate-limited' })
		}

		try {
			const verified = await verifyPreview(parsed, ports, config)
			if (!verified.ok) {
				log('rejected', { reason: verified.reason, owner: parsed.owner })
				return reply(STATUS[verified.reason], { error: verified.reason })
			}
			const status = await writeComment(verified)
			log(status, { owner: parsed.owner, pull: verified.pull.uri })
			return reply(200, { status, url: verified.url })
		} catch (error) {
			log('upstream-failure', { error: error instanceof Error ? error.name : 'unknown' })
			return reply(502, { error: 'upstream-failure' })
		}
	}
}
