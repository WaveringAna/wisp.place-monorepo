import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import type { CursorRepository, PriorReferenceRepository } from './firehose'
import type { JetstreamClient, JetstreamEvent, JetstreamOptions } from './jetstream'

// Firehose imports its database namespace at module load. Keep unit tests fully
// in-memory; the real DB behavior is covered by db/backfill tests.
mock.module('./db', () => ({
	MAX_BACKLINK_REFERENCES_PER_EVENT: 100,
	MAX_BACKLINK_REFERENCE_ROWS: 100_000,
	loadCursor: async () => undefined,
	saveCursor: async () => undefined,
	loadCursorForStream: async () => undefined,
	saveCursorForStream: async () => undefined,
	loadPriorReferenceIndex: async () => undefined,
	savePriorReferenceIndex: async () => 'stored',
	deletePriorReferenceIndex: async () => false,
	loadPriorReferenceKeys: async () => ({ keys: [], complete: true }),
	enqueueWebhookDeliveries: async () => ({ enqueued: 0, deduplicated: 0 }),
	recordWebhookIntakeQuarantine: async () => undefined,
	getWebhookRecord: async () => undefined,
	upsertWebhookRecord: async () => false,
	deleteWebhookRecord: async () => false,
	loadActiveWebhooks: async () => ({ rows: [], overflow: false }),
	loadActiveWebhooksForOwner: async () => ({ rows: [], overflow: false }),
}))

const firehose = await import('./firehose')
const delivery = await import('./delivery')
const { getEventStats, initScopeDids, resetFirehoseForTests, startFirehose } = firehose

const OWNER = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const SCOPE = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const REV = '3lq6x5f2abcde'

class FakeJetstream {
	started = false
	paused = false
	constructor(readonly options: JetstreamOptions) {}
	get isConnected(): boolean {
		return true
	}
	get isQuarantined(): boolean {
		return false
	}
	get protocolFailureCount(): number {
		return 0
	}
	get queued(): number {
		return 0
	}
	get failureKind(): undefined {
		return undefined
	}
	get lastProgressTime(): undefined {
		return undefined
	}
	start(): void {
		this.started = true
	}
	pause(): void {
		this.paused = true
	}
	resume(): void {
		this.paused = false
	}
	stopAccepting(): void {}
	async drain(): Promise<void> {}
	destroy(): void {}
}

function record(scopeDid = SCOPE, enabled = true): WhRecord {
	return {
		$type: 'place.wisp.v2.wh',
		scope: { aturi: `at://${scopeDid}` },
		url: 'https://receiver.example/hook',
		createdAt: '2025-01-01T00:00:00.000Z',
		...(enabled ? {} : { enabled: false }),
	}
}

function commit(timeUs: number): JetstreamEvent {
	return {
		did: SCOPE,
		time_us: timeUs,
		kind: 'commit',
		commit: { rev: REV, operation: 'create', collection: 'app.bsky.feed.post', rkey: 'one', record: { text: 'ok' } },
	}
}

/** In-memory stand-in for the durable reference table that records its traffic. */
interface ReferenceProbe extends PriorReferenceRepository {
	readonly rows: Map<string, readonly string[]>
	readonly loads: string[]
	readonly writes: string[]
	complete: boolean
}

function referenceProbe(seed: Iterable<[string, readonly string[]]> = []): ReferenceProbe {
	const rows = new Map<string, readonly string[]>(seed)
	const probe: ReferenceProbe = {
		rows,
		loads: [],
		writes: [],
		complete: true,
		async load(key) {
			probe.loads.push(key)
			const references = rows.get(key)
			return references ? { references, timeUs: 0, rev: REV } : undefined
		},
		async save(key, references) {
			probe.writes.push(key)
			if (references.length === 0) {
				if (!rows.has(key)) return 'stale'
				rows.set(key, [])
				return 'cleared'
			}
			rows.set(key, [...references])
			return 'stored'
		},
		async delete(key) {
			probe.writes.push(key)
			return rows.delete(key)
		},
		async keys() {
			return {
				keys: [...rows].filter(([, references]) => references.length > 0).map(([key]) => key),
				complete: probe.complete,
			}
		},
	}
	return probe
}

