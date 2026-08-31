import { describe, expect, test } from 'bun:test'
import {
	DurableReplayBackoff,
	DurableReplayController,
	destroyThenConnect,
	durableReplayBackoffCap,
	durableReplayFullJitter,
	OrderedCursorTracker,
	RelayCursorCoordinator,
	RelayFailureBudget,
	RelayGenerationGuard,
	retryDurableRevalidationUntilAvailable,
	runWithFirehoseResourceContext,
	SiteWorkScheduler,
} from './firehose'
import { createRevalidationResourceContext } from './revalidate-resources'

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve()
}

describe('normal firehose resource context', () => {
	test('closes the context after scheduled work, including a failed operation', async () => {
		const context = createRevalidationResourceContext(25, 8)
		let closeCalls = 0
		const resources = {
			...context,
			close: () => {
				closeCalls++
				context.close()
			},
		}

		await expect(
			runWithFirehoseResourceContext(
				() => resources,
				async (scheduledResources) => {
					scheduledResources.transferBudget.consume(3)
					throw new Error('scheduled operation failed')
				},
			),
		).rejects.toThrow('scheduled operation failed')
		expect(closeCalls).toBe(1)
		expect(context.transferBudget.consumedBytes).toBe(3)

		await new Promise((resolve) => setTimeout(resolve, 35))
		expect(context.signal.aborted).toBe(false)
	})
})

