import { type PreviewRow, parsePreviewRows, renderComment } from './comment'
import type { Ports } from './ports'
import type { RateLimiter } from './rate-limit'
import {
	isHookWellFormed,
	isWellFormed,
	type PreviewRequest,
	type Rejection,
	type Verification,
	verifyHook,
	verifyPreview,
} from './verify'

const MAX_BODY_BYTES = 2048
/** Deliveries carry the whole site record; the webhook service sends at most 512 KiB. */
const MAX_HOOK_BODY_BYTES = 512 * 1024
/** Site record keys a preview deploy writes; every other site write is someone's ordinary deploy. */
const PR_RKEY = /^pr-([0-9a-f]{7})$/

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

/**
 * The webhook service retries 409s with backoff and gives up on other 4xx. A hook can arrive
 * before the spindle lists the run or before the site is served, so both of those wait.
 */
const HOOK_STATUS: Record<Rejection, number> = { ...STATUS, 'pipeline-not-found': 409 }

export interface HandlerOptions {
	ports: Ports
	config: { previewHost: string }
	clientKey: (request: Request) => string
	perClient: RateLimiter
	perOwner: RateLimiter
	log: (event: string, fields?: Record<string, unknown>) => void
}

const reply = (status: number, body: unknown) => Response.json(body, { status })

/** Read at most `limit` bytes; null when the body is larger, without buffering the rest. */
async function readBounded(request: Request, limit: number): Promise<string | null> {
	const declared = Number(request.headers.get('content-length') ?? 0)
	if (declared > limit || !request.body) return declared > limit ? null : ''
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.byteLength
		if (size > limit) {
			await reader.cancel()
			return null
		}
		chunks.push(value)
	}
	return new TextDecoder().decode(Buffer.concat(chunks))
}

/** A webhook delivery for a site write, or null when it is not one. */
function parseHookDelivery(text: string): { did: string; event: string; rkey: string } | null {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return null
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
	const { did, collection, event, rkey } = value as Record<string, unknown>
	if (
		typeof did !== 'string' ||
		collection !== 'place.wisp.fs' ||
		typeof event !== 'string' ||
		typeof rkey !== 'string'
	)
		return null
	return { did, event, rkey }
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
		repo: { owner: string; name: string },
		verified: Extract<Verification, { ok: true }>,
	): Promise<'created' | 'updated' | 'unchanged'> {
		return withPullLock(verified.pull.uri, async () => {
			const existing = await ports.findComment(verified.pull.uri)
			const added: PreviewRow = { sha7: verified.sha7, sha: verified.sha, url: verified.url }
			const earlier = existing ? parsePreviewRows(existing.body, config.previewHost) : []
			const body = renderComment([added, ...earlier.filter((row) => row.sha7 !== added.sha7)], repo)
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

	const withinLimits = (request: Request, owner: string) =>
		options.perClient.take(options.clientKey(request)) && options.perOwner.take(owner)

	/** Verify, then write or update the comment; a rejection answers with its status in `statuses`. */
	async function settle(
		repo: { owner: string; name: string },
		verify: () => Promise<Verification>,
		statuses: Record<Rejection, number>,
	): Promise<Response> {
		try {
			const verified = await verify()
			if (!verified.ok) {
				log('rejected', { reason: verified.reason, owner: repo.owner })
				return reply(statuses[verified.reason], { error: verified.reason })
			}
			const status = await writeComment(repo, verified)
			log(status, { owner: repo.owner, pull: verified.pull.uri })
			return reply(200, { status, url: verified.url })
		} catch (error) {
			log('upstream-failure', { error: error instanceof Error ? error.name : 'unknown' })
			return reply(502, { error: 'upstream-failure' })
		}
	}

	/** A site write in an owner's repo, delivered by the webhook the dashboard created for one repo and claim. */
	function handleHook(request: Request, url: URL, text: string): Promise<Response> | Response {
		const delivery = parseHookDelivery(text)
		if (!delivery) return reply(400, { error: 'bad-request' })
		const sha7 = PR_RKEY.exec(delivery.rkey)?.[1]
		// Ordinary deploys and deletions fire the same hook: done, never retried.
		if (!sha7 || delivery.event === 'delete') return reply(200, { status: 'ignored' })
		const hook = {
			owner: url.searchParams.get('owner') ?? delivery.did,
			deployer: delivery.did,
			repo: url.searchParams.get('repo') ?? '',
			claim: url.searchParams.get('claim') ?? '',
			sha7,
		}
		if (!isHookWellFormed(hook)) return reply(400, { error: 'bad-request' })
		if (!withinLimits(request, hook.owner)) return reply(429, { error: 'rate-limited' })
		return settle({ owner: hook.owner, name: hook.repo }, () => verifyHook(hook, ports, config), HOOK_STATUS)
	}

	return async (request) => {
		const url = new URL(request.url)
		if (url.pathname !== '/v1/preview' && url.pathname !== '/v1/hook') return reply(404, { error: 'not-found' })
		if (request.method !== 'POST') return reply(405, { error: 'method-not-allowed' })
		if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
			return reply(415, { error: 'unsupported-media-type' })
		}

		const isHook = url.pathname === '/v1/hook'
		const text = await readBounded(request, isHook ? MAX_HOOK_BODY_BYTES : MAX_BODY_BYTES)
		if (text === null) return reply(413, { error: 'too-large' })
		if (isHook) return handleHook(request, url, text)

		const parsed = parseRequest(text)
		if (!parsed || !isWellFormed(parsed)) return reply(400, { error: 'bad-request' })
		if (!withinLimits(request, parsed.owner)) return reply(429, { error: 'rate-limited' })
		return settle({ owner: parsed.owner, name: parsed.repo }, () => verifyPreview(parsed, ports, config), STATUS)
	}
}