function testDependencies(created: FakeJetstream[], references: PriorReferenceRepository = referenceProbe()) {
	const cursor: CursorRepository = { load: async () => undefined, save: async () => undefined }
	return {
		cursorRepository: cursor,
		referenceRepository: references,
		createJetstreamClient: (options: JetstreamOptions) => {
			const client = new FakeJetstream(options)
			created.push(client)
			return client as unknown as JetstreamClient
		},
	}
}

afterEach(() => {
	resetFirehoseForTests()
})

describe('firehose admitted in-memory candidate index', () => {
	test('subscribes owner and scope DID, then matches owner A scoped to B without a DB candidate scan', async () => {
		initScopeDids([{ did: OWNER, rkey: 'hook', record: record() }])
		const created: FakeJetstream[] = []
		const enqueued: number[] = []
		await startFirehose({
			...testDependencies(created),
			enqueueWebhookDeliveries: async (entries) => {
				enqueued.push(entries.length)
				return { enqueued: entries.length, deduplicated: 0 }
			},
			recordWebhookIntakeQuarantine: async () => undefined,
		})
		const direct = created.find((client) => client.options.wantedDids?.includes(SCOPE))
		expect(direct?.options.wantedDids).toEqual(expect.arrayContaining([OWNER, SCOPE]))
		await direct?.options.onEvent(commit(10))
		expect(enqueued).toEqual([1])
	})

	test('quarantines deterministic poison, commits its cursor path, and continues with a valid event', async () => {
		initScopeDids([{ did: OWNER, rkey: 'hook', record: record() }])
		const created: FakeJetstream[] = []
		const quarantines: string[] = []
		const saved: number[] = []
		let poison = true
		await startFirehose({
			...testDependencies(created),
			cursorRepository: {
				load: async () => undefined,
				save: async (_stream, cursor) => {
					saved.push(cursor)
				},
			},
			enqueueWebhookDeliveries: async (entries) => {
				if (poison) {
					poison = false
					throw new delivery.WebhookDeliveryInputError('payload_too_large', 'too large')
				}
				return { enqueued: entries.length, deduplicated: 0 }
			},
			recordWebhookIntakeQuarantine: async (input) => {
				quarantines.push(input.reason)
			},
		})
		const direct = created.find((client) => client.options.wantedDids?.includes(SCOPE))
		expect(direct).toBeDefined()
		const poisonEvent = commit(20)
		await direct?.options.onEvent(poisonEvent)
		await direct?.options.onAcknowledged?.(poisonEvent)
		const validEvent = commit(21)
		await direct?.options.onEvent(validEvent)
		await direct?.options.onAcknowledged?.(validEvent)
		expect(quarantines).toEqual(['payload_too_large'])
		expect(saved).toEqual([20, 21])
	})

	test('bounds a direct-PDS owner flood deterministically at the per-owner admission cap', async () => {
		const rows = Array.from({ length: 101 }, (_, index) => ({
			did: OWNER,
			rkey: `hook-${String(index).padStart(3, '0')}`,
			record: record(),
		}))
		initScopeDids(rows)
		const created: FakeJetstream[] = []
		let candidateCount = 0
		await startFirehose({
			...testDependencies(created),
			enqueueWebhookDeliveries: async (entries) => {
				candidateCount = entries.length
				return { enqueued: entries.length, deduplicated: 0 }
			},
			recordWebhookIntakeQuarantine: async () => undefined,
		})
		const direct = created.find((client) => client.options.wantedDids?.includes(SCOPE))
		await direct?.options.onEvent(commit(30))
		expect(candidateCount).toBe(100)
		expect(getEventStats().rejectedSubscriptionAdmissions).toBeGreaterThanOrEqual(1)
	})

	test('disabled records do not consume active-owner admission capacity', async () => {
		const disabled = Array.from({ length: 500 }, (_, index) => ({
			did: OWNER,
			rkey: `disabled-${index}`,
			record: record(SCOPE, false),
		}))
		initScopeDids([...disabled, { did: OWNER, rkey: 'active', record: record() }])
		const created: FakeJetstream[] = []
		let candidateCount = 0
		await startFirehose({
			...testDependencies(created),
			enqueueWebhookDeliveries: async (entries) => {
				candidateCount = entries.length
				return { enqueued: entries.length, deduplicated: 0 }
			},
			recordWebhookIntakeQuarantine: async () => undefined,
		})
		const direct = created.find((client) => client.options.wantedDids?.includes(SCOPE))
		await direct?.options.onEvent(commit(40))
		expect(candidateCount).toBe(1)
	})
})

