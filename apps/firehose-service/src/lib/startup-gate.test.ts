import { describe, expect, test } from 'bun:test'
import { createStartupGate } from './startup-gate'

describe('createStartupGate', () => {
	test('waits until the worker starts', async () => {
		const gate = createStartupGate()
		let settled = false
		const waiting = gate.wait().then((opened) => {
			settled = true
			return opened
		})

		await Promise.resolve()
		expect(settled).toBe(false)

		gate.open()
		expect(await waiting).toBe(true)
	})

	test('cancellation releases a standby without reporting startup', async () => {
		const gate = createStartupGate()
		gate.cancel()
		gate.open()
		expect(await gate.wait()).toBe(false)
	})

	test('opening is idempotent', async () => {
		const gate = createStartupGate()
		gate.open()
		gate.cancel()
		expect(await gate.wait()).toBe(true)
	})
})
