import { describe, expect, test } from 'bun:test'
import { parseLexiconJson } from '@wispplace/lexicons/public-json'
import type { Directory, Record as FsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { expandSubfs, parseSubfsSubject, SubfsExpansionError } from './subfs'

const ROOT_DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const FIRST_DID = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const SECOND_DID = 'did:plc:cccccccccccccccccccccccc'
const CREATED_AT = '2026-01-01T00:00:00.000Z'
const BLOB_REF = {
	$type: 'blob',
	ref: { $link: 'bafkreie56uer6qjm7mqckb52xtd3mecy77t5axnumzdcnhjzpcwiin6zue' },
	mimeType: 'text/plain',
	size: 1,
}

function subject(did: string, rkey: string): string {
	return `at://${did}/place.wisp.subfs/${rkey}`
}

function file(name: string, lexicon: 'fs' | 'subfs' = 'fs'): unknown {
	return {
		name,
		node: {
			$type: `place.wisp.${lexicon}#file`,
			type: 'file',
			blob: BLOB_REF,
		},
	}
}

function rootSubfs(name: string, uri: string, flat?: boolean): unknown {
	return {
		name,
		node: {
			$type: 'place.wisp.fs#subfs',
			type: 'subfs',
			subject: uri,
			...(flat === undefined ? {} : { flat }),
		},
	}
}

function nestedSubfs(name: string, uri: string): unknown {
	return {
		name,
		node: {
			$type: 'place.wisp.subfs#subfs',
			type: 'subfs',
			subject: uri,
		},
	}
}

function root(entries: unknown[]): Directory {
	return parseLexiconJson<FsRecord>({
		$type: 'place.wisp.fs',
		site: 'site',
		createdAt: CREATED_AT,
		root: { type: 'directory', entries },
	}).root
}

function subfs(entries: unknown[]): unknown {
	return {
		$type: 'place.wisp.subfs',
		createdAt: CREATED_AT,
		root: { type: 'directory', entries },
	}
}

function expansionOptions(records: ReadonlyMap<string, unknown>) {
	return {
		rootOwnerDid: ROOT_DID,
		fetchSubfsRecord: async ({ uri }: { uri: string }) => records.get(uri),
	}
}

async function expectExpansionCode(promise: Promise<unknown>, code: string): Promise<void> {
	try {
		await promise
		expect.unreachable('expected SubFS expansion to reject')
	} catch (error) {
		expect(error).toBeInstanceOf(SubfsExpansionError)
		expect(error).toMatchObject({ code })
	}
}

describe('expandSubfs', () => {
	test('only parses canonical DID-owned SubFS record subjects', () => {
		const valid = subject(FIRST_DID, 'record-key_1')
		expect(parseSubfsSubject(valid)).toEqual({
			uri: valid,
			repo: FIRST_DID,
			collection: 'place.wisp.subfs',
			rkey: 'record-key_1',
		})

		for (const invalid of [
			`at://example.com/place.wisp.subfs/record`,
			`at://${FIRST_DID}/place.wisp.fs/record`,
			`at://${FIRST_DID}/place.wisp.subfs/record?query=1`,
			`at://${FIRST_DID}/place.wisp.subfs/record/extra`,
			`at://${FIRST_DID}/place.wisp.subfs/%2F`,
		]) {
			expect(() => parseSubfsSubject(invalid)).toThrow(SubfsExpansionError)
		}
	})
	test('splices default-flat entries in place and retains source owners', async () => {
		const uri = subject(FIRST_DID, 'flat')
		const expanded = await expandSubfs(
			root([file('before.txt'), rootSubfs('mount', uri), file('after.txt')]),
			expansionOptions(new Map([[uri, subfs([file('one.txt', 'subfs'), file('two.txt', 'subfs')])]])),
		)

		expect(expanded.root.entries.map((entry) => entry.name)).toEqual(['before.txt', 'one.txt', 'two.txt', 'after.txt'])
		expect(expanded.ownerDidByFilePath).toEqual(
			new Map([
				['before.txt', ROOT_DID],
				['one.txt', FIRST_DID],
				['two.txt', FIRST_DID],
				['after.txt', ROOT_DID],
			]),
		)
	})

	test('mounts flat=false contents under the entry name', async () => {
		const uri = subject(FIRST_DID, 'mounted')
		const expanded = await expandSubfs(
			root([file('before.txt'), rootSubfs('assets', uri, false), file('after.txt')]),
			expansionOptions(new Map([[uri, subfs([file('logo.txt', 'subfs')])]])),
		)

		expect(expanded.root.entries.map((entry) => entry.name)).toEqual(['before.txt', 'assets', 'after.txt'])
		const mount = expanded.root.entries[1]
		expect(mount?.name).toBe('assets')
		expect(mount?.node).toMatchObject({ type: 'directory' })
		if (!mount || !('type' in mount.node) || mount.node.type !== 'directory') {
			throw new Error('expected an expanded directory')
		}
		expect(mount.node.entries.map((entry) => entry.name)).toEqual(['logo.txt'])
		expect(expanded.ownerDidByFilePath.get('assets/logo.txt')).toBe(FIRST_DID)
	})

	test('uses the nested subject repo as the owner of a cross-repository file', async () => {
		const first = subject(FIRST_DID, 'first')
		const second = subject(SECOND_DID, 'second')
		const expanded = await expandSubfs(
			root([rootSubfs('first', first)]),
			expansionOptions(
				new Map([
					[first, subfs([nestedSubfs('second', second)])],
					[second, subfs([file('from-second.txt', 'subfs')])],
				]),
			),
		)

		expect(expanded.root.entries.map((entry) => entry.name)).toEqual(['from-second.txt'])
		expect(expanded.ownerDidByFilePath.get('from-second.txt')).toBe(SECOND_DID)
	})

	test('memoizes duplicate subjects across separate branches', async () => {
		const uri = subject(FIRST_DID, 'duplicate')
		let fetches = 0
		const expanded = await expandSubfs(root([rootSubfs('flat', uri), rootSubfs('folder', uri, false)]), {
			rootOwnerDid: ROOT_DID,
			fetchSubfsRecord: async () => {
				fetches++
				return subfs([file('child.txt', 'subfs')])
			},
		})

		expect(fetches).toBe(1)
		expect(expanded.ownerDidByFilePath.get('child.txt')).toBe(FIRST_DID)
		expect(expanded.ownerDidByFilePath.get('folder/child.txt')).toBe(FIRST_DID)
	})

	test('fails closed on a branch cycle', async () => {
		const first = subject(FIRST_DID, 'cycle-a')
		const second = subject(FIRST_DID, 'cycle-b')
		await expectExpansionCode(
			expandSubfs(
				root([rootSubfs('first', first)]),
				expansionOptions(
					new Map([
						[first, subfs([nestedSubfs('second', second)])],
						[second, subfs([nestedSubfs('first', first)])],
					]),
				),
			),
			'CYCLE',
		)
	})

	test('rejects a flat output-path collision', async () => {
		const uri = subject(FIRST_DID, 'collision')
		await expectExpansionCode(
			expandSubfs(
				root([file('same.txt'), rootSubfs('flat', uri)]),
				expansionOptions(new Map([[uri, subfs([file('same.txt', 'subfs')])]])),
			),
			'DUPLICATE_PATH',
		)
	})

	test('enforces depth, record, entry, and file budgets', async () => {
		const first = subject(FIRST_DID, 'budget-a')
		const second = subject(FIRST_DID, 'budget-b')
		const records = new Map<string, unknown>([
			[first, subfs([nestedSubfs('second', second)])],
			[second, subfs([file('one.txt', 'subfs'), file('two.txt', 'subfs')])],
		])

		await expectExpansionCode(
			expandSubfs(root([rootSubfs('first', first)]), {
				...expansionOptions(records),
				limits: { maxDepth: 1 },
			}),
			'MAX_DEPTH',
		)
		await expectExpansionCode(
			expandSubfs(root([rootSubfs('first', first), rootSubfs('second', second)]), {
				...expansionOptions(records),
				limits: { maxRecords: 1 },
			}),
			'MAX_RECORDS',
		)
		await expectExpansionCode(
			expandSubfs(root([rootSubfs('second', second)]), {
				...expansionOptions(records),
				limits: { maxEntries: 1 },
			}),
			'MAX_ENTRIES',
		)
		await expectExpansionCode(
			expandSubfs(root([rootSubfs('second', second)]), {
				...expansionOptions(records),
				limits: { maxFiles: 1 },
			}),
			'MAX_FILES',
		)
	})

	test('rejects invalid subjects, missing records, and invalid fetched records', async () => {
		const invalid = 'at://not-a-did/place.wisp.subfs/record'
		await expectExpansionCode(
			expandSubfs(root([rootSubfs('invalid', invalid)]), expansionOptions(new Map())),
			'INVALID_SUBJECT',
		)

		const missing = subject(FIRST_DID, 'missing')
		await expectExpansionCode(
			expandSubfs(root([rootSubfs('missing', missing)]), expansionOptions(new Map())),
			'MISSING_RECORD',
		)

		const transient = subject(FIRST_DID, 'transient')
		await expectExpansionCode(
			expandSubfs(root([rootSubfs('transient', transient)]), {
				rootOwnerDid: ROOT_DID,
				fetchSubfsRecord: async () => {
					throw new Error('https://untrusted.example/should-not-leak')
				},
			}),
			'FETCH_FAILED',
		)

		const malformed = subject(FIRST_DID, 'malformed')
		await expectExpansionCode(
			expandSubfs(
				root([rootSubfs('malformed', malformed)]),
				expansionOptions(new Map([[malformed, { $type: 'place.wisp.subfs', root: { type: 'directory' } }]])),
			),
			'INVALID_RECORD',
		)
	})

	test('never exceeds the configured concurrent fetch limit', async () => {
		const uris = Array.from({ length: 6 }, (_value, index) => subject(FIRST_DID, `parallel-${index}`))
		const records = new Map(uris.map((uri, index) => [uri, subfs([file(`file-${index}.txt`, 'subfs')])]))
		let active = 0
		let maxActive = 0
		let signalTwoStarted: (() => void) | undefined
		const twoStarted = new Promise<void>((resolve) => {
			signalTwoStarted = resolve
		})
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})

		const pending = expandSubfs(root(uris.map((uri, index) => rootSubfs(`mount-${index}`, uri))), {
			rootOwnerDid: ROOT_DID,
			limits: { maxConcurrentFetches: 2 },
			fetchSubfsRecord: async ({ uri }) => {
				active++
				maxActive = Math.max(maxActive, active)
				if (active === 2) signalTwoStarted?.()
				await gate
				active--
				return records.get(uri)
			},
		})

		await twoStarted
		expect(maxActive).toBe(2)
		release?.()
		await pending
		expect(maxActive).toBeLessThanOrEqual(2)
	})
})