const VISITOR = 'did:plc:cccccccccccccccccccccccc'
const VISITOR_KEY = `at://${VISITOR}/app.bsky.feed.like/like`
const SUBJECT = `at://${SCOPE}/app.bsky.feed.post/abc`

function backlinkRecord(): WhRecord {
	return {
		$type: 'place.wisp.v2.wh',
		scope: { aturi: `at://${SCOPE}`, backlinks: true },
		url: 'https://receiver.example/hook',
		createdAt: '2025-01-01T00:00:00.000Z',
	}
}

function likeCommit(timeUs: number, references: readonly string[], operation: 'create' | 'update' = 'create') {
	return {
		did: VISITOR,
		time_us: timeUs,
		kind: 'commit' as const,
		commit: {
			rev: REV,
			operation,
			collection: 'app.bsky.feed.like',
			rkey: 'like',
			record: references.length > 0 ? { subject: { uri: references[0] } } : { text: 'unrelated' },
		},
	}
}

async function startBacklinkIntake(created: FakeJetstream[], probe: ReferenceProbe) {
	initScopeDids([{ did: OWNER, rkey: 'hook', record: backlinkRecord() }])
	await startFirehose({
		...testDependencies(created, probe),
		enqueueWebhookDeliveries: async (entries) => ({ enqueued: entries.length, deduplicated: 0 }),
		recordWebhookIntakeQuarantine: async () => undefined,
	})
	const backlink = created.find((client) => !client.options.wantedDids && !client.options.wantedCollections)
	expect(backlink).toBeDefined()
	return backlink as FakeJetstream
}

describe('backlink prior-reference index', () => {
	test('a relay record that references nothing in scope costs no durable read or write', async () => {
		const created: FakeJetstream[] = []
		const probe = referenceProbe()
		const backlink = await startBacklinkIntake(created, probe)
		await backlink.options.onEvent(likeCommit(10, []))
		expect(probe.loads).toEqual([])
		expect(probe.writes).toEqual([])
	})

	test('remembers a referencing record and forgets it once its references are gone', async () => {
		const created: FakeJetstream[] = []
		const probe = referenceProbe()
		const backlink = await startBacklinkIntake(created, probe)

		await backlink.options.onEvent(likeCommit(10, [SUBJECT]))
		expect(probe.loads).toEqual([])
		expect(probe.writes).toEqual([VISITOR_KEY])
		expect(probe.rows.get(VISITOR_KEY)).toEqual([SUBJECT])

		// The same key may now own durable state, so its next version is read.
		await backlink.options.onEvent(likeCommit(11, [], 'update'))
		expect(probe.loads).toEqual([VISITOR_KEY])
		expect(probe.rows.get(VISITOR_KEY)).toEqual([])

		// Cleared state is forgotten again: no further round trip for this key.
		await backlink.options.onEvent(likeCommit(12, [], 'update'))
		expect(probe.loads).toEqual([VISITOR_KEY])
		expect(probe.writes).toEqual([VISITOR_KEY, VISITOR_KEY])
	})

	test('reads durable state for every key when hydration is truncated', async () => {
		const created: FakeJetstream[] = []
		const probe = referenceProbe()
		probe.complete = false
		const backlink = await startBacklinkIntake(created, probe)
		await backlink.options.onEvent(likeCommit(10, []))
		expect(probe.loads).toEqual([VISITOR_KEY])
	})

	test('hydrates keys that already own references so their next event is matched', async () => {
		const created: FakeJetstream[] = []
		const probe = referenceProbe([[VISITOR_KEY, [SUBJECT]]])
		const backlink = await startBacklinkIntake(created, probe)
		await backlink.options.onEvent(likeCommit(10, [], 'update'))
		expect(probe.loads).toEqual([VISITOR_KEY])
		expect(probe.rows.get(VISITOR_KEY)).toEqual([])
	})
})
