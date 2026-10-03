import { getPdsForDid } from '@wispplace/atproto-utils'
import { safeFetch } from '@wispplace/safe-fetch'
import type postgres from 'postgres'
import type { CommentInput, ExistingComment, Pipeline, Ports, Pull, RepoRecord } from './ports'

type Fetcher = (url: string, options?: Record<string, unknown>) => Promise<Response>
type Identity = (did: string) => Promise<string>
type Sql = postgres.Sql | ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>)

export interface HttpPortsOptions {
	fetch?: Fetcher
	sql: Sql
	baseHost: string
	identity?: Identity
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

const isObject = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null
const validHost = (host: string) =>
	host === host.toLowerCase() && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
const validId = (id: string) => /^[a-z0-9]{13,32}$/.test(id)
const recordUri = (uri: string) => {
	const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
	if (!match?.[1] || !match[2] || !match[3] || !match[1].includes(':') || match[2] !== 'sh.tangled.repo.pull')
		return null
	return { did: match[1], rkey: match[3] }
}

export function createHttpPorts(options: HttpPortsOptions): Ports {
	const fetcher = options.fetch ?? defaultFetcher
	const identity = options.identity ?? defaultIdentity
	const listRepoRecords = async (ownerDid: string): Promise<RepoRecord[]> => {
		const pds = await identity(ownerDid)
		const result: RepoRecord[] = []
		let cursor: string | undefined
		while (result.length < 500) {
			const query = new URLSearchParams({
				repo: ownerDid,
				collection: 'sh.tangled.repo',
				limit: String(Math.min(100, 500 - result.length)),
			})
			if (cursor) query.set('cursor', cursor)
			const page = await fetchJson<{ records?: unknown[]; cursor?: string }>(
				fetcher,
				`${pds}/xrpc/com.atproto.repo.listRecords?${query}`,
			)
			for (const item of page.records ?? []) {
				if (!isObject(item) || !isObject(item.value)) continue
				const value = item.value
				const rkey = typeof item.uri === 'string' ? (item.uri.split('/').pop() ?? '') : ''
				result.push({
					rkey,
					name: typeof value.name === 'string' ? value.name : rkey,
					spindle: typeof value.spindle === 'string' ? value.spindle : undefined,
					repoDid: typeof value.repoDid === 'string' ? value.repoDid : undefined,
				})
				if (result.length >= 500) break
			}
			if (!page.cursor || !page.records?.length) break
			cursor = page.cursor
		}
		return result
	}
	const getPipeline = async (spindleHost: string, id: string): Promise<Pipeline | null> => {
		if (!validHost(spindleHost) || !validId(id)) return null
		try {
			const value = await fetchJson<any>(
				fetcher,
				`https://${spindleHost}/xrpc/sh.tangled.ci.getPipeline?pipeline=${encodeURIComponent(id)}`,
				{ timeout: 5000, maxRedirects: 0 },
			)
			if (!isObject(value) || typeof value.id !== 'string') return null
			const out: Pipeline = {}
			if (typeof value.repo === 'string') out.repo = value.repo
			if (typeof value.sourceRepo === 'string') out.sourceRepo = value.sourceRepo
			const trigger = value.trigger
			if (
				isObject(trigger) &&
				trigger.$type === 'sh.tangled.ci.trigger#pullRequest' &&
				typeof trigger.sourceSha === 'string' &&
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
	const findPullForBranch = async (
		ownerDid: string,
		targetRepoDid: string,
		sourceBranch: string,
	): Promise<Pull | null> => {
		try {
			const pds = await identity(ownerDid)
			const query = new URLSearchParams({ repo: ownerDid, collection: 'sh.tangled.repo.pull', limit: '100' })
			const response = await fetchJson<any>(fetcher, `${pds}/xrpc/com.atproto.repo.listRecords?${query}`)
			for (const item of response.records ?? []) {
				const value = item.value
				if (
					isObject(value) &&
					isObject(value.target) &&
					value.target.repo === targetRepoDid &&
					isObject(value.source) &&
					value.source.branch === sourceBranch &&
					Array.isArray(value.rounds)
				) {
					const cid = typeof item.cid === 'string' ? item.cid : null
					const uri = typeof item.uri === 'string' ? item.uri : null
					if (!cid || !uri) continue
					return {
						uri,
						cid,
						authorDid: ownerDid,
						targetRepoDid,
						roundCount: value.rounds.length,
					}
				}
			}
			return null
		} catch {
			return null
		}
	}
	const getPull = async (uri: string): Promise<Pull | null> => {
		const parsed = recordUri(uri)
		if (!parsed) return null
		try {
			const pds = await identity(parsed.did)
			const query = new URLSearchParams({ repo: parsed.did, collection: 'sh.tangled.repo.pull', rkey: parsed.rkey })
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
	const repo = () => (options.bot.agent as any).com.atproto.repo
	const findComment = async (pullUri: string): Promise<ExistingComment | null> => {
		let cursor: string | undefined
		let count = 0
		while (count < 1000) {
			const page = await repo().listRecords({
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
	const writeComment = async (rkey: string | undefined, input: CommentInput, createdAt: string) => {
		const record = {
			$type: 'sh.tangled.feed.comment',
			subject: input.pull,
			body: { $type: 'sh.tangled.markup.markdown', text: input.body },
			pullRoundIdx: input.roundIdx,
			createdAt,
		}
		const params = { repo: options.bot.did, collection: 'sh.tangled.feed.comment', record, validate: false } as any
		if (rkey) params.rkey = rkey
		if (rkey) await repo().putRecord(params)
		else await repo().createRecord(params)
	}
	return {
		listRepoRecords,
		getPipeline,
		getPull,
		claimOwner,
		previewServes,
		findPullForBranch,
		findComment,
		createComment: (input) => writeComment(undefined, input, new Date().toISOString()),
		updateComment: (rkey, input) => writeComment(rkey, input, new Date().toISOString()),
	}
}
