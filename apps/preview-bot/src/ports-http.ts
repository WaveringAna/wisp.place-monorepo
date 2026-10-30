import { getDidDocument, getPdsForDid, validatePdsEndpoint } from '@wispplace/atproto-utils'
import { safeFetch } from '@wispplace/safe-fetch'
import type postgres from 'postgres'
import type { CommentInput, ExistingComment, Pipeline, Ports, Pull, RepoManifest, RepoRecord } from './ports'

type Fetcher = (url: string, options?: Record<string, unknown>) => Promise<Response>
type Identity = (did: string) => Promise<string>
/** The validated https endpoint of one service in a DID document, or null. */
type Service = (did: string, id: string) => Promise<string | null>
type Sql = postgres.Sql | ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>)

export interface HttpPortsOptions {
	fetch?: Fetcher
	sql: Sql
	baseHost: string
	/** Tangled appview, used only to find which pull a branch belongs to on repos older than 1.0. */
	appviewHost: string
	identity?: Identity
	service?: Service
	bot: { agent: unknown; did: string }
}

const allowLocalhost = process.env.NODE_ENV === 'development' && process.env.WISP_ALLOW_LOCALHOST_FETCH === '1'
const fetchJson = async <T>(fetcher: Fetcher, url: string, options: Record<string, unknown> = {}): Promise<T> => {
	const response = await fetcher(url, options)
	if (!response.ok) throw new HttpStatusError(response.status)
	return (await response.json()) as T
}

class HttpStatusError extends Error {
	constructor(readonly status: number) {
		super(`http ${status}`)
	}
}

const defaultFetcher: Fetcher = (url, options) =>
	safeFetch(url, {
		...(options as Parameters<typeof safeFetch>[1]),
		allowLocalhost,
	})

const defaultIdentity: Identity = async (did) => {
	const pds = await getPdsForDid(
		did,
		(url, options) =>
			safeFetch(url, {
				signal: options?.signal,
				byteBudget: options?.byteBudget,
				allowLocalhost,
			}),
		allowLocalhost ? { allowLoopback: true } : undefined,
	)
	if (!pds) throw new Error('no pds')
	return pds
}

const defaultService: Service = async (did, id) => {
	const document = await getDidDocument(did, (url, options) =>
		safeFetch(url, { signal: options?.signal, byteBudget: options?.byteBudget, allowLocalhost }),
	)
	const endpoint = document?.service.find((service) => service.id === id)?.serviceEndpoint
	return typeof endpoint === 'string' ? validatePdsEndpoint(endpoint) : null
}

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null
const validHost = (host: string) =>
	host === host.toLowerCase() && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
const validId = (id: string) => /^[a-z0-9]{13,32}$/.test(id)
const validDid = (did: string) => /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]{1,253})$/.test(did)
const recordUri = (uri: string, collection: string) => {
	const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
	if (!match?.[1] || !match[3] || match[2] !== collection || !validDid(match[1])) return null
	return { did: match[1], rkey: match[3] }
}
const LEGACY_PULL = 'sh.tangled.repo.pull'
const TICKET = 'org.tangled.track.ticket'
const PATCH = 'org.tangled.review.patch'
const COMMENT = 'org.tangled.feed.comment'
const PULL_TRIGGERS = new Set(['org.tangled.event.pullRequest', 'sh.tangled.ci.trigger#pullRequest'])
/** Records read from one collection of a repo account before giving up on it. */
const MAX_SCANNED = 2000
/** Remote calls the bot makes on someone else's behalf get a short deadline and no redirects. */
const BOUNDED = { timeout: 5000, maxRedirects: 0 }
/** An XRPC method the server does not have: a spindle from before Tangled 1.0. */
const unsupported = (error: unknown) => error instanceof HttpStatusError && [400, 404, 501].includes(error.status)

