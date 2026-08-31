import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import type { CursorRepository, PriorReferenceRepository } from './firehose'
import type { JetstreamClient, JetstreamEvent, JetstreamOptions } from './jetstream'

// Firehose imports its database namespace at module load. Keep unit tests fully
// in-memory; the real DB behavior is covered by db/backfill tests.
mock.module('./db', () => ({
	MAX_BACKLINK_REFERENCES_PER_EVENT: 100,
	loadCursor: async () => undefined,
	saveCursor: async () => undefined,
	loadCursorForStream: async () => undefined,
	saveCursorForStream: async () => undefined,
	loadPriorReferenceIndex: async () => undefined,
	savePriorReferenceIndex: async () => undefined,
	deletePriorReferenceIndex: async () => undefined,
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

function testDependencies(created: FakeJetstream[]) {
	const cursor: CursorRepository = { load: async () => undefined, save: async () => undefined }
	const references: PriorReferenceRepository = {
		load: async () => undefined,
		save: async () => undefined,
		delete: async () => undefined,
	}
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
