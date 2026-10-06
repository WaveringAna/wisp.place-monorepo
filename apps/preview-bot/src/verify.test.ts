import { describe, expect, test } from 'bun:test'
import type { Pipeline, Ports, Pull, RepoRecord } from './ports'
import { type PreviewRequest, type Rejection, verifyHook, verifyPreview } from './verify'

const OWNER = 'did:plc:mmmmmmmmmmmmmmmmmmmmmmmm'
const ATTACKER = 'did:plc:xxxxxxxxxxxxxxxxxxxxxxxx'
const REPO_DID = 'did:plc:rrrrrrrrrrrrrrrrrrrrrrrr'
const SHA = 'ab12cd3ef4567890123456789012345678901234'
const PULL_URI = 'at://did:plc:uuuuuuuuuuuuuuuuuuuuuuuu/sh.tangled.repo.pull/3kpull'

const request: PreviewRequest = { owner: OWNER, repo: 'blog', pipeline: '3kpipeline', claim: 'alice' }

const repoRecord: RepoRecord = { rkey: 'blog', name: 'blog', spindle: 'spindle.example', repoDid: REPO_DID }
const pipeline: Pipeline = { repo: REPO_DID, pullRequest: { pull: PULL_URI, sourceSha: SHA } }
const pull: Pull = {
	uri: PULL_URI,
	cid: 'bafypull',
	authorDid: 'did:plc:uuuuuuuuuuuuuuuuuuuuuuuu',
	targetRepoDid: REPO_DID,
	roundCount: 3,
}

interface Calls {
	pipelines: Array<[string, string]>
	probes: string[]
}

function fakePorts(overrides: Partial<Ports> = {}): { ports: Ports; calls: Calls } {
	const calls: Calls = { pipelines: [], probes: [] }
	const ports: Ports = {
		listRepoRecords: async () => [repoRecord],
		findPipelineForCommit: async () => '3kpipelineabc',
		findPullForBranch: async () => null,
		getPipeline: async (host, id) => {
			calls.pipelines.push([host, id])
			return pipeline
		},
		getPull: async () => pull,
		claimOwner: async () => OWNER,
		previewServes: async (url) => {
			calls.probes.push(url)
			return true
		},
		findComment: async () => null,
		createComment: async () => {},
		updateComment: async () => {},
		...overrides,
	}
	return { ports, calls }
}

const config = { previewHost: 'preview.wisp.place' }

