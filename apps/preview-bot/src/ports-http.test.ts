import { describe, expect, test } from 'bun:test'
import { createHttpPorts } from './ports-http'

const OWNER = `did:plc:${'o'.repeat(24)}`
const PDS = 'https://pds.example'
const PULL_URI = `at://did:plc:${'u'.repeat(24)}/sh.tangled.repo.pull/3kpull`
const SHA = 'ab12cd3ef4567890123456789012345678901234'

type Json = Record<string, unknown>

/** A fetch that answers from a table of URL prefixes and records what it was asked. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
	const requested: string[] = []
	const fetch = async (url: string) => {
		requested.push(url)
		const key = Object.keys(routes).find((prefix) => url.startsWith(prefix))
		if (!key) return new Response('not found', { status: 404 })
		return (routes[key] as () => Response | Promise<Response>)()
	}
	return { fetch, requested }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

function build(options: { fetch?: (url: string) => Promise<Response>; sql?: unknown; agent?: unknown } = {}) {
	return createHttpPorts({
		fetch: options.fetch ?? (async () => new Response('no', { status: 404 })),
		sql: (options.sql ?? (async () => [])) as never,
		baseHost: 'wisp.place',
		appviewHost: 'appview.example',
		identity: async () => PDS,
		bot: { agent: options.agent ?? {}, did: 'did:plc:bot' },
	})
}

const repoRecord = (name: string, extra: Json = {}) => ({
	uri: `at://${OWNER}/sh.tangled.repo/${name}`,
	value: { name, knot: 'knot.example', spindle: 'spindle.example', repoDid: `did:plc:${'r'.repeat(24)}`, ...extra },
})

describe('listRepoRecords', () => {
	test('maps the fields the verifier needs, taking the repo DID only from repoDid', async () => {
		const { fetch } = fakeFetch({
			[`${PDS}/xrpc/com.atproto.repo.listRecords`]: () =>
				json({ records: [repoRecord('blog'), repoRecord('legacy', { repoDid: undefined, did: OWNER })] }),
		})

		const records = await build({ fetch }).listRepoRecords(OWNER)

		expect(records).toEqual([
			{ rkey: 'blog', name: 'blog', spindle: 'spindle.example', repoDid: `did:plc:${'r'.repeat(24)}` },
			{ rkey: 'legacy', name: 'legacy', spindle: 'spindle.example', repoDid: undefined },
		])
	})

	test('falls back to rkey as repository name when value.name is omitted', async () => {
		const { fetch } = fakeFetch({
			[`${PDS}/xrpc/com.atproto.repo.listRecords`]: () =>
				json({
					records: [
						{
							uri: `at://${OWNER}/sh.tangled.repo/wisp-preview-test`,
							value: { knot: 'knot.example', spindle: 'spindle.example', repoDid: `did:plc:${'r'.repeat(24)}` },
						},
					],
				}),
		})

		const records = await build({ fetch }).listRepoRecords(OWNER)
		expect(records).toEqual([
			{
				rkey: 'wisp-preview-test',
				name: 'wisp-preview-test',
				spindle: 'spindle.example',
				repoDid: `did:plc:${'r'.repeat(24)}`,
			},
		])
	})

	test('follows the cursor and stops at 500 records', async () => {
		const requested: string[] = []
		const fetch = async (url: string) => {
			requested.push(url)
			const records = Array.from({ length: 100 }, (_, i) => repoRecord(`r${requested.length}-${i}`))
			return json({ records, cursor: `c${requested.length}` })
		}

		const records = await build({ fetch }).listRepoRecords(OWNER)

		expect(records).toHaveLength(500)
		expect(requested).toHaveLength(5)
		expect(requested[1]).toContain('cursor=c1')
	})

	test('ignores records that are not objects', async () => {
		const { fetch } = fakeFetch({
			[`${PDS}/xrpc/`]: () => json({ records: [null, 'x', { uri: 'a', value: 5 }, repoRecord('ok')] }),
		})

		expect(await build({ fetch }).listRepoRecords(OWNER)).toHaveLength(1)
	})
})

describe('getPipeline', () => {
	const pipelineBody = (trigger: Json, extra: Json = {}) => ({
		id: '3kpipelineabc',
		repo: `did:plc:${'r'.repeat(24)}`,
		commit: SHA,
		workflows: [],
		trigger,
		...extra,
	})
	const pullTrigger = {
		$type: 'sh.tangled.ci.trigger#pullRequest',
		pull: PULL_URI,
		sourceSha: SHA,
		targetBranch: 'main',
	}

	test('reads a pull request trigger from the named spindle', async () => {
		const { fetch, requested } = fakeFetch({ 'https://spindle.example/': () => json(pipelineBody(pullTrigger)) })

		const pipeline = await build({ fetch }).getPipeline('spindle.example', '3kpipelineabc')

		expect(pipeline).toEqual({ repo: `did:plc:${'r'.repeat(24)}`, pullRequest: { pull: PULL_URI, sourceSha: SHA } })
		expect(requested[0]).toBe('https://spindle.example/xrpc/sh.tangled.ci.getPipeline?pipeline=3kpipelineabc')
	})

	test('reports a fork checkout', async () => {
		const sourceRepo = `did:plc:${'f'.repeat(24)}`
		const { fetch } = fakeFetch({ 'https://spindle.example/': () => json(pipelineBody(pullTrigger, { sourceRepo })) })

		expect((await build({ fetch }).getPipeline('spindle.example', '3kpipelineabc'))?.sourceRepo).toBe(sourceRepo)
	})

	test.each([
		['a push trigger', { $type: 'sh.tangled.ci.trigger#push', ref: 'refs/heads/main', newSha: SHA, oldSha: SHA }],
		['a bad sha', { ...pullTrigger, sourceSha: 'ABC' }],
		['a missing pull uri without branch', { ...pullTrigger, pull: undefined, sourceBranch: undefined }],
	])('gives no pull request for %s', async (_name, trigger) => {
		const { fetch } = fakeFetch({ 'https://spindle.example/': () => json(pipelineBody(trigger as Json)) })

		expect((await build({ fetch }).getPipeline('spindle.example', '3kpipelineabc'))?.pullRequest).toBeUndefined()
	})

	test.each([
		'https://evil.example',
		'evil.example/path',
		'evil.example:8080',
		'user@evil.example',
		'EVIL.example',
		'localhost',
		'',
	])('refuses the host %p without making a request', async (host) => {
		const { fetch, requested } = fakeFetch({})

		expect(await build({ fetch }).getPipeline(host, '3kpipelineabc')).toBeNull()
		expect(requested).toEqual([])
	})

	test('refuses a malformed pipeline id without making a request', async () => {
		const { fetch, requested } = fakeFetch({})

		expect(await build({ fetch }).getPipeline('spindle.example', '../x')).toBeNull()
		expect(requested).toEqual([])
	})

	test('is null for 404 and malformed bodies, and throws for server errors', async () => {
		expect(await build({ fetch: async () => json({}, 404) }).getPipeline('spindle.example', '3kpipelineabc')).toBeNull()
		expect(
			await build({ fetch: async () => json({ nope: 1 }) }).getPipeline('spindle.example', '3kpipelineabc'),
		).toBeNull()
		await expect(
			build({ fetch: async () => json({}, 502) }).getPipeline('spindle.example', '3kpipelineabc'),
		).rejects.toThrow()
	})
})

describe('getPull', () => {
	const authorPds = `${PDS}/xrpc/com.atproto.repo.getRecord`

	test("reads the record from its author's PDS with the cid of that version", async () => {
		const target = `did:plc:${'r'.repeat(24)}`
		const { fetch, requested } = fakeFetch({
			[authorPds]: () =>
				json({ cid: 'bafypull', value: { target: { repo: target, branch: 'main' }, rounds: [{}, {}] } }),
		})

		const pull = await build({ fetch }).getPull(PULL_URI)

		expect(pull).toEqual({
			uri: PULL_URI,
			cid: 'bafypull',
			authorDid: `did:plc:${'u'.repeat(24)}`,
			targetRepoDid: target,
			roundCount: 2,
		})
		expect(requested[0]).toContain('collection=sh.tangled.repo.pull')
		expect(requested[0]).toContain('rkey=3kpull')
	})

	test('refuses another collection without a request', async () => {
		const { fetch, requested } = fakeFetch({})

		expect(await build({ fetch }).getPull(`at://did:plc:${'u'.repeat(24)}/sh.tangled.repo/3kpull`)).toBeNull()
		expect(requested).toEqual([])
	})

	test.each([
		['a missing record', () => json({ error: 'RecordNotFound' }, 400)],
		['no cid', () => json({ value: { target: { repo: 'did:plc:x' }, rounds: [] } })],
		['no target', () => json({ cid: 'c', value: { rounds: [] } })],
		['no rounds', () => json({ cid: 'c', value: { target: { repo: 'did:plc:x' } } })],
	])('is null for %s', async (_name, respond) => {
		const { fetch } = fakeFetch({ [authorPds]: respond })

		expect(await build({ fetch }).getPull(PULL_URI)).toBeNull()
	})
})

describe('claimOwner', () => {
	test('looks the claim up under the base host', async () => {
		const queries: unknown[][] = []
		const sql = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
			queries.push(values)
			return [{ did: OWNER }]
		}

		expect(await build({ sql }).claimOwner('alice')).toBe(OWNER)
		expect(queries).toEqual([['alice.wisp.place']])
	})

	test('is null when unclaimed', async () => {
		expect(await build({ sql: async () => [] }).claimOwner('alice')).toBeNull()
	})

	test.each(['Alice', '-a', 'a--b', 'a.b', '', 'a_b'])('queries nothing for the label %p', async (label) => {
		let queried = 0
		const sql = async () => {
			queried++
			return []
		}

		expect(await build({ sql }).claimOwner(label)).toBeNull()
		expect(queried).toBe(0)
	})
})

describe('previewServes', () => {
	test('is true only for a 200', async () => {
		expect(await build({ fetch: async () => new Response('ok') }).previewServes('https://p.example/')).toBe(true)
		expect(
			await build({ fetch: async () => new Response('x', { status: 404 }) }).previewServes('https://p.example/'),
		).toBe(false)
		expect(
			await build({ fetch: async () => new Response('x', { status: 500 }) }).previewServes('https://p.example/'),
		).toBe(false)
	})

	test('is false instead of throwing when the request fails', async () => {
		const fetch = async () => {
			throw new Error('timeout')
		}

		expect(await build({ fetch }).previewServes('https://p.example/')).toBe(false)
	})
})

describe('findPullForBranch', () => {
	const REPO_DID = `did:plc:${'r'.repeat(24)}`
	const AUTHOR = `did:plc:${'a'.repeat(24)}`
	const pullUri = (rkey: string) => `at://${AUTHOR}/sh.tangled.repo.pull/${rkey}`
	const listed = (items: unknown[]) => () => json({ items })
	const item = (rkey: string, source: Json) => ({ uri: pullUri(rkey), value: { source, target: { repo: REPO_DID } } })
	const record = () =>
		json({ uri: pullUri('3kpull'), cid: 'bafypull', value: { target: { repo: REPO_DID }, rounds: [{}, {}] } })

	test('asks the appview for open pulls on the repo, then reads the match from its author', async () => {
		const { fetch, requested } = fakeFetch({
			'https://appview.example/xrpc/sh.tangled.repo.listPulls': listed([
				item('3kother', { branch: 'main' }),
				item('3kpull', { branch: 'fix' }),
			]),
			[`${PDS}/xrpc/com.atproto.repo.getRecord`]: record,
		})
		const pull = await build({ fetch }).findPullForBranch(REPO_DID, 'fix')
		expect(pull).toEqual({
			uri: pullUri('3kpull'),
			cid: 'bafypull',
			authorDid: AUTHOR,
			targetRepoDid: REPO_DID,
			roundCount: 2,
		})
		expect(requested[0]).toContain(`subject=${encodeURIComponent(REPO_DID)}`)
		expect(requested[0]).toContain('status=open')
		expect(requested[1]).toContain('rkey=3kpull')
	})

	test('skips pulls from a fork', async () => {
		const { fetch } = fakeFetch({
			'https://appview.example/xrpc/sh.tangled.repo.listPulls': listed([
				item('3kfork', { branch: 'fix', repo: `did:plc:${'f'.repeat(24)}` }),
			]),
		})
		expect(await build({ fetch }).findPullForBranch(REPO_DID, 'fix')).toBeNull()
	})
})

describe('isCollaborator', () => {
	const REPO_DID = `did:plc:${'r'.repeat(24)}`
	const SUBJECT = `did:plc:${'s'.repeat(24)}`
	const listed = () =>
		json({
			items: [
				{
					uri: `at://${REPO_DID}/sh.tangled.bobbin.knotCollaborator/${SUBJECT}`,
					value: { $type: 'sh.tangled.repo.collaborator', repo: REPO_DID, subject: SUBJECT },
				},
			],
		})

	test("asks the appview for the repo's collaborators", async () => {
		const { fetch, requested } = fakeFetch({ 'https://appview.example/xrpc/sh.tangled.repo.listCollaborators': listed })
		expect(await build({ fetch }).isCollaborator(REPO_DID, SUBJECT)).toBe(true)
		expect(requested[0]).toContain(`subject=${encodeURIComponent(REPO_DID)}`)
	})

	test('someone not listed is not a collaborator', async () => {
		const { fetch } = fakeFetch({ 'https://appview.example/xrpc/sh.tangled.repo.listCollaborators': listed })
		expect(await build({ fetch }).isCollaborator(REPO_DID, OWNER)).toBe(false)
	})
})

describe('bot comments', () => {
	function fakeAgent(existing: Array<{ uri: string; value: unknown }> = []) {
		const calls: Array<{ op: string; input: Json }> = []
		const repo = {
			createRecord: async (input: Json) => calls.push({ op: 'create', input }),
			putRecord: async (input: Json) => calls.push({ op: 'put', input }),
			// @atproto/api answers with the XRPC body under `data`.
			listRecords: async () => ({ data: { records: existing } }),
		}
		return { agent: { com: { atproto: { repo } } }, calls }
	}
	const input = { pull: { uri: PULL_URI, cid: 'bafy' }, roundIdx: 2, body: 'ok' }

	test('writes the lexicon shape without asking the PDS to validate it', async () => {
		const { agent, calls } = fakeAgent()

		await build({ agent }).createComment(input)

		expect(calls).toHaveLength(1)
		expect(calls[0]?.op).toBe('create')
		expect(calls[0]?.input.collection).toBe('sh.tangled.feed.comment')
		expect(calls[0]?.input.validate).toBe(false)
		expect(calls[0]?.input.record).toMatchObject({
			$type: 'sh.tangled.feed.comment',
			subject: { uri: PULL_URI, cid: 'bafy' },
			pullRoundIdx: 2,
			body: { $type: 'sh.tangled.markup.markdown', text: 'ok' },
		})
	})

	test('finds the comment on a pull request and updates the same record', async () => {
		const existing = [
			{
				uri: 'at://did:plc:bot/sh.tangled.feed.comment/other',
				value: { subject: { uri: 'at://x/y/z' }, body: { text: 'no' } },
			},
			{
				uri: 'at://did:plc:bot/sh.tangled.feed.comment/mine',
				value: { subject: { uri: PULL_URI }, body: { text: 'old body' } },
			},
		]
		const { agent, calls } = fakeAgent(existing)
		const ports = build({ agent })

		expect(await ports.findComment(PULL_URI)).toEqual({ rkey: 'mine', body: 'old body' })
		expect(await ports.findComment('at://nope/x/y')).toBeNull()
		await ports.updateComment('mine', input)

		expect(calls[0]?.op).toBe('put')
		expect(calls[0]?.input.rkey).toBe('mine')
	})
})

describe('findPipelineForCommit', () => {
	test('selects the newest matching pull-request pipeline', async () => {
		const repoDid = `did:plc:${'r'.repeat(24)}`
		const { fetch, requested } = fakeFetch({
			'https://spindle.example/': () =>
				json({
					pipelines: [
						{
							id: '3knewerpipeline',
							repo: repoDid,
							trigger: { $type: 'sh.tangled.ci.trigger#pullRequest', sourceSha: `${SHA}00` },
						},
						{
							id: '3kolderpipeline',
							repo: repoDid,
							trigger: {
								$type: 'sh.tangled.ci.trigger#pullRequest',
								sourceSha: 'fffffff000000000000000000000000000000000',
							},
						},
					],
				}),
		})
		expect(await build({ fetch }).findPipelineForCommit('spindle.example', repoDid, SHA.slice(0, 7))).toBe(
			'3knewerpipeline',
		)
		expect(requested[0]).toContain('kinds=pull_request')
	})

	test('rejects invalid spindle hosts before fetching', async () => {
		const fetch = async () => {
			throw new Error('must not fetch')
		}
		expect(await build({ fetch }).findPipelineForCommit('Spindle.example', OWNER, SHA.slice(0, 7))).toBeNull()
	})
})

test('findPipelineForCommit maps upstream statuses', async () => {
	const five = async () => json({}, 503)
	await expect(
		build({ fetch: five }).findPipelineForCommit('spindle.example', OWNER, SHA.slice(0, 7)),
	).rejects.toThrow()
	const four = async () => json({}, 404)
	expect(await build({ fetch: four }).findPipelineForCommit('spindle.example', OWNER, SHA.slice(0, 7))).toBeNull()
})