test('enforces the aggregate raw JSON byte budget across fetched SubFS records', async () => {
	const first = subject(FIRST_DID, 'raw-budget-a')
	const second = subject(FIRST_DID, 'raw-budget-b')
	const firstRecord = subfs([file('first.txt', 'subfs')])
	const secondRecord = subfs([file('second.txt', 'subfs')])
	const firstBytes = new TextEncoder().encode(JSON.stringify(firstRecord)).byteLength

	await expectExpansionCode(
		expandSubfs(root([rootSubfs('first', first), rootSubfs('second', second)]), {
			rootOwnerDid: ROOT_DID,
			fetchSubfsRecord: async ({ uri }: { uri: string }) => (uri === first ? firstRecord : secondRecord),
			limits: { maxRawJsonBytes: firstBytes },
		}),
		'MAX_RAW_BYTES',
	)
})

test('yields a real macrotask so a deadline timer can interrupt a large tree', async () => {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new Error('tree deadline')), 0)
	try {
		await expect(
			expandSubfs(root(Array.from({ length: 64 }, (_, index) => file(`file-${index}.txt`))), {
				rootOwnerDid: ROOT_DID,
				fetchSubfsRecord: async () => null,
				signal: controller.signal,
			}),
		).rejects.toThrow('tree deadline')
	} finally {
		clearTimeout(timer)
	}
})
