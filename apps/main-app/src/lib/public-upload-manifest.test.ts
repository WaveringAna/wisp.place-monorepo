import { describe, expect, test } from 'bun:test'
import { BlobRef } from '@atproto/api'
import { expandSubfs } from '@wispplace/atproto-utils'
import { type Directory, type Entry, validateRecord as validateFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { validateRecord as validateSubfsRecord } from '@wispplace/lexicons/types/place/wisp/subfs'
import { CID } from 'multiformats/cid'
import {
	commitPublicUploadManifest,
	loadExistingUploadState,
	PublicUploadError,
	UPLOAD_CONFLICT_MESSAGE,
} from './public-upload'

const DID = 'did:example:manifestowner'
const BLOB_CID = 'bafkreie56uer6qjm7mqckb52xtd3mecy77t5axnumzdcnhjzpcwiin6zue'

const fileEntry = (name: string): Entry =>
	({
		name,
		node: {
			$type: 'place.wisp.fs#file',
			type: 'file',
			blob: new BlobRef(CID.parse(BLOB_CID), 'text/plain', 1),
		},
	}) as Entry

const directory = (entries: Entry[]): Directory => ({
	$type: 'place.wisp.fs#directory',
	type: 'directory',
	entries,
})

function pathsIn(directory: Directory, prefix = ''): string[] {
	const paths: string[] = []
	for (const entry of directory.entries) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name
		if (!('type' in entry.node)) continue
		if (entry.node.type === 'file') paths.push(path)
		if (entry.node.type === 'directory') paths.push(...pathsIn(entry.node as Directory, path))
	}
	return paths
}

function manifestAgent() {
	const subfsRecords = new Map<string, unknown>()
	let mainRecord: unknown
	const agent = {
		com: {
			atproto: {
				repo: {
					putRecord: async ({ collection, rkey, record }: { collection: string; rkey: string; record: unknown }) => {
						const uri = `at://${DID}/${collection}/${rkey}`
						if (collection === 'place.wisp.subfs') subfsRecords.set(uri, record)
						else mainRecord = record
						return { data: { uri, cid: BLOB_CID } }
					},
					getRecord: async ({ rkey }: { rkey: string }) => ({ data: { value: subfsRecords.get(rkey) } }),
					deleteRecord: async () => undefined,
				},
			},
		},
	}
	return { agent, subfsRecords, mainRecord: () => mainRecord }
}

function compareAndSwapAgent(initialCid: string | null) {
	let currentCid = initialCid
	let sequence = 0
	const rootWrites: Array<{ swapRecord: unknown }> = []
	const agent = {
		com: {
			atproto: {
				repo: {
					putRecord: async (input: { collection: string; rkey: string; swapRecord?: unknown }) => {
						if (input.collection === 'place.wisp.subfs') {
							return { data: { uri: `at://${DID}/${input.collection}/${input.rkey}`, cid: BLOB_CID } }
						}
						rootWrites.push({ swapRecord: input.swapRecord })
						await Promise.resolve()
						if (input.swapRecord !== currentCid) {
							throw Object.assign(new Error('swap rejected'), { status: 409, error: 'InvalidSwap' })
						}
						currentCid = `cid-${++sequence}`
						return { data: { uri: `at://${DID}/${input.collection}/${input.rkey}`, cid: currentCid } }
					},
					getRecord: async () => {
						if (currentCid === null) throw { error: 'RecordNotFound', status: 404 }
						return { data: { cid: currentCid, value: { $type: 'place.wisp.fs', root: directory([]) } } }
					},
					deleteRecord: async () => undefined,
				},
			},
		},
	}
	return { agent, rootWrites, currentCid: () => currentCid }
}

async function expectRoundTrip(root: Directory, expectedPaths: string[]): Promise<void> {
	const fixture = manifestAgent()
	await commitPublicUploadManifest(fixture.agent as never, DID, 'split-site', root, expectedPaths.length)
	const mainRecord = fixture.mainRecord() as { root: Directory; fileCount: number }

	expect(validateFsRecord(mainRecord).success).toBe(true)
	expect(mainRecord.fileCount).toBe(expectedPaths.length)
	for (const record of fixture.subfsRecords.values()) {
		expect(validateSubfsRecord(record).success).toBe(true)
	}

	const expanded = await expandSubfs(mainRecord.root as never, {
		rootOwnerDid: DID,
		fetchSubfsRecord: async (subject) => JSON.parse(JSON.stringify(fixture.subfsRecords.get(subject.uri))),
	})
	expect(pathsIn(expanded.root as Directory).sort()).toEqual([...expectedPaths].sort())
}

