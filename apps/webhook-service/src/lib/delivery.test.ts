import { describe, expect, mock, test } from 'bun:test'
import type {
	ClaimedWebhookDelivery,
	NewWebhookDeliveryEventRow,
	NewWebhookDeliveryOutboxRow,
	WebhookEntry,
} from './db'
import type { WebhookDeliveryWorkerPersistence } from './delivery'
import type { WebhookTransport } from './webhook-url'

interface CapturedRow {
	deliveryId: string
	eventId: string
	payloadJson?: string
	subscriptionSnapshotJson?: string
}

interface CapturedEvent {
	eventId: string
	payloadJson: string
}

let captured: Array<{ event: CapturedEvent; rows: readonly CapturedRow[]; ensureEvent: boolean }> = []
let failCall = 0
let calls = 0
const persistedDeliveryIds = new Set<string>()
const persistedEventIds = new Set<string>()

mock.module('@wispplace/observability', () => ({
	createLogger: () => ({
		debug: () => undefined,
		error: () => undefined,
		info: () => undefined,
		warn: () => undefined,
	}),
}))

mock.module('./db', () => ({}))

mock.module('./redis', () => ({ publishWebhookEvent: async () => ({ published: false, dropped: false }) }))

const captureEnqueue = async (
	event: NewWebhookDeliveryEventRow,
	rows: readonly NewWebhookDeliveryOutboxRow[],
	ensureEvent = true,
) => {
	calls++
	captured.push({ event, rows, ensureEvent })
	if (calls === failCall) throw new Error('temporary database failure')
	if (ensureEvent) persistedEventIds.add(event.eventId)
	let enqueued = 0
	for (const row of rows) {
		if (!persistedDeliveryIds.has(row.deliveryId)) {
			persistedDeliveryIds.add(row.deliveryId)
			enqueued++
		}
	}
	return { enqueued, deduplicated: rows.length - enqueued }
}

const enqueueOptions = {
	enqueueOutbox: captureEnqueue,
	subscriptionFingerprint: () => 'fingerprint',
}

const { enqueueWebhookDeliveries, WebhookDeliveryWorker } = await import('./delivery')

const reset = () => {
	captured = []
	failCall = 0
	calls = 0
	persistedDeliveryIds.clear()
	persistedEventIds.clear()
}

const entries = (count: number): WebhookEntry[] =>
	Array.from({ length: count }, (_, index) => ({
		ownerDid: `did:plc:owner${index}`,
		rkey: `hook-${index}`,
		record: {
			$type: 'place.wisp.v2.wh' as const,
			scope: { aturi: 'at://did:plc:subject' },
			url: 'https://receiver.example/hook',
			createdAt: '2025-01-01T00:00:00.000Z',
		},
	}))

const event = (record: unknown = { text: 'hello' }) => ({
	relay: 'wss://jetstream.example/subscribe',
	timeUs: 1_700_000_000_000_000,
	rev: '3lq6x5f2abcde',
	operation: 'create' as const,
	did: 'did:plc:subject',
	collection: 'app.bsky.feed.post',
	rkey: 'post',
	record,
})

