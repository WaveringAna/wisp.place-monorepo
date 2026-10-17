import { createHash, timingSafeEqual } from 'node:crypto'
import type { ModeratorAuth } from './auth'
import type { ModerationStore } from './store'
import {
	type LabelRequest,
	MODERATION_ACTIONS,
	type ModerationAction,
	type QueueView,
	VERDICTS,
	type Verdict,
	type VerdictRequest,
} from './types'

const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%-]+)$/
const SITE_URI = /^at:\/\/(did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%-]+))\/place\.wisp\.fs\/([a-zA-Z0-9._~:-]{1,512})$/
const VIEWS: readonly QueueView[] = ['flagged', 'pending', 'recent', 'reviewed']
const NOTE_MAX = 1000

/** The account a subject belongs to: the DID itself, or the DID inside a site URI. */
export function subjectDid(uri: string): string | null {
	if (DID.test(uri)) return uri
	return SITE_URI.exec(uri)?.[1] ?? null
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const fail = (status: number, error: string) => json({ error }, status)

type Caller = { kind: 'moderator'; did: string } | { kind: 'token' }

export type ModerationApiDeps = {
	store: ModerationStore
	auth: Pick<ModeratorAuth, 'moderator' | 'handle'>
	/** Sign and publish a label; the labeler's own emit. */
	emitLabel: (label: { uri: string; val: string; neg: boolean; note: string }) => Promise<{ seq: number }>
	/** Lets the daily briefing read and record verdicts. It can never label. */
	apiToken?: string
}

/**
 * The moderator API under /api. Every read is a single query against the
 * moderation tables; writes return what changed so the interface can merge it
 * without reloading.
 */
export function createModerationApi({ store, auth, emitLabel, apiToken = '' }: ModerationApiDeps) {
	const digest = (v: string) => createHash('sha256').update(v).digest()
	const tokenDigest = apiToken.length >= 32 ? digest(apiToken) : null

	async function caller(req: Request): Promise<Caller | null> {
		const did = await auth.moderator(req)
		if (did) return { kind: 'moderator', did }
		const header = req.headers.get('authorization')
		if (tokenDigest && header?.startsWith('Bearer ') && timingSafeEqual(digest(header.slice(7)), tokenDigest))
			return { kind: 'token' }
		return null
	}

	/** Wraps a handler: who may call it, and writes only as JSON (which a cross-site form cannot send). */
	const route =
		(handler: (req: Request, who: Caller) => Promise<Response>, { token = true } = {}) =>
		async (req: Request): Promise<Response> => {
			const who = await caller(req)
			if (!who || (who.kind === 'token' && !token)) return fail(401, 'sign in required')
			if (req.method !== 'GET' && !req.headers.get('content-type')?.startsWith('application/json'))
				return fail(415, 'send JSON')
			return handler(req, who)
		}

	async function body<T>(req: Request): Promise<T | null> {
		try {
			return (await req.json()) as T
		} catch {
			return null
		}
	}

	return {
		'/api/me': {
			GET: route(
				async (_req, who) =>
					who.kind === 'moderator'
						? json({ did: who.did, handle: await auth.handle(who.did) })
						: fail(401, 'sign in required'),
				{ token: false },
			),
		},

		'/api/queue': {
			GET: route(async (req) => {
				const params = new URL(req.url).searchParams
				const view = (params.get('view') ?? 'flagged') as QueueView
				if (!VIEWS.includes(view)) return fail(400, `view must be one of ${VIEWS.join(', ')}`)
				const limit = Number(params.get('limit') ?? 30)
				if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, 'limit must be 1-100')
				const [page, counts] = await Promise.all([store.queue(view, params.get('cursor'), limit), store.counts()])
				return json({ ...page, counts })
			}),
		},

		'/api/account/:did': {
			GET: route(async (req) => {
				const did = decodeURIComponent((req as Request & { params: { did: string } }).params.did)
				if (!DID.test(did)) return fail(400, 'not a DID')
				return json(await store.account(did))
			}),
		},

		'/api/search': {
			GET: route(async (req) => {
				const q = new URL(req.url).searchParams.get('q')?.trim().replace(/^@/, '') ?? ''
				if (q.length < 2 || q.length > 300) return fail(400, 'q must be 2-300 characters')
				return json({ items: await store.search(q) })
			}),
		},

		'/api/events': {
			GET: route(async (req) => json(await store.events(new URL(req.url).searchParams.get('cursor'), 50))),
		},

		'/api/verdict': {
			POST: route(async (req, who) => {
				const input = await body<VerdictRequest>(req)
				if (!input || typeof input.uri !== 'string' || !subjectDid(input.uri))
					return fail(400, 'uri must be a site record URI or an account DID')
				if (input.verdict !== null && !VERDICTS.includes(input.verdict as Verdict))
					return fail(400, `verdict must be null or one of ${VERDICTS.join(', ')}`)
				const note = typeof input.note === 'string' ? input.note.slice(0, NOTE_MAX) : ''
				const actor = who.kind === 'moderator' ? who.did : 'token:briefing'
				await store.setVerdict(input.uri, input.verdict, note, actor)
				return json({ site: input.uri.startsWith('at://') ? await store.site(input.uri) : null })
			}),
		},

		'/api/label': {
			POST: route(
				async (req, who) => {
					const input = await body<LabelRequest>(req)
					const did = input && typeof input.uri === 'string' ? subjectDid(input.uri) : null
					if (!input || !did) return fail(400, 'uri must be a site record URI or an account DID')
					if (!MODERATION_ACTIONS.includes(input.val as ModerationAction))
						return fail(400, `val must be one of ${MODERATION_ACTIONS.join(', ')}`)
					const note = typeof input.note === 'string' ? input.note.slice(0, NOTE_MAX) : ''
					const neg = input.neg === true
					const { seq } = await emitLabel({ uri: input.uri, val: input.val, neg, note })
					const moderator = who.kind === 'moderator' ? who.did : 'unknown'
					await store.event(input.uri, 'label', moderator, { val: input.val, neg, note, seq })
					return json({ labels: await store.labelsOn(input.uri === did ? [did] : [input.uri, did]) })
				},
				{ token: false },
			),
		},
	}
}