describe('durable replay backoff', () => {
	test('increases the exponential cap and stops growing at the bound', () => {
		const backoff = new DurableReplayBackoff({
			baseDelayMs: 10,
			maxDelayMs: 25,
			maxConsecutiveFailures: 6,
			random: () => 0.5,
		})

		expect([1, 2, 3, 4].map((attempt) => durableReplayBackoffCap(attempt, 10, 25))).toEqual([10, 20, 25, 25])
		expect([backoff.recordFailure(), backoff.recordFailure(), backoff.recordFailure()]).toMatchObject([
			{ consecutiveFailures: 1, delayCapMs: 10, delayMs: 5 },
			{ consecutiveFailures: 2, delayCapMs: 20, delayMs: 10 },
			{ consecutiveFailures: 3, delayCapMs: 25, delayMs: 13 },
		])
		expect(durableReplayFullJitter(25, () => 0)).toBe(0)
		expect(durableReplayFullJitter(25, () => 1)).toBe(25)
	})

	test('decays a stale failure burst after healthy time', () => {
		let now = 0
		const backoff = new DurableReplayBackoff({
			baseDelayMs: 10,
			failureDecayMs: 100,
			maxConsecutiveFailures: 3,
			now: () => now,
			random: () => 0,
		})

		expect(backoff.recordFailure().consecutiveFailures).toBe(1)
		now = 50
		expect(backoff.recordFailure().consecutiveFailures).toBe(2)
		now = 151
		// One healthy interval makes the next failure a fresh attempt rather
		// than inheriting a stale near-terminal budget.
		expect(backoff.consecutiveFailures).toBe(0)
		expect(backoff.recordFailure()).toMatchObject({ consecutiveFailures: 1, terminal: false })
	})

	test('permits a new replay probe after a terminal budget cools down', async () => {
		let now = 0
		const controller = new DurableReplayController({
			backoff: new DurableReplayBackoff({
				baseDelayMs: 1,
				failureDecayMs: 100,
				maxConsecutiveFailures: 2,
				now: () => now,
				random: () => 0,
			}),
		})
		let reconnects = 0
		const reconnect = async () => {
			reconnects++
		}
		let terminals = 0

		controller.request(reconnect, () => terminals++)
		await controller.pending
		controller.request(reconnect, () => terminals++)
		expect(terminals).toBe(1)
		expect(reconnects).toBe(1)

		now = 101
		const probe = controller.request(reconnect, () => terminals++)
		expect(probe).toMatchObject({ consecutiveFailures: 1, terminal: false })
		await controller.pending
		expect(reconnects).toBe(2)
		expect(terminals).toBe(1)
	})

	test('keeps a capacity failure pending until the revalidation consumer frees space', async () => {
		const outcomes = ['capacity', 'capacity', 'enqueued'] as const
		const delays: number[] = []
		let calls = 0
		const result = await retryDurableRevalidationUntilAvailable(async () => outcomes[calls++] ?? 'unavailable', {
			wait: async (delayMs) => {
				delays.push(delayMs)
			},
			baseDelayMs: 10,
			maxDelayMs: 20,
		})

		expect(result).toBe('enqueued')
		expect(calls).toBe(3)
		expect(delays).toEqual([10, 20])
	})

	test('does not advance the cursor while capacity blocks a durable handoff', async () => {
		const tracker = new OrderedCursorTracker(1)
		const reservation = await tracker.reserve(101)
		expect(reservation).toBeDefined()
		let releaseCapacityWait!: () => void
		let calls = 0
		const handoff = retryDurableRevalidationUntilAvailable(async () => (calls++ === 0 ? 'capacity' : 'enqueued'), {
			wait: async () => await new Promise<void>((resolve) => (releaseCapacityWait = resolve)),
		})
		await flushMicrotasks()

		expect(calls).toBe(1)
		expect(tracker.cursor).toBeUndefined()
		expect(tracker.pendingCount).toBe(1)
		releaseCapacityWait()
		expect(await handoff).toBe('enqueued')
		reservation?.complete()
		tracker.sealOpenSequence()
		expect(tracker.cursor).toBe(101)
	})

	test('cancels a capacity wait when intake stops without another enqueue', async () => {
		let accepting = true
		let calls = 0
		const result = await retryDurableRevalidationUntilAvailable(
			async () => {
				calls++
				return 'capacity'
			},
			{
				shouldContinue: () => accepting,
				wait: async () => {
					accepting = false
				},
			},
		)

		expect(result).toBe('unavailable')
		expect(calls).toBe(1)
	})

	test('aborts a capacity sleep promptly without completing its cursor reservation', async () => {
		const tracker = new OrderedCursorTracker(1)
		const reservation = await tracker.reserve(202)
		const controller = new AbortController()
		const waitStarted = deferred<void>()
		const wait = new Promise<void>(() => {})
		let calls = 0
		const retry = retryDurableRevalidationUntilAvailable(
			async () => {
				calls++
				return 'capacity'
			},
			{
				signal: controller.signal,
				wait: async () => {
					waitStarted.resolve()
					await wait
				},
			},
		)

		await waitStarted.promise
		controller.abort()
		expect(await retry).toBe('unavailable')
		expect(calls).toBe(1)
		expect(tracker.cursor).toBeUndefined()
		expect(tracker.pendingCount).toBe(1)
		// The event owner, not the retry loop, is responsible for deciding whether
		// a stopped reservation should be replayed.
		reservation?.fail()
	})

	test('allows only one replay reconnect at a time', async () => {
		const gate = deferred()
		const controller = new DurableReplayController({
			backoff: new DurableReplayBackoff({ baseDelayMs: 1, random: () => 0 }),
		})
		let reconnects = 0
		const reconnect = async () => {
			reconnects++
			await gate.promise
		}
		const terminal = () => {
			throw new Error('unexpected terminal replay')
		}

		controller.request(reconnect, terminal)
		controller.request(reconnect, terminal)
		await flushMicrotasks()
		expect(reconnects).toBe(1)

		gate.resolve()
		await controller.pending
		await flushMicrotasks()
		expect(reconnects).toBe(1)
	})

	test('resets only when durable recovery succeeds', async () => {
		const controller = new DurableReplayController({
			backoff: new DurableReplayBackoff({ baseDelayMs: 1, random: () => 0 }),
		})
		const reconnect = async () => {}
		const terminal = () => {
			throw new Error('unexpected terminal replay')
		}

		controller.request(reconnect, terminal)
		await controller.pending
		expect(controller.consecutiveFailures).toBe(1)
		controller.recordDurableSuccess()
		expect(controller.consecutiveFailures).toBe(0)
		expect(controller.request(reconnect, terminal)?.consecutiveFailures).toBe(1)
		await controller.pending
	})

	test('calls the terminal callback after the bounded failure count', async () => {
		const controller = new DurableReplayController({
			backoff: new DurableReplayBackoff({ baseDelayMs: 1, maxConsecutiveFailures: 2, random: () => 0 }),
		})
		let reconnects = 0
		let terminals = 0
		const reconnect = async () => {
			reconnects++
		}
		const terminal = () => {
			terminals++
		}

		controller.request(reconnect, terminal)
		await controller.pending
		controller.request(reconnect, terminal)
		controller.request(reconnect, terminal)
		expect(reconnects).toBe(1)
		expect(terminals).toBe(1)
	})

	test('cancels a delayed replay without reconnecting after shutdown', async () => {
		const timers: Array<() => void> = []
		let cleared = 0
		const controller = new DurableReplayController({
			backoff: new DurableReplayBackoff({ baseDelayMs: 50, random: () => 1 }),
			setTimeout: (callback) => {
				timers.push(callback)
				return timers.length as unknown as ReturnType<typeof setTimeout>
			},
			clearTimeout: () => {
				cleared++
			},
		})
		let reconnects = 0
		const pending = controller.request(
			async () => {
				reconnects++
			},
			() => {},
		)
		const replay = controller.pending
		controller.stop()
		await replay
		timers[0]?.()
		await flushMicrotasks()

		expect(pending?.delayMs).toBe(50)
		expect(reconnects).toBe(0)
		expect(cleared).toBe(1)
	})
})

