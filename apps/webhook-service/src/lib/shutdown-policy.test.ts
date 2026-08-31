import { describe, expect, test } from 'bun:test'
import { canCloseSharedClients, type ShutdownCleanupStatus } from './shutdown-policy'

const settled: ShutdownCleanupStatus = {
	initialBackfillSettled: true,
	intakeDrained: true,
	schedulerDrained: true,
	deliveryStopped: true,
}

describe('shared-client shutdown policy', () => {
	test('closes shared clients only after every producer settles', () => {
		expect(canCloseSharedClients(settled)).toBe(true)
	})

	test('keeps shared clients open when initial backfill remains active', () => {
		expect(canCloseSharedClients({ ...settled, initialBackfillSettled: false })).toBe(false)
	})

	test('keeps shared clients open when intake drain fails or times out', () => {
		expect(canCloseSharedClients({ ...settled, intakeDrained: false })).toBe(false)
	})

	test('keeps shared clients open when the reconciliation scheduler remains active', () => {
		expect(canCloseSharedClients({ ...settled, schedulerDrained: false })).toBe(false)
	})

	test('keeps shared clients open when delivery cleanup remains active', () => {
		expect(canCloseSharedClients({ ...settled, deliveryStopped: false })).toBe(false)
	})
})
