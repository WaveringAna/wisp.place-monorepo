import { describe, expect, mock, test } from 'bun:test'
import { MAX_IDENTITY_JSON_BYTES } from '@wispplace/atproto-utils'

let knownDids: string[] = []
const began: Array<{ ownerDid: string; generation: number }> = []
const appliedPages: Array<{ ownerDid: string; records: ReadonlyArray<{ rkey: string }> }> = []
const completed: Array<{ ownerDid: string; generation: number }> = []
const failed: Array<{ ownerDid: string; generation: number }> = []
const transitions: Array<{ did: string; status: string }> = []
let beginFailure = false

mock.module('@wispplace/observability', () => ({
	createLogger: () => ({
		debug: () => undefined,
		error: () => undefined,
		info: () => undefined,
		warn: () => undefined,
	}),
}))

mock.module('./db', () => ({
	listKnownWebhookOwnerDidsPage: async (after?: string, limit = 100) =>
		knownDids.filter((did) => after === undefined || did > after).slice(0, limit),
	listFailedWebhookReconciliationOwners: async () => [],
	beginOwnerReconciliation: async (ownerDid: string) => {
		if (beginFailure) throw new Error('database credentials must remain private')
		const token = { ownerDid, generation: began.length + 1 }
		began.push(token)
		return token
	},
	applyWebhookSnapshotPage: async (token: { ownerDid: string }, records: ReadonlyArray<{ rkey: string }>) => {
		appliedPages.push({ ownerDid: token.ownerDid, records })
		return { applied: true, upserted: records.length }
	},
	completeOwnerReconciliation: async (token: { ownerDid: string; generation: number }) => {
		completed.push(token)
		return { applied: true, deleted: 0, complete: true }
	},
	failOwnerReconciliation: async (token: { ownerDid: string; generation: number }) => {
		failed.push(token)
	},
}))

const { createReconciliationRetryScheduler, fetchWhRecordPages, fetchWhRecordsForDid, runStartupBackfill } =
	await import('./backfill')