describe('OrderedCursorTracker', () => {
	test('does not advance past an earlier slow sequence when later work finishes first', async () => {
		const tracker = new OrderedCursorTracker(10)
		const slow = await tracker.reserve(41)
		const fast = await tracker.reserve(42)

		expect(slow).toBeDefined()
		expect(fast).toBeDefined()
		fast?.complete()
		expect(tracker.cursor).toBeUndefined()

		slow?.complete()
		// 42 is the open sequence. Its completion is held until another relay
		// sequence arrives or source shutdown seals it.
		expect(tracker.cursor).toBe(41)
		tracker.sealOpenSequence()
		expect(tracker.cursor).toBe(42)
	})

	test('uses only the completed prefix as the crash/resume cursor', async () => {
		const tracker = new OrderedCursorTracker(10, 500)
		const completed = await tracker.reserve(501)
		const failed = await tracker.reserve(502)

		completed?.complete()
		failed?.fail()
		tracker.sealOpenSequence()

		expect(tracker.cursor).toBe(501)
		expect(tracker.resumableCursor).toBe(501)
		expect(tracker.pendingCount).toBe(1)

		// A reconnect discards the failed in-memory reservation and replays it
		// from the durable prefix instead of skipping sequence 502.
		const resumed = new OrderedCursorTracker(10, tracker.resumableCursor)
		const replayed = await resumed.reserve(502)
		replayed?.complete()
		resumed.sealOpenSequence()
		expect(resumed.cursor).toBe(502)
	})

	test('shares a cap-one slot across one commit and seals it before admitting the next sequence', async () => {
		const tracker = new OrderedCursorTracker(1)
		const firstOperation = await tracker.reserve(100)
		const secondOperation = await tracker.reserve(100)

		expect(tracker.pendingCount).toBe(1)
		firstOperation?.complete()
		secondOperation?.complete()

		// The incoming sequence seals completed sequence 100 before checking the
		// cap, so a cap of one cannot deadlock a multi-operation commit.
		const next = await tracker.reserve(101)
		expect(next?.seq).toBe(101)
		expect(tracker.cursor).toBe(100)
	})

	test('applies bounded backpressure until a sealed slow prefix frees capacity', async () => {
		const tracker = new OrderedCursorTracker(1)
		const first = await tracker.reserve(200)
		let secondResolved = false
		const secondPromise = tracker.reserve(201).then((reservation) => {
			secondResolved = true
			return reservation
		})

		await flushMicrotasks()
		expect(secondResolved).toBe(false)

		first?.complete()
		const second = await secondPromise
		expect(second?.seq).toBe(201)
		expect(tracker.cursor).toBe(200)
	})

	test('rejects malformed, duplicate, and rewound sequences without regressing the cursor', async () => {
		const tracker = new OrderedCursorTracker(2, 50)
		expect(await tracker.reserve(-1)).toBeUndefined()
		expect(await tracker.reserve(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined()
		expect(await tracker.reserve(50)).toBeUndefined()
		expect(await tracker.reserve(49)).toBeUndefined()

		const next = await tracker.reserve(51)
		next?.complete()
		tracker.sealOpenSequence()
		expect(tracker.cursor).toBe(51)
		expect(await tracker.reserve(50)).toBeUndefined()
		expect(tracker.cursor).toBe(51)
	})
})

describe('relay lifecycle guards', () => {
	test('does not reset the cross-relay budget for connect-error loops without an event', () => {
		const budget = new RelayFailureBudget()

		for (let relay = 0; relay < 2; relay++) {
			budget.recordConnected()
			for (let error = 0; error < 3; error++) budget.recordConnectionError()
			expect(budget.canFailOver()).toBe(true)
			budget.recordFailOver()
		}

		budget.recordConnected()
		for (let error = 0; error < 3; error++) budget.recordConnectionError()
		expect(budget.canFailOver()).toBe(false)

		budget.recordEvent()
		expect(budget.canFailOver()).toBe(true)
		expect(budget.consecutiveFailures).toBe(0)
	})

	test('serializes delayed failover/replay destruction before replacing a relay', async () => {
		const generations = new RelayGenerationGuard()
		const oldRelay = generations.beginConnection()
		const destroy = deferred()
		let replacement: number | undefined
		const transition = destroyThenConnect(
			async () => {
				generations.invalidate()
				await destroy.promise
			},
			() => true,
			() => {
				replacement = generations.beginConnection()
			},
		)

		expect(generations.isCurrent(oldRelay)).toBe(false)
		expect(replacement).toBeUndefined()
		destroy.resolve()
		await transition
		expect(replacement).toBeDefined()
		expect(generations.isCurrent(replacement ?? -1)).toBe(true)
		expect(generations.isCurrent(oldRelay)).toBe(false)
	})

	test('does not open a replacement when old relay destruction fails', async () => {
		let connections = 0
		await expect(
			destroyThenConnect(
				async () => {
					throw new Error('destroy failed')
				},
				() => true,
				() => {
					connections++
				},
			),
		).rejects.toThrow('destroy failed')
		expect(connections).toBe(0)
	})

	test('does not reconnect after a delayed shutdown destroy', async () => {
		const destroy = deferred()
		let connections = 0
		const shutdown = destroyThenConnect(
			async () => await destroy.promise,
			() => false,
			() => {
				connections++
			},
		)

		destroy.resolve()
		await shutdown
		expect(connections).toBe(0)
	})
})

describe('SiteWorkScheduler', () => {
	test('keeps each site ordered while allowing a different site to run concurrently and drain', async () => {
		const scheduler = new SiteWorkScheduler(2)
		const firstGate = deferred()
		const otherGate = deferred()
		const order: string[] = []

		const first = scheduler.schedule('did:example/a', async () => {
			order.push('a1:start')
			await firstGate.promise
			order.push('a1:end')
		})
		const second = scheduler.schedule('did:example/a', async () => {
			order.push('a2:start')
		})
		const other = scheduler.schedule('did:example/b', async () => {
			order.push('b1:start')
			await otherGate.promise
			order.push('b1:end')
		})

		await flushMicrotasks()
		expect(order).toEqual(['a1:start', 'b1:start'])
		expect(scheduler.activeHandlers).toBe(2)
		expect(scheduler.queuedHandlers).toBe(3)

		const draining = scheduler.drain(1_000)
		firstGate.resolve()
		await first
		await flushMicrotasks()
		expect(order).toEqual(['a1:start', 'b1:start', 'a1:end', 'a2:start'])

		otherGate.resolve()
		await Promise.all([second, other])
		await expect(draining).resolves.toMatchObject({
			outcome: 'drained',
			forced: false,
			remainingWork: 0,
			activeHandlers: 0,
		})
	})

	test('rejects failed work while preserving order for a later event on the same site', async () => {
		const scheduler = new SiteWorkScheduler(1)
		const order: string[] = []
		const failed = scheduler.schedule('did:example/a', async () => {
			order.push('first')
			throw new Error('transient write failure')
		})
		const later = scheduler.schedule('did:example/a', async () => {
			order.push('second')
		})

		await expect(failed).rejects.toThrow('transient write failure')
		await expect(later).resolves.toBeUndefined()
		expect(order).toEqual(['first', 'second'])
	})

	test('reports an explicit forced outcome without waiting for an uncooperative handler', async () => {
		const scheduler = new SiteWorkScheduler(1)
		const gate = deferred()
		const work = scheduler.schedule('did:example/a', async () => {
			await gate.promise
		})

		await flushMicrotasks()
		await expect(scheduler.drain(0)).resolves.toMatchObject({
			outcome: 'forced',
			forced: true,
			remainingWork: 1,
			activeHandlers: 1,
		})

		gate.resolve()
		await work
		await expect(scheduler.drain(0)).resolves.toMatchObject({
			outcome: 'drained',
			forced: false,
		})
	})
})

describe('relay-scoped durable cursors', () => {
	test('persists A before B, loads B, and reloads A on return', async () => {
		const durable = new Map<string, number>([
			['relay-a', 41],
			['relay-b', 87],
		])
		const saves: Array<[string, number]> = []
		const store = {
			read: async (service: string) => {
				const cursor = durable.get(service)
				return cursor === undefined ? { kind: 'missing' as const } : { kind: 'found' as const, cursor }
			},
			save: async (service: string, cursor: number) => {
				saves.push([service, cursor])
				durable.set(service, cursor)
				return true
			},
		}
		const cursors = new RelayCursorCoordinator((service) => service)
		expect(cursors.initialize('relay-a', 50)).toBe(50)

		const switchedToB = await cursors.switchTo('relay-b', 52, store)
		expect(switchedToB).toEqual({ cursor: 87, missingCheckpoint: false })
		expect(saves).toEqual([['relay-a', 52]])

		cursors.recordActiveCursor(91)
		const switchedBackToA = await cursors.switchTo('relay-a', 91, store)
		expect(switchedBackToA).toEqual({ cursor: 52, missingCheckpoint: false })
		expect(saves).toEqual([
			['relay-a', 52],
			['relay-b', 91],
		])
		expect(cursors.knownCursor('relay-a')).toBe(52)
		expect(cursors.knownCursor('relay-b')).toBe(91)
	})

	test('starts live when durable storage confirms a target cursor is missing', async () => {
		const cursors = new RelayCursorCoordinator((service) => service)
		const saves: Array<[string, number]> = []
		expect(cursors.initialize('relay-a', undefined)).toBeUndefined()
		const activation = await cursors.switchTo('relay-b', undefined, {
			read: async () => ({ kind: 'missing' }),
			save: async (service, cursor) => {
				saves.push([service, cursor])
				return true
			},
		})
		expect(saves).toEqual([])
		expect(activation).toEqual({ cursor: undefined, missingCheckpoint: true })
	})

	test('refuses a target transition when durable state is unavailable', async () => {
		const cursors = new RelayCursorCoordinator((service) => service)
		cursors.initialize('relay-a', 10)
		const activation = await cursors.switchTo('relay-b', 11, {
			read: async () => ({ kind: 'unavailable' }),
			save: async () => true,
		})
		expect(activation).toBeUndefined()
	})
})
