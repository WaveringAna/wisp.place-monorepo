import { describe, expect, test } from 'bun:test'
import { BackfillAbortedError, runCancellableWindow, scanHydrantDids, throwIfBackfillAborted } from './backfill-control'

describe('scanHydrantDids', () => {
	test('deduplicates bounded pages and advances an exclusive cursor', async () => {
		const controller = new AbortController()
		const cursors: Array<string | undefined> = []
		const dids = await scanHydrantDids(
			async (cursor) => {
				cursors.push(cursor)
				if (!cursor) return [{ did: 'did:plc:a' }, { did: 'did:plc:b' }]
				if (cursor === 'did:plc:b') return [{ did: 'did:plc:b' }, { did: 'did:plc:c' }]
				return []
			},
			{ pageSize: 2, maxPages: 3, maxDids: 3, signal: controller.signal },
		)
		expect(dids).toEqual(['did:plc:a', 'did:plc:b', 'did:plc:c'])
		expect(cursors).toEqual([undefined, 'did:plc:b', 'did:plc:c'])
	})

	test('fails instead of looping when a full page repeats its cursor', async () => {
		const controller = new AbortController()
		await expect(
			scanHydrantDids(async () => [{ did: 'same' }], {
				pageSize: 1,
				maxPages: 5,
				maxDids: 5,
				signal: controller.signal,
			}),
		).rejects.toEqual(expect.objectContaining({ name: 'HydrantPaginationError', code: 'REPEATED_CURSOR' }))
	})

	test('enforces page and DID caps with tiny fixtures', async () => {
		const controller = new AbortController()
		let sequence = 0
		await expect(
			scanHydrantDids(async () => [{ did: `did:${sequence++}` }], {
				pageSize: 1,
				maxPages: 2,
				maxDids: 10,
				signal: controller.signal,
			}),
		).rejects.toEqual(expect.objectContaining({ code: 'PAGE_LIMIT' }))
		await expect(
			scanHydrantDids(async () => [{ did: `did:${sequence++}` }, { did: `did:${sequence++}` }], {
				pageSize: 3,
				maxPages: 2,
				maxDids: 1,
				signal: controller.signal,
			}),
		).rejects.toEqual(expect.objectContaining({ code: 'DID_LIMIT' }))
	})

	test('passes cancellation to the in-flight page and rejects cancellation', async () => {
		const controller = new AbortController()
		await expect(
			scanHydrantDids(
				async (_cursor, _limit, signal) => {
					controller.abort()
					expect(signal.aborted).toBe(true)
					return []
				},
				{ signal: controller.signal },
			),
		).rejects.toBeInstanceOf(BackfillAbortedError)
	})
})

describe('runCancellableWindow', () => {
	test('never admits new work after cancellation and waits for admitted work', async () => {
		const controller = new AbortController()
		const started: number[] = []
		const finished: number[] = []
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})

		const work = runCancellableWindow([1, 2, 3, 4], 2, controller.signal, async (item) => {
			started.push(item)
			await gate
			finished.push(item)
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(started).toEqual([1, 2])
		controller.abort()
		release()
		await work
		expect(started).toEqual([1, 2])
		expect(finished).toEqual([1, 2])
	})

	test('waits for every admitted worker before rethrowing a worker failure', async () => {
		const controller = new AbortController()
		let releaseSibling!: () => void
		const siblingGate = new Promise<void>((resolve) => {
			releaseSibling = resolve
		})
		let siblingFinished = false
		let windowSettled = false

		const work = runCancellableWindow([1, 2], 2, controller.signal, async (item) => {
			if (item === 1) throw new Error('worker failed')
			await siblingGate
			siblingFinished = true
		}).finally(() => {
			windowSettled = true
		})

		await Promise.resolve()
		expect(windowSettled).toBe(false)
		releaseSibling()
		await expect(work).rejects.toThrow('worker failed')
		expect(siblingFinished).toBe(true)
	})

	test('validates concurrency and exposes an explicit abort error', async () => {
		const controller = new AbortController()
		await expect(runCancellableWindow([1], 0, controller.signal, async () => {})).rejects.toBeInstanceOf(RangeError)
		controller.abort()
		expect(() => throwIfBackfillAborted(controller.signal)).toThrow(BackfillAbortedError)
	})
})
