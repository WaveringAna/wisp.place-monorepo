import { describe, expect, test } from 'bun:test'
import { safeFetch } from './index'

class ChunkBudget {
	readonly controller = new AbortController()
	consumed = 0

	get signal(): AbortSignal {
		return this.controller.signal
	}

	consume(bytes: number): void {
		if (this.consumed + bytes > 3) {
			const error = new Error('transfer budget exceeded')
			error.name = 'TransferBudgetExceededError'
			this.controller.abort(error)
			throw error
		}
		this.consumed += bytes
	}
}

describe('safeFetch shared transfer budget', () => {
	test('aborts a chunked reader and transport when the budget is exceeded', async () => {
		const budget = new ChunkBudget()
		let cancelCalls = 0
		let transportAborted = false
		let chunk = 0
		const sourceResponse = {
			status: 200,
			statusText: 'OK',
			headers: new Headers(),
			body: {
				getReader() {
					return {
						read: async () => {
							if (chunk < 2) {
								chunk++
								return { done: false, value: Uint8Array.of(1, 2) }
							}
							return { done: true, value: undefined }
						},
						cancel: async () => {
							cancelCalls++
						},
						releaseLock: () => undefined,
					}
				},
			},
		} as unknown as Response

		const response = await safeFetch('https://public.example.test/data', {
			byteBudget: budget,
			resolver: async () => [{ address: '93.184.216.34', family: 4 }],
			transport: async ({ signal }) => {
				signal.addEventListener(
					'abort',
					() => {
						transportAborted = true
					},
					{ once: true },
				)
				return sourceResponse
			},
		})

		await expect(response.arrayBuffer()).rejects.toThrow('transfer budget exceeded')
		expect(budget.consumed).toBe(2)
		expect(cancelCalls).toBeGreaterThan(0)
		expect(transportAborted).toBe(true)
	})
})
