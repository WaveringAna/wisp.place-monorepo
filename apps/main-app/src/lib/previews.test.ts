import { describe, expect, test } from 'bun:test'
import { parsePreviewHook, previewHookRecord, previewHookRkey, previewRows, toTangledRepos } from './previews'
import { validateWebhookCreateInput } from './webhook-policy'

const BOT = 'https://preview-bot.wisp.place'
const DID = 'did:plc:3rwz3xfw2crswgifqgc3g7zh'
const REPO_DID = 'did:plc:kya7uhnwkpq7zfngkebpxl6i'

describe('toTangledRepos', () => {
	test('names a repo by its record key when the record has no name', () => {
		const repos = toTangledRepos([
			{
				uri: `at://${DID}/sh.tangled.repo/wisp-preview-test`,
				value: { spindle: 'spindle.tangled.sh', repoDid: REPO_DID, knot: 'knot1.tangled.sh' },
			},
			{ uri: `at://${DID}/sh.tangled.repo/3mlfedz5snx22`, value: { name: 'sister-radio', knot: 'knot1.tangled.sh' } },
		])
		expect(repos).toEqual([
			{
				rkey: 'wisp-preview-test',
				name: 'wisp-preview-test',
				spindle: 'spindle.tangled.sh',
				repoDid: REPO_DID,
				knot: 'knot1.tangled.sh',
			},
			{ rkey: '3mlfedz5snx22', name: 'sister-radio', spindle: undefined, repoDid: undefined, knot: 'knot1.tangled.sh' },
		])
	})

	test('drops records it cannot read and spindles that are not plain hostnames', () => {
		const repos = toTangledRepos([
			null,
			{ uri: 5, value: {} },
			{ uri: `at://${DID}/sh.tangled.repo/a`, value: { spindle: 'https://evil.example/x', repoDid: REPO_DID } },
		])
		expect(repos).toEqual([{ rkey: 'a', name: 'a', spindle: undefined, repoDid: REPO_DID, knot: undefined }])
	})
})

describe('preview hook records', () => {
	test("watch the owner's site records and wake the bot for one repo and claim", () => {
		const record = previewHookRecord(BOT, DID, 'wisp-preview-test', 'null')
		expect(record).toEqual({
			scopeAturi: `at://${DID}/place.wisp.fs`,
			url: `${BOT}/v1/hook?repo=wisp-preview-test&claim=null`,
			events: ['create', 'update'],
			enabled: true,
		})
		expect(previewHookRkey('wisp-preview-test')).toBe('preview-wisp-preview-test')
		expect(validateWebhookCreateInput(record, { allowLoopbackDev: false }).ok).toBe(true)
	})

	test('are recognised by their bot url and nothing else', () => {
		const url = `${BOT}/v1/hook?repo=blog&claim=alice`
		expect(parsePreviewHook(BOT, 'preview-blog', { url })).toEqual({
			rkey: 'preview-blog',
			repo: 'blog',
			claim: 'alice',
		})
		expect(parsePreviewHook(BOT, 'x', { url: 'https://example.com/v1/hook?repo=blog&claim=alice' })).toBeNull()
		expect(parsePreviewHook(BOT, 'x', { url: `${BOT}/v1/hook?repo=blog` })).toBeNull()
		expect(parsePreviewHook(BOT, 'x', { url: `${BOT}/v1/hook?repo=blog&claim=Not%20A%20Claim` })).toBeNull()
		expect(parsePreviewHook(BOT, 'x', {})).toBeNull()
	})
})

describe('previewRows', () => {
	const repos = toTangledRepos([
		{ uri: `at://${DID}/sh.tangled.repo/blog`, value: { spindle: 'spindle.tangled.sh', repoDid: REPO_DID } },
		{ uri: `at://${DID}/sh.tangled.repo/notes`, value: { repoDid: REPO_DID } },
	])

	test('marks enabled repos with their claim and says why the others cannot preview', () => {
		const rows = previewRows(repos, [{ rkey: 'preview-blog', repo: 'blog', claim: 'alice' }])
		expect(rows).toEqual([
			{
				rkey: 'blog',
				name: 'blog',
				spindle: 'spindle.tangled.sh',
				repoDid: REPO_DID,
				knot: undefined,
				preview: { claim: 'alice', hookRkey: 'preview-blog' },
				blocked: null,
			},
			{
				rkey: 'notes',
				name: 'notes',
				spindle: undefined,
				repoDid: REPO_DID,
				knot: undefined,
				preview: null,
				blocked: 'no-spindle',
			},
		])
	})
})