describe('verifyPreview', () => {
	test('accepts a preview whose every link is anchored in an authority the owner controls', async () => {
		const { ports, calls } = fakePorts()

		const result = await verifyPreview(request, ports, config)

		expect(result).toEqual({
			ok: true,
			url: 'https://pr-ab12cd3-alice.preview.wisp.place/',
			sha7: 'ab12cd3',
			sha: SHA,
			pull: { uri: PULL_URI, cid: 'bafypull' },
			roundIdx: 2,
		})
		expect(calls.pipelines).toEqual([['spindle.example', '3kpipeline']])
		expect(calls.probes).toEqual(['https://pr-ab12cd3-alice.preview.wisp.place/'])
	})

	test("asks the spindle named in the owner's repo record, never one the request names", async () => {
		const { ports, calls } = fakePorts()

		await verifyPreview({ ...request, spindle: 'evil.example' } as PreviewRequest, ports, config)

		expect(calls.pipelines.map(([host]) => host)).toEqual(['spindle.example'])
	})

	test.each([
		['repo-not-found', { listRepoRecords: async () => [] }],
		['repo-not-found', { listRepoRecords: async () => [{ ...repoRecord, name: 'other' }] }],
		['repo-unusable', { listRepoRecords: async () => [{ ...repoRecord, spindle: undefined }] }],
		['repo-unusable', { listRepoRecords: async () => [{ ...repoRecord, repoDid: undefined }] }],
		[
			'repo-ambiguous',
			{
				listRepoRecords: async () => [
					repoRecord,
					{ ...repoRecord, rkey: 'blog2', repoDid: 'did:plc:oooooooooooooooooooooooo' },
				],
			},
		],
		['pipeline-not-found', { getPipeline: async () => null }],
		['not-a-pull-request', { getPipeline: async () => ({ repo: REPO_DID }) }],
		['not-a-pull-request', { getPipeline: async () => ({ repo: REPO_DID, pullRequest: { sourceSha: SHA } }) }],
		[
			'fork-pull-request',
			{ getPipeline: async () => ({ ...pipeline, sourceRepo: 'did:plc:ffffffffffffffffffffffff' }) },
		],
		['repo-mismatch', { getPipeline: async () => ({ ...pipeline, repo: 'did:plc:ssssssssssssssssssssssss' }) }],
		['repo-mismatch', { getPipeline: async () => ({ ...pipeline, repo: undefined }) }],
		['pull-not-found', { getPull: async () => null }],
		['pull-repo-mismatch', { getPull: async () => ({ ...pull, targetRepoDid: 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee' }) }],
		['pull-has-no-rounds', { getPull: async () => ({ ...pull, roundCount: 0 }) }],
		['claim-not-owned', { claimOwner: async () => null }],
		['preview-not-serving', { previewServes: async () => false }],
	] as Array<[Rejection, Partial<Ports>]>)('rejects with %s', async (reason, overrides) => {
		const { ports } = fakePorts(overrides)

		const result = await verifyPreview(request, ports, config)

		expect(result).toEqual({ ok: false, reason })
	})

	test('does not probe the preview before ownership is established', async () => {
		const { ports, calls } = fakePorts({ claimOwner: async () => null })

		await verifyPreview(request, ports, config)

		expect(calls.probes).toEqual([])
	})

	test('refuses a label too long for one DNS label', async () => {
		const { ports } = fakePorts({ claimOwner: async () => OWNER })

		const result = await verifyPreview({ ...request, claim: 'a'.repeat(53) }, ports, config)

		expect(result).toEqual({ ok: false, reason: 'label-too-long' })
	})

	test.each([
		['owner', { owner: 'alice' }],
		['owner', { owner: 'did:plc:x y' }],
		['repo', { repo: '../x' }],
		['repo', { repo: '' }],
		['pipeline', { pipeline: 'A/B' }],
		['pipeline', { pipeline: 'x'.repeat(65) }],
		['claim', { claim: 'Alice' }],
		['claim', { claim: '-a' }],
		['claim', { claim: 'a--b' }],
	] as Array<[string, Partial<PreviewRequest>]>)('rejects a malformed %s before any lookup', async (_field, patch) => {
		let lookups = 0
		const { ports } = fakePorts({
			listRepoRecords: async () => {
				lookups++
				return [repoRecord]
			},
		})

		const result = await verifyPreview({ ...request, ...patch }, ports, config)

		expect(result).toEqual({ ok: false, reason: 'bad-request' })
		expect(lookups).toBe(0)
	})
})

describe('verifyHook', () => {
	const hook = { owner: OWNER, deployer: OWNER, repo: 'blog', claim: 'alice', sha7: 'ab12cd3' }

	test("finds the pull-request run of the deployed commit on the repo's own spindle, then verifies it", async () => {
		const asked: string[][] = []
		const { ports, calls } = fakePorts({
			findPipelineForCommit: async (host, repoDid, sha7) => {
				asked.push([host, repoDid, sha7])
				return '3kpipeline'
			},
		})

		const result = await verifyHook(hook, ports, config)

		expect(result.ok && result.url).toBe('https://pr-ab12cd3-alice.preview.wisp.place/')
		expect(asked).toEqual([['spindle.example', REPO_DID, 'ab12cd3']])
		expect(calls.pipelines).toEqual([['spindle.example', '3kpipeline']])
	})

	test('waits for a run the spindle does not list yet', async () => {
		const { ports } = fakePorts({ findPipelineForCommit: async () => null })
		expect(await verifyHook(hook, ports, config)).toEqual({ ok: false, reason: 'pipeline-not-found' })
	})

	test.each([
		{ sha7: 'ABC1234' },
		{ sha7: 'ab12cd' },
		{ repo: '../x' },
		{ claim: 'Alice' },
		{ owner: 'alice' },
	])('refuses %p before any lookup', async (overrides) => {
		let looked = false
		const { ports } = fakePorts({
			listRepoRecords: async () => {
				looked = true
				return []
			},
		})
		expect(await verifyHook({ ...hook, ...overrides }, ports, config)).toEqual({ ok: false, reason: 'bad-request' })
		expect(looked).toBe(false)
	})

	test('refuses a claim that belongs to someone other than the deployer', async () => {
		const { ports } = fakePorts({ claimOwner: async () => OWNER })
		expect(await verifyHook({ ...hook, deployer: ATTACKER }, ports, config)).toEqual({
			ok: false,
			reason: 'claim-not-owned',
		})
	})

	test('finds the pull request a branch run belongs to, whoever opened it', async () => {
		const asked: string[][] = []
		const { ports } = fakePorts({
			getPipeline: async () => ({ repo: REPO_DID, pullRequest: { sourceSha: SHA, sourceBranch: 'fix' } }),
			findPullForBranch: async (repoDid, branch) => {
				asked.push([repoDid, branch])
				return pull
			},
		})
		expect((await verifyHook(hook, ports, config)).ok).toBe(true)
		expect(asked).toEqual([[REPO_DID, 'fix']])
	})
})