describe('durable normalized webhook fanout', () => {
	test('uses bounded 1000-row chunks with one shared immutable event body', async () => {
		reset()
		const result = await enqueueWebhookDeliveries(entries(1_001), event(), enqueueOptions)

		expect(result).toEqual({ enqueued: 1_001, deduplicated: 0 })
		expect(captured.map((chunk) => chunk.rows.length)).toEqual([1_000, 1])
		expect(captured.map((chunk) => chunk.ensureEvent)).toEqual([true, false])
		expect(new Set(captured.map((chunk) => chunk.event.eventId)).size).toBe(1)
		expect(new Set(captured.map((chunk) => chunk.event.payloadJson)).size).toBe(1)
		for (const chunk of captured) {
			for (const row of chunk.rows) {
				expect(row.eventId).toBe(chunk.event.eventId)
				expect('payloadJson' in row).toBe(false)
				expect('subscriptionSnapshotJson' in row).toBe(false)
			}
		}
	})

	test('does not multiply a near-limit body across 10,000 outbox rows', async () => {
		reset()
		await enqueueWebhookDeliveries(entries(10_000), event({ text: 'x'.repeat(500 * 1024) }), enqueueOptions)

		expect(captured).toHaveLength(10)
		expect(captured.every((chunk) => chunk.rows.length <= 1_000)).toBe(true)
		expect(new Set(captured.map((chunk) => chunk.event.eventId)).size).toBe(1)
		expect(new Set(captured.map((chunk) => chunk.event.payloadJson)).size).toBe(1)
		expect(
			captured
				.flatMap((chunk) => chunk.rows)
				.every((row) => !('payloadJson' in row) && !('subscriptionSnapshotJson' in row)),
		).toBe(true)
	})

	test('replays a partially committed large fanout with stable IDs', async () => {
		reset()
		failCall = 2
		await expect(enqueueWebhookDeliveries(entries(1_001), event(), enqueueOptions)).rejects.toThrow(
			'temporary database failure',
		)
		expect(persistedDeliveryIds).toHaveLength(1_000)

		failCall = 0
		const replay = await enqueueWebhookDeliveries(entries(1_001), event(), enqueueOptions)
		expect(replay).toEqual({ enqueued: 1, deduplicated: 1_000 })
		expect(persistedDeliveryIds).toHaveLength(1_001)
		expect(persistedEventIds).toHaveLength(1)
	})

	function deferred<T>() {
		let resolve: (value: T | PromiseLike<T>) => void = () => undefined
		let reject: (reason?: unknown) => void = () => undefined
		const promise = new Promise<T>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise
			reject = rejectPromise
		})
		return { promise, resolve, reject }
	}

	const claimedRow = (): ClaimedWebhookDelivery => ({
		deliveryId: 'whd_v1_delivery',
		ownerDid: 'did:plc:owner',
		webhookRkey: 'hook',
		targetUrl: 'https://receiver.example/hook',
		signingMode: 'none',
		subscriptionFingerprint: 'fingerprint',
		payloadBody:
			'{"id":"event","event":"create","did":"did:plc:subject","collection":"app.bsky.feed.post","rkey":"post","timestamp":"2025-01-01T00:00:00.000Z"}',
		attemptCount: 0,
		leaseToken: 'lease',
		sourceOperation: 'create',
		sourceTimeUs: 1,
	})

	function workerPersistence(
		claimWebhookDeliveryOutbox: WebhookDeliveryWorkerPersistence['claimWebhookDeliveryOutbox'],
		overrides: Partial<WebhookDeliveryWorkerPersistence> = {},
	): WebhookDeliveryWorkerPersistence {
		return {
			cancelWebhookDeliveryForSubscriptionChange: async () => true,
			claimWebhookDeliveryOutbox,
			getCurrentWebhookSubscription: async () => ({
				url: 'https://receiver.example/hook',
				fingerprint: 'fingerprint',
				signingMode: 'none',
			}),
			getWebhookInlineSecret: async () => null,
			getWebhookSecretToken: async () => null,
			markWebhookDeliverySucceeded: async () => true,
			renewWebhookDeliveryLease: async () => true,
			rescheduleWebhookDelivery: async () => true,
			runWebhookMaintenance: async () => ({
				ran: true,
				outbox: 0,
				eventLogs: 0,
				tombstones: 0,
				backlinkReferences: 0,
				intakeQuarantines: 0,
				deliveryEvents: 0,
			}),
			...overrides,
		}
	}

	test('aborts a hung pinned attempt before shutdown returns and leaves its lease for reclaim', async () => {
		const transportStarted = deferred<void>()
		let aborted = false
		let posts = 0
		let updates = 0
		const hungTransport: WebhookTransport = ({ signal }) => {
			posts++
			transportStarted.resolve()
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => {
						aborted = true
						reject(signal.reason)
					},
					{ once: true },
				)
			})
		}
		const persistence = workerPersistence(async () => [claimedRow()], {
			markWebhookDeliverySucceeded: async () => {
				updates++
				return true
			},
			rescheduleWebhookDelivery: async () => {
				updates++
				return true
			},
		})
		const worker = new WebhookDeliveryWorker({
			concurrency: 1,
			batchSize: 1,
			requestTimeoutMs: 100,
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			transport: hungTransport,
			persistence,
		})
		const pass = worker.runOnce()
		await transportStarted.promise
		expect(await worker.stop(100)).toBe(true)
		await pass
		expect(aborted).toBe(true)
		expect(posts).toBe(1)
		expect(updates).toBe(0)
		expect(await worker.runOnce()).toBe(0)

		// A separate worker can reclaim the unchanged durable row and complete it.
		let reclaimed = 0
		const reclaimer = new WebhookDeliveryWorker({
			concurrency: 1,
			batchSize: 1,
			requestTimeoutMs: 100,
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			transport: async () => new Response(null, { status: 204 }),
			persistence: workerPersistence(async () => [claimedRow()], {
				markWebhookDeliverySucceeded: async () => {
					reclaimed++
					return true
				},
			}),
		})
		await reclaimer.runOnce()
		expect(reclaimed).toBe(1)
	})

	test('aborts at deadline, clears heartbeat timers, and waits for an in-flight refresh before DB teardown', async () => {
		const transportStarted = deferred<void>()
		const refreshStarted = deferred<void>()
		const finishRefresh = deferred<boolean>()
		let aborted = false
		let renewals = 0
		let updates = 0
		const persistence = workerPersistence(async () => [claimedRow()], {
			renewWebhookDeliveryLease: async () => {
				renewals++
				if (renewals === 1) return true
				refreshStarted.resolve()
				return finishRefresh.promise
			},
			markWebhookDeliverySucceeded: async () => {
				updates++
				return true
			},
			rescheduleWebhookDelivery: async () => {
				updates++
				return true
			},
		})
		const worker = new WebhookDeliveryWorker({
			concurrency: 1,
			batchSize: 1,
			requestTimeoutMs: 3_000,
			leaseMs: 8_000,
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			transport: ({ signal }) => {
				transportStarted.resolve()
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => {
							aborted = true
							reject(signal.reason)
						},
						{ once: true },
					)
				})
			},
			persistence,
		})
		const pass = worker.runOnce()
		await transportStarted.promise
		// leaseMs is bounded to 8s, so its heartbeat starts before the 3s request deadline.
		await refreshStarted.promise
		expect(await worker.stop(100)).toBe(false)
		expect(aborted).toBe(true)
		expect(updates).toBe(0)
		finishRefresh.resolve(true)
		await pass
		await new Promise((resolve) => setTimeout(resolve, 25))
		expect(renewals).toBe(2)
		expect(updates).toBe(0)
	}, 8_000)
})
