import { describe, expect, test } from 'bun:test'
import { createHandler } from './handler'
import type { CommentInput, Ports } from './ports'
import { createRateLimiter } from './rate-limit'

const D = (c: string) => `did:plc:${c.repeat(24)}`
const OWNER = D('m')
const REPO_DID = D('r')
const SHA = 'ab12cd3ef4567890123456789012345678901234'
const PULL_URI = `at://${D('u')}/sh.tangled.repo.pull/3kpull`
const body = { owner: OWNER, repo: 'blog', pipeline: '3kpipelineabc', claim: 'alice' }

interface World {
	ports: Ports
	comments: Map<string, { rkey: string; body: string }>
	creates: CommentInput[]
	updates: CommentInput[]
	outbound: () => number
	setSha: (sha: string) => void
}

function world(overrides: Partial<Ports> = {}): World {
	let sha = SHA
	let outbound = 0
	const comments = new Map<string, { rkey: string; body: string }>()
	const creates: CommentInput[] = []
	const updates: CommentInput[] = []
	const ports: Ports = {
		listRepoRecords: async () => {
			outbound++
			return [{ rkey: 'blog', name: 'blog', spindle: 'spindle.example', repoDid: REPO_DID }]
		},
		getPipeline: async () => ({ repo: REPO_DID, pullRequest: { pull: PULL_URI, sourceSha: sha } }),
		findPipelineForCommit: async () => '3kpipelineabc',
		findPullForBranch: async () => null,
		getPull: async () => ({
			uri: PULL_URI,
			cid: 'bafypull',
			authorDid: D('u'),
			targetRepoDid: REPO_DID,
			roundCount: 1,
		}),
		claimOwner: async () => OWNER,
		previewServes: async () => true,
		findComment: async (uri) => {
			await Promise.resolve()
			return comments.get(uri) ?? null
		},
		createComment: async (input) => {
			await Promise.resolve()
			creates.push(input)
			comments.set(input.pull.uri, { rkey: `c${creates.length}`, body: input.body })
		},
		updateComment: async (rkey, input) => {
			updates.push(input)
			comments.set(input.pull.uri, { rkey, body: input.body })
		},
		...overrides,
	}
	return { ports, comments, creates, updates, outbound: () => outbound, setSha: (next) => (sha = next) }
}

function handlerFor(w: World, limits = { capacity: 100 }) {
	return createHandler({
		ports: w.ports,
		config: { previewHost: 'preview.wisp.place' },
		clientKey: () => 'client',
		perClient: createRateLimiter({ capacity: limits.capacity, refillPerSecond: 0.0001 }),
		perOwner: createRateLimiter({ capacity: limits.capacity, refillPerSecond: 0.0001 }),
		log: () => {},
	})
}

const post = (payload: unknown, init: RequestInit = {}) =>
	new Request('https://bot.example/v1/preview', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof payload === 'string' ? payload : JSON.stringify(payload),
		...init,
	})

describe('POST /v1/preview', () => {
	test('creates the comment for a verified preview', async () => {
		const w = world()

		const response = await handlerFor(w)(post(body))

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ status: 'created', url: 'https://pr-ab12cd3-alice.preview.wisp.place/' })
		expect(w.creates).toHaveLength(1)
		expect(w.creates[0]).toMatchObject({ pull: { uri: PULL_URI, cid: 'bafypull' }, roundIdx: 0 })
		expect(w.creates[0]?.body).toContain('https://pr-ab12cd3-alice.preview.wisp.place/')
	})

	test('a new commit updates the same comment and keeps the earlier previews', async () => {
		const w = world()
		const handle = handlerFor(w)
		await handle(post(body))
		w.setSha('99999994567890123456789012345678901234ab')

		const response = await handle(post(body))

		expect(await response.json()).toMatchObject({ status: 'updated' })
		expect(w.creates).toHaveLength(1)
		expect(w.updates).toHaveLength(1)
		const text = w.comments.get(PULL_URI)?.body ?? ''
		expect(text.indexOf('9999999')).toBeLessThan(text.indexOf('ab12cd3'))
	})

	test('the same commit twice changes nothing', async () => {
		const w = world()
		const handle = handlerFor(w)
		await handle(post(body))

		const response = await handle(post(body))

		expect(await response.json()).toMatchObject({ status: 'unchanged' })
		expect(w.updates).toHaveLength(0)
	})

	test('simultaneous requests for one pull request write one comment', async () => {
		const w = world()
		const handle = handlerFor(w)

		const responses = await Promise.all([handle(post(body)), handle(post(body)), handle(post(body))])

		expect(responses.map((r) => r.status)).toEqual([200, 200, 200])
		expect(w.creates).toHaveLength(1)
	})

	test.each([
		['claim-not-owned', { claimOwner: async () => D('x') }, 422],
		['pipeline-not-found', { getPipeline: async () => null }, 422],
		['preview-not-serving', { previewServes: async () => false }, 409],
	] as Array<
		[string, Partial<Ports>, number]
	>)('answers %s with %i and writes nothing', async (reason, overrides, status) => {
		const w = world(overrides)

		const response = await handlerFor(w)(post(body))

		expect(response.status).toBe(status)
		expect(await response.json()).toEqual({ error: reason })
		expect(w.creates).toHaveLength(0)
	})

	test('answers 502 when a lookup fails, without echoing the error', async () => {
		const w = world({
			listRepoRecords: async () => {
				throw new Error('secret connection string')
			},
		})

		const response = await handlerFor(w)(post(body))

		expect(response.status).toBe(502)
		expect(await response.text()).not.toContain('secret')
	})
})