const DID = 'did:web:example.com'
const OTHER_DID = 'did:web:other.example'
const validRecord = {
	$type: 'place.wisp.v2.wh',
	createdAt: '2025-01-01T00:00:00.000Z',
	enabled: true,
	scope: { aturi: 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' },
	url: 'https://receiver.example/hook',
}

const reset = () => {
	knownDids = []
	began.length = 0
	appliedPages.length = 0
	completed.length = 0
	failed.length = 0
	transitions.length = 0
	beginFailure = false
}
const recordUri = (did: string, rkey: string): string => `at://${did}/place.wisp.v2.wh/${rkey}`
const didDocument = (endpoint: string): Response =>
	new Response(JSON.stringify({ service: [{ id: '#atproto_pds', serviceEndpoint: endpoint }] }))

const pdsFetcher =
	(listResponse: Response) =>
	async (url: string): Promise<Response> =>
		url === 'https://example.com/.well-known/did.json' ? didDocument('https://pds.example') : listResponse

describe('webhook startup backfill PDS transport and snapshot validation', () => {
	test('rejects a private PDS endpoint before any PDS list request', async () => {
		reset()
		const requests: string[] = []
		await expect(
			fetchWhRecordsForDid(DID, async (url) => {
				requests.push(url)
				return didDocument('https://169.254.169.254')
			}),
		).rejects.toThrow('no valid PDS endpoint')
		expect(requests).toEqual(['https://example.com/.well-known/did.json'])
	})

	test('uses the injected pinned GET path for every complete PDS page and encodes cursors', async () => {
		reset()
		const requests: string[] = []
		const records = await fetchWhRecordsForDid(DID, async (url) => {
			requests.push(url)
			if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
			const parsed = new URL(url)
			if (parsed.searchParams.get('cursor') === 'next cursor') {
				return new Response(JSON.stringify({ records: [{ uri: recordUri(DID, 'two'), cid: 'b', value: validRecord }] }))
			}
			return new Response(
				JSON.stringify({
					records: [{ uri: recordUri(DID, 'one'), cid: 'a', value: validRecord }],
					cursor: 'next cursor',
				}),
			)
		})

		expect(records.map((record) => record.rkey)).toEqual(['one', 'two'])
		expect(requests).toHaveLength(3)
		expect(requests[1]).toContain('https://pds.example/xrpc/com.atproto.repo.listRecords?')
		expect(requests[2]).toContain('cursor=next+cursor')
	})

	test('rejects non-canonical URIs, malformed cursors, duplicate page keys, and non-success pages', async () => {
		reset()
		const invalidResponses = [
			{ records: [{ uri: `at://${OTHER_DID}/place.wisp.v2.wh/one`, cid: 'a', value: validRecord }] },
			{ records: [], cursor: 7 },
		]
		for (const body of invalidResponses) {
			await expect(fetchWhRecordsForDid(DID, pdsFetcher(new Response(JSON.stringify(body))))).rejects.toThrow(
				'Webhook backfill',
			)
		}
		await expect(fetchWhRecordsForDid(DID, pdsFetcher(new Response(null, { status: 404 })))).rejects.toThrow(
			'Webhook backfill PDS request failed',
		)
		await expect(
			fetchWhRecordPages(
				DID,
				() => undefined,
				async (url) => {
					if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
					const cursor = new URL(url).searchParams.get('cursor')
					return new Response(
						JSON.stringify(
							cursor
								? { records: [{ uri: recordUri(DID, 'one'), cid: 'b', value: validRecord }] }
								: { records: [{ uri: recordUri(DID, 'one'), cid: 'a', value: validRecord }], cursor: 'next' },
						),
					)
				},
			),
		).rejects.toThrow('Webhook backfill')
	})

	test('omits malformed records while applying valid rows and completing the owner snapshot', async () => {
		reset()
		knownDids = [DID]
		const result = await runStartupBackfill(async (url) => {
			if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
			return new Response(
				JSON.stringify({
					records: [
						{ uri: recordUri(DID, 'valid'), cid: 'a', value: validRecord },
						{ uri: recordUri(DID, 'malformed'), cid: 'b', value: { $type: 'place.wisp.v2.wh', enabled: 'yes' } },
					],
				}),
			)
		})
		expect(result).toEqual({ found: 1, failed: 0 })
		expect(appliedPages.map((page) => page.records.map((record) => record.rkey))).toEqual([['valid']])
		expect(completed).toEqual([{ ownerDid: DID, generation: 1 }])
	})

	test('treats an explicit repo-absence response as an authoritative empty snapshot', async () => {
		reset()
		knownDids = [DID]
		const result = await runStartupBackfill({
			fetcher: async (url) => {
				if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
				return new Response(JSON.stringify({ error: 'RepoNotFound', message: 'Repo not found' }), { status: 400 })
			},
			onOwnerTransition: (did, status) => {
				transitions.push({ did, status })
			},
		})

		expect(result).toEqual({ found: 0, failed: 0 })
		expect(appliedPages).toEqual([])
		expect(completed).toEqual([{ ownerDid: DID, generation: 1 }])
		expect(failed).toEqual([])
		expect(transitions).toEqual([
			{ did: DID, status: 'scanning' },
			{ did: DID, status: 'complete' },
		])
	})

	test('treats the PDS InvalidRequest repo-absence form as an authoritative empty snapshot', async () => {
		reset()
		knownDids = [DID]
		const result = await runStartupBackfill({
			fetcher: async (url) => {
				if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
				return new Response(JSON.stringify({ error: 'InvalidRequest', message: `Could not find repo: ${DID}` }), {
					status: 400,
				})
			},
		})

		expect(result).toEqual({ found: 0, failed: 0 })
		expect(completed).toEqual([{ ownerDid: DID, generation: 1 }])
		expect(failed).toEqual([])
	})

	test('does not prune a partial snapshot when repo absence arrives after a page', async () => {
		reset()
		knownDids = [DID]
		const result = await runStartupBackfill({
			fetcher: async (url) => {
				if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
				if (!new URL(url).searchParams.has('cursor')) {
					return new Response(
						JSON.stringify({
							records: [{ uri: recordUri(DID, 'one'), cid: 'a', value: validRecord }],
							cursor: 'next',
						}),
					)
				}
				return new Response(JSON.stringify({ error: 'RepoNotFound', message: 'Repo not found' }), { status: 400 })
			},
		})

		expect(result).toEqual({ found: 0, failed: 1 })
		expect(appliedPages.map((page) => page.records.map((record) => record.rkey))).toEqual([['one']])
		expect(completed).toEqual([])
		expect(failed).toEqual([{ ownerDid: DID, generation: 1 }])
	})

	test('does not treat an empty cursor page followed by repo absence as complete', async () => {
		reset()
		knownDids = [DID]
		const result = await runStartupBackfill({
			fetcher: async (url) => {
				if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
				if (!new URL(url).searchParams.has('cursor')) {
					return new Response(JSON.stringify({ records: [], cursor: 'next' }))
				}
				return new Response(JSON.stringify({ error: 'RepoNotFound', message: 'Repo not found' }), { status: 400 })
			},
		})

		expect(result).toEqual({ found: 0, failed: 1 })
		expect(appliedPages).toEqual([{ ownerDid: DID, records: [] }])
		expect(completed).toEqual([])
		expect(failed).toEqual([{ ownerDid: DID, generation: 1 }])
	})

	test('keeps unknown client errors and gateway failures retryable', async () => {
		for (const response of [
			new Response(JSON.stringify({ error: 'InvalidRequest', message: 'bad request' }), { status: 400 }),
			new Response(JSON.stringify({ error: 'BadGateway' }), { status: 502 }),
		]) {
			reset()
			knownDids = [DID]
			const result = await runStartupBackfill({
				fetcher: async (url) =>
					url === 'https://example.com/.well-known/did.json' ? didDocument('https://pds.example') : response,
			})
			expect(result).toEqual({ found: 0, failed: 1 })
			expect(failed).toEqual([{ ownerDid: DID, generation: 1 }])
			expect(completed).toEqual([])
		}
	})

	test('omits unsafe endpoint rows while completing the authoritative owner snapshot', async () => {
		reset()
		const unsafeUrls = [
			'https://127.0.0.1/internal',
			'https://user:password@receiver.example/hook',
			'https://receiver.example/hook#fragment',
			'http://receiver.example/hook',
		]
		for (const url of unsafeUrls) {
			const records = await fetchWhRecordsForDid(
				DID,
				pdsFetcher(
					new Response(
						JSON.stringify({ records: [{ uri: recordUri(DID, 'unsafe'), cid: 'a', value: { ...validRecord, url } }] }),
					),
				),
			)
			expect(records).toEqual([])
		}

		knownDids = [DID]
		const result = await runStartupBackfill(async (url) => {
			if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
			return new Response(
				JSON.stringify({
					records: [
						{ uri: recordUri(DID, 'unsafe'), cid: 'a', value: { ...validRecord, url: 'https://127.0.0.1/internal' } },
					],
				}),
			)
		})
		expect(result).toEqual({ found: 0, failed: 0 })
		expect(appliedPages).toEqual([{ ownerDid: DID, records: [] }])
		expect(completed).toEqual([{ ownerDid: DID, generation: 1 }])
	})

	test('contains an oversized PDS response and marks only that owner degraded', async () => {
		reset()
		knownDids = [DID]
		let calls = 0
		const result = await runStartupBackfill(
			async (url) => {
				calls++
				if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
				return new Response('x'.repeat(MAX_IDENTITY_JSON_BYTES + 1))
			},
			(did, status) => {
				transitions.push({ did, status })
			},
		)

		expect(result).toEqual({ found: 0, failed: 1 })
		expect(calls).toBe(2)
		expect(appliedPages).toEqual([])
		expect(completed).toEqual([])
		expect(failed).toEqual([{ ownerDid: DID, generation: 1 }])
		expect(transitions).toEqual([
			{ did: DID, status: 'scanning' },
			{ did: DID, status: 'failed' },
		])
	})

	test('continues reconciling healthy owners after another owner fails', async () => {
		reset()
		knownDids = [DID, OTHER_DID]
		const result = await runStartupBackfill({
			fetcher: async (url) => {
				if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
				if (url === 'https://other.example/.well-known/did.json') return didDocument('https://pds.example')
				const repo = new URL(url).searchParams.get('repo')
				if (repo === OTHER_DID) return new Response(null, { status: 503 })
				return new Response(JSON.stringify({ records: [{ uri: recordUri(DID, 'one'), cid: 'a', value: validRecord }] }))
			},
			onOwnerTransition: (did, status) => {
				transitions.push({ did, status })
			},
		})

		expect(result).toEqual({ found: 1, failed: 1 })
		expect(appliedPages.map((page) => page.ownerDid)).toEqual([DID])
		expect(completed).toEqual([{ ownerDid: DID, generation: 1 }])
		expect(failed).toEqual([{ ownerDid: OTHER_DID, generation: 2 }])
		expect(transitions).toEqual([
			{ did: DID, status: 'scanning' },
			{ did: DID, status: 'complete' },
			{ did: OTHER_DID, status: 'scanning' },
			{ did: OTHER_DID, status: 'failed' },
		])
	})

	test('uses keyset pages, a fixed queue, and a continuation cursor instead of materializing all owners', async () => {
		reset()
		const thirdDid = 'did:web:third.example'
		const owners = [DID, OTHER_DID, thirdDid]
		const requests: Array<{ after: string | undefined; limit: number }> = []
		const listOwnerPage = async (after: string | undefined, limit: number) => {
			requests.push({ after, limit })
			return owners.filter((did) => after === undefined || did > after).slice(0, limit)
		}
		const fetcher = async (url: string) => {
			if (url.includes('/.well-known/did.json')) return didDocument('https://pds.example')
			return new Response(JSON.stringify({ records: [] }))
		}

		const first = await runStartupBackfill({
			fetcher,
			listOwnerPage,
			maxOwnersPerPass: 2,
			ownerPageSize: 1,
		})
		expect(first).toEqual({ found: 0, failed: 0, nextOwnerCursor: OTHER_DID })
		expect(requests).toEqual([
			{ after: undefined, limit: 1 },
			{ after: DID, limit: 1 },
		])
		// The source never receives a larger request than the fixed queue page.
		expect(requests.every((request) => request.limit === 1)).toBe(true)

		const continuation = await runStartupBackfill({
			fetcher,
			listOwnerPage,
			maxOwnersPerPass: 2,
			ownerPageSize: 1,
			startAfter: first.nextOwnerCursor,
		})
		expect(continuation).toEqual({ found: 0, failed: 0 })
		expect(began.map((token) => token.ownerDid)).toEqual([DID, OTHER_DID, thirdDid])
	})

	test('continues a >1000-owner bounded pass without materializing the owner set', async () => {
		reset()
		const owners = Array.from({ length: 1_001 }, (_, index) => `did:web:owner${String(index).padStart(4, '0')}.example`)
		const requestedLimits: number[] = []
		const listOwnerPage = async (after: string | undefined, limit: number) => {
			requestedLimits.push(limit)
			return owners.filter((did) => after === undefined || did > after).slice(0, limit)
		}
		const fetcher = async (url: string) =>
			url.includes('/.well-known/did.json')
				? didDocument('https://pds.example')
				: new Response(JSON.stringify({ records: [] }))

		const first = await runStartupBackfill({ fetcher, listOwnerPage })
		expect(first).toEqual({ found: 0, failed: 0, nextOwnerCursor: owners[999] })
		expect(Math.max(...requestedLimits)).toBe(50)
		expect(began).toHaveLength(1_000)

		const resumed = await runStartupBackfill({ fetcher, listOwnerPage, startAfter: first.nextOwnerCursor })
		expect(resumed).toEqual({ found: 0, failed: 0 })
		expect(began).toHaveLength(1_001)
		expect(began[began.length - 1]?.ownerDid).toBe(owners[1_000])
	})

	test('treats reconciliation infrastructure failures as fatal rather than degrading every owner', async () => {
		reset()
		knownDids = [DID]
		beginFailure = true
		await expect(runStartupBackfill(async () => new Response('{}'))).rejects.toThrow(
			'Webhook reconciliation infrastructure failed',
		)
		expect(failed).toEqual([])
	})
})

interface FakeTimer {
	callback: () => void
	delayMs: number
	cleared: boolean
	fired: boolean
}

function createFakeTimers(): {
	timers: FakeTimer[]
	clearTimer: (timer: ReturnType<typeof setTimeout>) => void
	setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
	fire: (delayMs: number) => void
} {
	const timers: FakeTimer[] = []
	return {
		timers,
		setTimer: (callback, delayMs) => {
			const timer = { callback, delayMs, cleared: false, fired: false }
			timers.push(timer)
			return timer as unknown as ReturnType<typeof setTimeout>
		},
		clearTimer: (timer) => {
			;(timer as unknown as FakeTimer).cleared = true
		},
		fire: (delayMs) => {
			const timer = timers.find((entry) => entry.delayMs === delayMs && !entry.cleared && !entry.fired)
			if (!timer) throw new Error(`No pending ${delayMs}ms timer`)
			timer.fired = true
			timer.callback()
		},
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: ((value: T) => void) | undefined
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve: (value) => resolve?.(value) }
}

describe('failed owner reconciliation retry scheduler', () => {
	test('recovers a transiently failed owner through the injected transition callback', async () => {
		reset()
		const timers = createFakeTimers()
		const retryTransitions: Array<{ did: string; status: string }> = []
		const completedRetry = deferred<void>()
		const scheduler = createReconciliationRetryScheduler({
			baseDelayMs: 1_000,
			clearTimer: timers.clearTimer,
			discoveryIntervalMs: 10_000,
			listFailedOwners: async () => [DID],
			onOwnerTransition: (did, status) => {
				retryTransitions.push({ did, status })
				if (status === 'complete') completedRetry.resolve()
			},
			random: () => 0.5,
			setTimer: timers.setTimer,
			fetcher: async (url) => {
				if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
				return new Response(
					JSON.stringify({ records: [{ uri: recordUri(DID, 'retry'), cid: 'a', value: validRecord }] }),
				)
			},
		})

		await scheduler.start()
		expect(scheduler.health.scheduled).toBe(1)
		timers.fire(500)
		await completedRetry.promise
		expect(appliedPages.map((page) => page.records.map((record) => record.rkey))).toEqual([['retry']])
		expect(retryTransitions).toEqual([
			{ did: DID, status: 'scanning' },
			{ did: DID, status: 'complete' },
		])
		expect(scheduler.health.infrastructureHealthy).toBe(true)
		await scheduler.stop()
	})

	test('uses capped exponential full-jitter retries and limits tracked failed owners', async () => {
		reset()
		const timers = createFakeTimers()
		const failedRetry = deferred<void>()
		const retryTimerCreated = deferred<void>()
		const scheduler = createReconciliationRetryScheduler({
			baseDelayMs: 1_000,
			clearTimer: timers.clearTimer,
			discoveryIntervalMs: 10_000,
			listFailedOwners: async () => [DID, OTHER_DID],
			maxOwners: 1,
			onOwnerTransition: (_did, status) => {
				if (status === 'failed') failedRetry.resolve()
			},
			random: () => 0.5,
			setTimer: (callback, delayMs) => {
				if (delayMs === 1_000) retryTimerCreated.resolve()
				return timers.setTimer(callback, delayMs)
			},
			fetcher: async (url) => {
				if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
				return new Response(null, { status: 503 })
			},
		})

		await scheduler.start()
		expect(scheduler.health.scheduled).toBe(1)
		timers.fire(500)
		await failedRetry.promise
		await retryTimerCreated.promise
		expect(scheduler.health.scheduled).toBe(1)
		expect(timers.timers.some((timer) => timer.delayMs === 1_000 && !timer.fired && !timer.cleared)).toBe(true)
		await scheduler.stop()
	})

	test('cancels pending timers and drains an in-flight owner scan on stop', async () => {
		reset()
		const timers = createFakeTimers()
		let resolvePage: ((response: Response) => void) | undefined
		let requestSignal: AbortSignal | undefined
		const pageRequested = deferred<void>()
		const ownerFinished = deferred<void>()
		const scheduler = createReconciliationRetryScheduler({
			baseDelayMs: 1_000,
			clearTimer: timers.clearTimer,
			discoveryIntervalMs: 10_000,
			listFailedOwners: async () => [DID],
			onOwnerTransition: (_did, status) => {
				if (status === 'failed') ownerFinished.resolve()
			},
			random: () => 0.5,
			setTimer: timers.setTimer,
			fetcher: async (url, options) => {
				if (url === 'https://example.com/.well-known/did.json') return didDocument('https://pds.example')
				requestSignal = options?.signal
				return new Promise<Response>((resolve) => {
					resolvePage = resolve
					pageRequested.resolve()
				})
			},
		})

		await scheduler.start()
		timers.fire(500)
		await pageRequested.promise
		expect(scheduler.health.active).toBe(1)
		const shutdownDeadline = new AbortController()
		const stopped = scheduler.stop({ signal: shutdownDeadline.signal })
		expect(requestSignal?.aborted).toBe(true)
		shutdownDeadline.abort()
		expect(await stopped).toEqual({ drained: false })
		resolvePage?.(new Response(null, { status: 503 }))
		await ownerFinished.promise
		// The first bounded stop returned at the global deadline. A subsequent
		// local stop observes the already-unwinding worker and waits for cleanup.
		expect(await scheduler.stop()).toEqual({ drained: true })
		expect(scheduler.health).toMatchObject({ active: 0, queued: 0, running: false, scheduled: 0 })
	})
})