describe('public manifest splitting', () => {
	test('preserves paths and total fileCount for an oversized nested directory', async () => {
		const names = Array.from({ length: 1_000 }, (_, index) => `${index}-${'x'.repeat(80)}.txt`)
		const root = directory([
			{
				name: 'nested',
				node: directory(names.map(fileEntry)),
			} as Entry,
		])
		await expectRoundTrip(
			root,
			names.map((name) => `nested/${name}`),
		)
	})

	test('preserves paths and total fileCount for 1000 direct root files', async () => {
		const names = Array.from({ length: 1_000 }, (_, index) => `${index}.txt`)
		await expectRoundTrip(directory(names.map(fileEntry)), names)
	})

	test('does not delete newly generated records when a concurrent committed root references them', async () => {
		const names = Array.from({ length: 250 }, (_, index) => `${index}.txt`)
		const root = directory(names.map(fileEntry))
		let generatedUri = ''
		const deleted: unknown[] = []
		const agent = {
			com: {
				atproto: {
					repo: {
						putRecord: async ({ collection, rkey }: { collection: string; rkey: string }) => {
							if (collection === 'place.wisp.subfs') {
								generatedUri = `at://${DID}/${collection}/${rkey}`
								return { data: { uri: generatedUri, cid: BLOB_CID } }
							}
							throw Object.assign(new Error('main record failed'), { status: 400 })
						},
						getRecord: async () => ({
							data: {
								value: {
									$type: 'place.wisp.fs',
									root: directory([
										{
											name: '__subfs_live',
											node: {
												$type: 'place.wisp.fs#subfs',
												type: 'subfs',
												subject: generatedUri,
												flat: true,
											},
										} as Entry,
									]),
								},
							},
						}),
						deleteRecord: async (input: unknown) => {
							deleted.push(input)
						},
					},
				},
			},
		}

		await expect(commitPublicUploadManifest(agent as never, DID, 'race-site', root, names.length)).rejects.toBeDefined()
		expect(deleted).toEqual([])
	})
	test('compares the loaded root CID so concurrent stale jobs cannot overwrite a manifest', async () => {
		const fixture = compareAndSwapAgent('cid-before')
		const root = directory([fileEntry('index.html')])
		const [firstState, secondState] = await Promise.all([
			loadExistingUploadState(fixture.agent as never, DID, 'cas-site'),
			loadExistingUploadState(fixture.agent as never, DID, 'cas-site'),
		])
		expect(firstState.rootCid).toBe('cid-before')
		expect(secondState.rootCid).toBe('cid-before')
		const attempts = await Promise.allSettled([
			commitPublicUploadManifest(
				fixture.agent as never,
				DID,
				'cas-site',
				root,
				1,
				undefined,
				undefined,
				firstState.rootCid,
			),
			commitPublicUploadManifest(
				fixture.agent as never,
				DID,
				'cas-site',
				root,
				1,
				undefined,
				undefined,
				secondState.rootCid,
			),
		])

		expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
		const rejected = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult
		expect(rejected.reason).toBeInstanceOf(PublicUploadError)
		expect(rejected.reason).toMatchObject({ status: 409, message: UPLOAD_CONFLICT_MESSAGE })
		expect(fixture.rootWrites).toEqual([{ swapRecord: 'cid-before' }, { swapRecord: 'cid-before' }])
		expect(fixture.currentCid()).toBe('cid-1')
	})

	test('uses null swapRecord for a new-record race and lets only one writer create it', async () => {
		const fixture = compareAndSwapAgent(null)
		const root = directory([fileEntry('index.html')])
		const [firstState, secondState] = await Promise.all([
			loadExistingUploadState(fixture.agent as never, DID, 'new-race'),
			loadExistingUploadState(fixture.agent as never, DID, 'new-race'),
		])
		expect(firstState.rootCid).toBeNull()
		expect(secondState.rootCid).toBeNull()
		const attempts = await Promise.allSettled([
			commitPublicUploadManifest(
				fixture.agent as never,
				DID,
				'new-race',
				root,
				1,
				undefined,
				undefined,
				firstState.rootCid,
			),
			commitPublicUploadManifest(
				fixture.agent as never,
				DID,
				'new-race',
				root,
				1,
				undefined,
				undefined,
				secondState.rootCid,
			),
		])

		expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
		expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
		expect(fixture.rootWrites).toEqual([{ swapRecord: null }, { swapRecord: null }])
	})

	test('keeps CAS protection when a database advisory lock session is lost', async () => {
		const fixture = compareAndSwapAgent('cid-before')
		const root = directory([fileEntry('index.html')])
		await commitPublicUploadManifest(
			fixture.agent as never,
			DID,
			'lock-loss',
			root,
			1,
			undefined,
			undefined,
			'cid-before',
		)
		await expect(
			commitPublicUploadManifest(fixture.agent as never, DID, 'lock-loss', root, 1, undefined, undefined, 'cid-before'),
		).rejects.toMatchObject({ status: 409, message: UPLOAD_CONFLICT_MESSAGE })
		expect(fixture.currentCid()).toBe('cid-1')
	})
})