describe('request handling', () => {
	test.each([
		['wrong path', new Request('https://bot.example/other', { method: 'POST' }), 404],
		['wrong method', new Request('https://bot.example/v1/preview', { method: 'GET' }), 405],
	])('%s', async (_name, request, status) => {
		expect((await handlerFor(world())(request)).status).toBe(status)
	})

	test('rejects a body that is not JSON, not an object, or missing fields', async () => {
		const handle = handlerFor(world())

		expect((await handle(post('{nope'))).status).toBe(400)
		expect((await handle(post('[]'))).status).toBe(400)
		expect((await handle(post({ owner: OWNER }))).status).toBe(400)
		expect((await handle(post({ ...body, claim: 5 }))).status).toBe(400)
	})

	test('rejects an oversized body without parsing it', async () => {
		const response = await handlerFor(world())(post(JSON.stringify({ ...body, pad: 'x'.repeat(10_000) })))

		expect(response.status).toBe(413)
	})

	test('rejects a body that is not declared as JSON', async () => {
		const response = await handlerFor(world())(post(body, { headers: { 'content-type': 'text/plain' } }))

		expect(response.status).toBe(415)
	})

	test('ignores fields beyond the four it reads', async () => {
		const w = world()

		const response = await handlerFor(w)(post({ ...body, spindle: 'evil.example', sha: 'deadbeef' }))

		expect(response.status).toBe(200)
	})
})

describe('rate limits', () => {
	test('answer 429 before any lookup once a client is out of tokens', async () => {
		const w = world()
		const handle = handlerFor(w, { capacity: 1 })
		await handle(post(body))
		const before = w.outbound()

		const response = await handle(post(body))

		expect(response.status).toBe(429)
		expect(w.outbound()).toBe(before)
	})

	test('also limit per repo owner across clients', async () => {
		const w = world()
		const handle = createHandler({
			ports: w.ports,
			config: { previewHost: 'preview.wisp.place' },
			clientKey: (() => {
				let n = 0
				return () => `client-${n++}`
			})(),
			perClient: createRateLimiter({ capacity: 100, refillPerSecond: 0.0001 }),
			perOwner: createRateLimiter({ capacity: 1, refillPerSecond: 0.0001 }),
			log: () => {},
		})

		expect((await handle(post(body))).status).toBe(200)
		expect((await handle(post(body))).status).toBe(429)
	})

	test('are not spent by requests that fail validation', async () => {
		const w = world()
		const handle = handlerFor(w, { capacity: 1 })

		expect((await handle(post('{nope'))).status).toBe(400)
		expect((await handle(post(body))).status).toBe(200)
	})
})

describe('POST /v1/hook', () => {
	const hook = (payload: Record<string, unknown>, query = 'repo=blog&claim=alice') =>
		new Request(`https://bot.example/v1/hook?${query}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		})
	const event = { did: OWNER, collection: 'place.wisp.fs', event: 'create', rkey: 'pr-ab12cd3' }

	test('ignores ordinary and delete events without port calls', async () => {
		const w = world({
			listRepoRecords: async () => {
				throw new Error('must not call')
			},
		})
		const handle = handlerFor(w)
		expect((await handle(hook({ ...event, rkey: 'site' }))).status).toBe(200)
		expect((await handle(hook({ ...event, event: 'delete' }))).status).toBe(200)
	})

	test.each([
		['bad query', event, 'repo=bad%20name&claim=alice'],
		['bad body', { ...event, did: 'not-a-did' }, undefined],
		['bad collection', { ...event, collection: 'other' }, undefined],
	] as Array<
		[string, Record<string, unknown>, string | undefined]
	>)('%s returns 400', async (_name, payload, query) => {
		expect((await handlerFor(world())(hook(payload, query))).status).toBe(400)
	})

	test.each([
		['pipeline-not-found', { findPipelineForCommit: async () => null }, 409],
		['preview-not-serving', { previewServes: async () => false }, 409],
		['claim-not-owned', { claimOwner: async () => D('x') }, 422],
	] as Array<[string, Partial<Ports>, number]>)('%s maps to the webhook status', async (_reason, overrides, status) => {
		const response = await handlerFor(world(overrides))(hook(event))
		expect(response.status).toBe(status)
	})

	test('maps upstream failures to 502', async () => {
		const response = await handlerFor(
			world({
				findPipelineForCommit: async () => {
					throw new Error('upstream')
				},
			}),
		)(hook(event))
		expect(response.status).toBe(502)
	})

	test('writes a comment on success', async () => {
		const w = world()
		const response = await handlerFor(w)(hook(event))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ status: 'created', url: 'https://pr-ab12cd3-alice.preview.wisp.place/' })
		expect(w.creates).toHaveLength(1)
	})

	test('reads a delivery that carries a large site record', async () => {
		const record = { site: 'pr-ab12cd3', root: { entries: 'x'.repeat(200_000) } }
		const response = await handlerFor(world())(hook({ ...event, record }))
		expect(response.status).toBe(200)
	})

	test('rate limits before lookups', async () => {
		const w = world()
		const handle = handlerFor(w, { capacity: 1 })
		await handle(hook(event))
		expect((await handle(hook(event))).status).toBe(429)
	})
})