export function createHttpPorts(options: HttpPortsOptions): Ports {
	const fetcher = options.fetch ?? defaultFetcher
	const identity = options.identity ?? defaultIdentity
	const service = options.service ?? defaultService
	/** A Tangled service is its endpoint's host: hosted knots publish a per-repo path that answers no XRPC. */
	const serviceOrigin = async (did: string, id: string) => {
		const endpoint = await service(did, id)
		if (!endpoint) return null
		const url = new URL(endpoint)
		return validHost(url.host) ? url.origin : null
	}
	const knotOf = (repoDid: string) =>
		validDid(repoDid) ? serviceOrigin(repoDid, '#tangled_knot') : Promise.resolve(null)

	/** Up to `limit` records of one collection in a repo, read page by page from `base` (a PDS or knot). */
	const listRecords = async (base: string, repo: string, collection: string, limit: number, request = {}) => {
		const records: Array<{ uri: string; rkey: string; cid?: string; value: Record<string, any> }> = []
		let cursor: string | undefined
		while (records.length < limit) {
			const query = new URLSearchParams({ repo, collection, limit: String(Math.min(100, limit - records.length)) })
			if (cursor) query.set('cursor', cursor)
			const page = await fetchJson<{ records?: unknown[]; cursor?: string }>(
				fetcher,
				`${base}/xrpc/com.atproto.repo.listRecords?${query}`,
				request,
			)
			for (const item of page.records ?? []) {
				if (!isObject(item) || typeof item.uri !== 'string' || !isObject(item.value)) continue
				const cid = typeof item.cid === 'string' ? item.cid : undefined
				records.push({ uri: item.uri, rkey: item.uri.split('/').pop() ?? '', cid, value: item.value })
				if (records.length >= limit) break
			}
			if (!page.cursor || !page.records?.length) break
			cursor = page.cursor
		}
		return records
	}
	/** Every record of one collection in a repo account on its knot, up to MAX_SCANNED. */
	const knotRecords = (knot: string, repoDid: string, collection: string) =>
		listRecords(knot, repoDid, collection, MAX_SCANNED, BOUNDED)
	const knotRecord = (knot: string, repoDid: string, collection: string, rkey: string) =>
		fetchJson<{ cid?: unknown; value?: unknown }>(
			fetcher,
			`${knot}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: repoDid, collection, rkey })}`,
			BOUNDED,
		)

	const listRepoRecords = async (ownerDid: string): Promise<RepoRecord[]> => {
		const pds = await identity(ownerDid)
		const legacy = (await listRecords(pds, ownerDid, 'sh.tangled.repo', 500)).map(({ rkey, value }) => ({
			rkey,
			name: typeof value.name === 'string' ? value.name : rkey,
			spindle: typeof value.spindle === 'string' ? value.spindle : undefined,
			repoDid: typeof value.repoDid === 'string' ? value.repoDid : undefined,
		}))
		if (legacy.length >= 500) return legacy
		const declared = (await listRecords(pds, ownerDid, 'org.tangled.repo.declaration', 500 - legacy.length)).map(
			({ rkey, value }) => ({ rkey, name: rkey, repoDid: typeof value.repo === 'string' ? value.repo : undefined }),
		)
		return [...legacy, ...declared]
	}
	const spindleHost = async (did: unknown): Promise<string | undefined> => {
		if (typeof did !== 'string' || !did.startsWith('did:web:')) return undefined
		const origin = await serviceOrigin(did, '#tangled_spindle')
		return origin ? new URL(origin).host : undefined
	}
	const repoManifest = async (repoDid: string): Promise<RepoManifest | null> => {
		const knot = await knotOf(repoDid)
		if (!knot) return null
		const { value } = await knotRecord(knot, repoDid, 'org.tangled.repo.manifest', 'self')
		if (!isObject(value) || !isObject(value.declaration)) return null
		const { owner, name } = value.declaration
		if (typeof owner !== 'string' || typeof name !== 'string') return null
		return { owner, name, spindle: await spindleHost(value.spindle) }
	}
	const pullTrigger = (trigger: unknown) =>
		isObject(trigger) && PULL_TRIGGERS.has(trigger.$type) && typeof trigger.sourceSha === 'string' ? trigger : null
	/** The 1.0 method first; a spindle that does not have it is asked the pre-1.0 one. */
	const askSpindle = async (spindleHost: string, method: string, modern: URLSearchParams, legacy: URLSearchParams) => {
		const ask = (namespace: string, query: URLSearchParams) =>
			fetchJson<any>(fetcher, `https://${spindleHost}/xrpc/${namespace}.${method}?${query}`, BOUNDED)
		try {
			return await ask('org.tangled.ci', modern)
		} catch (error) {
			if (!unsupported(error)) throw error
			return ask('sh.tangled.ci', legacy)
		}
	}
	const getPipeline = async (spindleHost: string, repoDid: string, id: string): Promise<Pipeline | null> => {
		if (!validHost(spindleHost) || !validId(id) || !validDid(repoDid)) return null
		try {
			const value = await askSpindle(
				spindleHost,
				'getPipeline',
				new URLSearchParams({ repo: repoDid, pipeline: id }),
				new URLSearchParams({ pipeline: id }),
			)
			if (!isObject(value) || typeof value.id !== 'string') return null
			const out: Pipeline = {}
			if (typeof value.repo === 'string') out.repo = value.repo
			if (typeof value.sourceRepo === 'string') out.sourceRepo = value.sourceRepo
			const trigger = pullTrigger(value.trigger)
			if (
				trigger &&
				/^[0-9a-f]{40}$/.test(trigger.sourceSha) &&
				(typeof trigger.pull === 'string' || typeof trigger.sourceBranch === 'string')
			) {
				out.pullRequest = {
					pull: typeof trigger.pull === 'string' ? trigger.pull : undefined,
					sourceSha: trigger.sourceSha,
					sourceBranch: typeof trigger.sourceBranch === 'string' ? trigger.sourceBranch : undefined,
				}
			}
			return out
		} catch (error) {
			if (error instanceof HttpStatusError && error.status >= 500) throw error
			return null
		}
	}
	const findPipelineForCommit = async (spindleHost: string, repoDid: string, sha7: string): Promise<string | null> => {
		if (!validHost(spindleHost) || !/^[a-f0-9]{7}$/.test(sha7) || !validDid(repoDid)) return null
		try {
			const value = await askSpindle(
				spindleHost,
				'queryPipelines',
				new URLSearchParams({ repo: repoDid, triggers: 'org.tangled.event.pullRequest', limit: '25' }),
				new URLSearchParams({ repo: repoDid, kinds: 'pull_request', limit: '25' }),
			)
			if (!isObject(value) || !Array.isArray(value.pipelines)) return null
			for (const pipeline of value.pipelines) {
				if (!isObject(pipeline) || typeof pipeline.id !== 'string' || !validId(pipeline.id)) continue
				if (pipeline.repo !== repoDid) continue
				if (pullTrigger(pipeline.trigger)?.sourceSha.startsWith(sha7)) return pipeline.id
			}
			return null
		} catch (error) {
			if (error instanceof HttpStatusError && error.status >= 500) throw error
			return null
		}
	}
	const getLegacyPull = async (uri: string): Promise<Pull | null> => {
		const parsed = recordUri(uri, LEGACY_PULL)
		if (!parsed) return null
		try {
			const pds = await identity(parsed.did)
			const query = new URLSearchParams({ repo: parsed.did, collection: LEGACY_PULL, rkey: parsed.rkey })
			const response = await fetchJson<any>(fetcher, `${pds}/xrpc/com.atproto.repo.getRecord?${query}`)
			const value = response.value
			if (
				!isObject(value) ||
				!isObject(value.target) ||
				typeof value.target.repo !== 'string' ||
				!Array.isArray(value.rounds)
			)
				return null
			const cid = typeof response.cid === 'string' ? response.cid : null
			if (!cid) return null
			return { uri, cid, authorDid: parsed.did, targetRepoDid: value.target.repo, roundCount: value.rounds.length }
		} catch {
			return null
		}
	}
	/** A 1.0 pull request: a ticket with a target branch, its rounds the patches that name it. */
	const getTicket = async (uri: string, state?: string): Promise<Pull | null> => {
		const parsed = recordUri(uri, TICKET)
		if (!parsed) return null
		try {
			const knot = await knotOf(parsed.did)
			if (!knot) return null
			const { cid, value } = await knotRecord(knot, parsed.did, TICKET, parsed.rkey)
			if (!isObject(value) || typeof value.targetBranch !== 'string' || typeof cid !== 'string') return null
			if (typeof value['x-tngl-editor'] !== 'string' || (state && value.state !== state)) return null
			const patches = await knotRecords(knot, parsed.did, PATCH)
			return {
				uri,
				cid,
				authorDid: value['x-tngl-editor'],
				targetRepoDid: parsed.did,
				roundCount: patches.filter((patch) => patch.value.ticket === parsed.rkey).length,
			}
		} catch {
			return null
		}
	}
	const getPull = (uri: string) => (recordUri(uri, TICKET) ? getTicket(uri) : getLegacyPull(uri))
	/**
	 * A 1.0 repo's patches name their source branch, so the newest open ticket with a round from that
	 * branch is the pull. Before 1.0 the appview indexes pulls from every author, so it finds a
	 * collaborator's too; only the URI is taken from it, the record is read from its author's PDS.
	 */
	const findPullForBranch = async (repoDid: string, sourceBranch: string): Promise<Pull | null> => {
		const knot = await knotOf(repoDid)
		if (knot) {
			const rounds = (await knotRecords(knot, repoDid, PATCH))
				.filter(
					({ value }) =>
						isObject(value.source) &&
						value.source.branch === sourceBranch &&
						(value.source.repo === undefined || value.source.repo === repoDid) &&
						typeof value.ticket === 'string',
				)
				.sort((a, b) => String(b.value.createdAt).localeCompare(String(a.value.createdAt)))
			const ticket = rounds[0]?.value.ticket
			return ticket ? getTicket(`at://${repoDid}/${TICKET}/${ticket}`, 'open') : null
		}
		const query = new URLSearchParams({ subject: repoDid, status: 'open', limit: '100' })
		const listed = await fetchJson<{ items?: unknown[] }>(
			fetcher,
			`https://${options.appviewHost}/xrpc/sh.tangled.repo.listPulls?${query}`,
			BOUNDED,
		)
		const match = (listed.items ?? []).find(
			(item) =>
				isObject(item) &&
				isObject(item.value) &&
				isObject(item.value.source) &&
				item.value.source.branch === sourceBranch &&
				(item.value.source.repo === undefined || item.value.source.repo === repoDid),
		) as { uri?: unknown } | undefined
		return typeof match?.uri === 'string' ? getLegacyPull(match.uri) : null
	}
	const claimOwner = async (claim: string): Promise<string | null> => {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(claim)) return null
		const rows = await options.sql`SELECT did FROM domains WHERE domain = ${`${claim}.${options.baseHost}`} LIMIT 1`
		const row = rows[0] as { did?: unknown } | undefined
		return typeof row?.did === 'string' ? row.did : null
	}
	const previewServes = async (url: string): Promise<boolean> => {
		try {
			const response = await fetcher(url, { timeout: 5000, maxRedirects: 2 })
			return response.status === 200
		} catch {
			return false
		}
	}
	const agent = () => options.bot.agent as any
	const ticketRepo = (pullUri: string) => recordUri(pullUri, TICKET)?.did

	const findLegacyComment = async (pullUri: string): Promise<ExistingComment | null> => {
		let cursor: string | undefined
		let count = 0
		while (count < 1000) {
			const { data: page } = await agent().com.atproto.repo.listRecords({
				repo: options.bot.did,
				collection: 'sh.tangled.feed.comment',
				limit: Math.min(100, 1000 - count),
				...(cursor ? { cursor } : {}),
			})
			for (const record of page.records ?? []) {
				count++
				if (record.value?.subject?.uri === pullUri && typeof record.value?.body?.text === 'string')
					return { rkey: record.uri.split('/').pop(), body: record.value.body.text }
			}
			if (!page.cursor || !page.records?.length) break
			cursor = page.cursor
		}
		return null
	}
	/** 1.0 comments live in the repo account, each stamped with the account that wrote it. */
	const findComment = async (pullUri: string): Promise<ExistingComment | null> => {
		const repoDid = ticketRepo(pullUri)
		if (!repoDid) return findLegacyComment(pullUri)
		const knot = await knotOf(repoDid)
		if (!knot) return null
		const mine = (await knotRecords(knot, repoDid, COMMENT)).find(
			({ value }) =>
				value['x-tngl-editor'] === options.bot.did &&
				value.subject?.uri === pullUri &&
				typeof value.body?.text === 'string',
		)
		return mine ? { rkey: mine.uri.split('/').pop() ?? '', body: mine.value.body.text } : null
	}
	const writeLegacyComment = async (rkey: string | undefined, input: CommentInput) => {
		const record = {
			$type: 'sh.tangled.feed.comment',
			subject: input.pull,
			body: { $type: 'sh.tangled.markup.markdown', text: input.body },
			pullRoundIdx: input.roundIdx,
			createdAt: new Date().toISOString(),
		}
		const params = { repo: options.bot.did, collection: 'sh.tangled.feed.comment', record, validate: false } as any
		if (rkey) params.rkey = rkey
		if (rkey) await agent().com.atproto.repo.putRecord(params)
		else await agent().com.atproto.repo.createRecord(params)
	}
	/**
	 * The knot writes into the repo account for whoever holds a service-auth token minted for that
	 * repo and method. The bot then attests the write from its own PDS, as the 1.0 web app does.
	 */
	const writeComment = async (repoDid: string, rkey: string | undefined, input: CommentInput) => {
		const knot = await knotOf(repoDid)
		if (!knot) throw new Error('the repo has no knot')
		const nsid = rkey ? 'com.atproto.repo.putRecord' : 'com.atproto.repo.createRecord'
		const record = {
			$type: COMMENT,
			subject: { $type: 'com.atproto.repo.strongRef', ...input.pull },
			body: { $type: 'org.tangled.markup.markdown', text: input.body },
			createdAt: new Date().toISOString(),
		}
		const swapRecord = rkey ? (await knotRecord(knot, repoDid, COMMENT, rkey)).cid : undefined
		const { data: auth } = await agent().com.atproto.server.getServiceAuth({ aud: repoDid, lxm: nsid })
		const written = await fetchJson<Record<string, unknown>>(fetcher, `${knot}/xrpc/${nsid}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ repo: repoDid, collection: COMMENT, ...(rkey ? { rkey, swapRecord } : {}), record }),
			timeout: 10_000,
			maxRedirects: 0,
		})
		if (typeof written.uri !== 'string' || typeof written.cid !== 'string') throw new Error('the knot sent no record')
		await agent().com.atproto.repo.createRecord({
			repo: options.bot.did,
			collection: 'org.tangled.graph.attestation',
			record: {
				$type: 'org.tangled.graph.attestation',
				subject: { uri: written.uri, cid: written.cid },
				...(typeof written['x-tngl-change'] === 'string' ? { change: written['x-tngl-change'] } : {}),
				createdAt: record.createdAt,
			},
		})
	}
	const saveComment = (rkey: string | undefined, input: CommentInput) => {
		const repoDid = ticketRepo(input.pull.uri)
		return repoDid ? writeComment(repoDid, rkey, input) : writeLegacyComment(rkey, input)
	}
	return {
		listRepoRecords,
		repoManifest,
		getPipeline,
		findPipelineForCommit,
		getPull,
		claimOwner,
		previewServes,
		findPullForBranch,
		findComment,
		createComment: (input) => saveComment(undefined, input),
		updateComment: (rkey, input) => saveComment(rkey, input),
	}
}
