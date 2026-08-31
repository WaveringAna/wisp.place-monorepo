import { describe, expect, test } from 'bun:test'
import { createDatabaseReadCircuit } from './database-read-circuit'

describe('database read circuit', () => {
	test('uses the primary directly when no separate read endpoint is configured', async () => {
		const circuit = createDatabaseReadCircuit({
			configured: false,
			maxReplayLagMs: 2_000,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			probe: async () => {
				throw new Error('should not probe')
			},
		})

		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('primary')
		expect(circuit.snapshot()).toMatchObject({
			configured: false,
			mode: 'primary',
			usingPrimaryFallback: false,
		})
	})

	test('falls back to primary when the replica probe cannot execute', async () => {
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 100,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			probe: async () => {
				throw new Error('receiver probe permission denied')
			},
		})

		expect((await circuit.probeNow()).mode).toBe('unavailable')
		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('primary')
	})

	test('uses a quiet caught-up read-only replica endpoint', async () => {
		let now = 1_000
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 2_000,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			now: () => now,
			probe: async () => ({
				transactionReadOnly: true,
				sensitiveDataRestricted: true,
				writePrivilegesRestricted: true,
				inRecovery: true,
				replicationReceiverHealthy: true,
				replayLagMs: 0,
			}),
		})

		expect((await circuit.probeNow()).mode).toBe('healthy')
		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('replica')
		now += 1
		expect(circuit.snapshot().usingPrimaryFallback).toBe(false)
	})

	test('falls back to primary when replica replay lag exceeds the configured bound', async () => {
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 100,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			probe: async () => ({
				transactionReadOnly: true,
				sensitiveDataRestricted: true,
				writePrivilegesRestricted: true,
				inRecovery: true,
				replicationReceiverHealthy: true,
				replayLagMs: 101,
			}),
		})

		expect((await circuit.probeNow()).mode).toBe('lagging')
		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('primary')
	})

	test('falls back when a replica has WAL backlog but no replay timestamp', async () => {
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 100,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			probe: async () => ({
				transactionReadOnly: true,
				sensitiveDataRestricted: true,
				writePrivilegesRestricted: true,
				inRecovery: true,
				replicationReceiverHealthy: true,
				replayLagMs: null,
			}),
		})

		expect((await circuit.probeNow()).mode).toBe('lagging')
		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('primary')
	})

	test('falls back when a caught-up replica receiver is disconnected or stale', async () => {
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 100,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			probe: async () => ({
				transactionReadOnly: true,
				sensitiveDataRestricted: true,
				writePrivilegesRestricted: true,
				inRecovery: true,
				replicationReceiverHealthy: false,
				replayLagMs: 0,
			}),
		})

		expect((await circuit.probeNow()).mode).toBe('receiver_unhealthy')
		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('primary')
	})

	test('accepts a local primary endpoint only when its session is read-only', async () => {
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 100,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			probe: async () => ({
				transactionReadOnly: true,
				sensitiveDataRestricted: true,
				writePrivilegesRestricted: true,
				inRecovery: false,
				replicationReceiverHealthy: true,
				replayLagMs: null,
			}),
		})

		expect((await circuit.probeNow()).mode).toBe('healthy')
		expect(
			await circuit.withRead(
				async () => 'read-only-primary',
				async () => 'primary',
			),
		).toBe('read-only-primary')
	})

	test('falls back when the configured role can read sensitive tables', async () => {
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 100,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			probe: async () => ({
				transactionReadOnly: true,
				sensitiveDataRestricted: false,
				writePrivilegesRestricted: true,
				inRecovery: false,
				replicationReceiverHealthy: true,
				replayLagMs: null,
			}),
		})

		expect((await circuit.probeNow()).mode).toBe('unsafe')
		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('primary')
	})

	test('falls back when the configured role has write privileges', async () => {
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 100,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			probe: async () => ({
				transactionReadOnly: true,
				sensitiveDataRestricted: true,
				writePrivilegesRestricted: false,
				inRecovery: false,
				replicationReceiverHealthy: true,
				replayLagMs: null,
			}),
		})

		expect((await circuit.probeNow()).mode).toBe('unsafe')
		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('primary')
	})

	test('opens the circuit after a replica query failure and does not retry during cooldown', async () => {
		let now = 1_000
		let probeCalls = 0
		let replicaCalls = 0
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 100,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			now: () => now,
			probe: async () => {
				probeCalls++
				return {
					transactionReadOnly: true,
					sensitiveDataRestricted: true,
					writePrivilegesRestricted: true,
					inRecovery: true,
					replicationReceiverHealthy: true,
					replayLagMs: 1,
				}
			},
		})

		await circuit.probeNow()
		expect(
			await circuit.withRead(
				async () => {
					replicaCalls++
					throw new Error('postgres://secret@replica/wisp')
				},
				async () => 'primary',
			),
		).toBe('primary')
		expect(circuit.snapshot().mode).toBe('unavailable')

		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('primary')
		expect({ probeCalls, replicaCalls }).toEqual({ probeCalls: 1, replicaCalls: 1 })
		now += 5_000
		expect(
			await circuit.withRead(
				async () => 'replica',
				async () => 'primary',
			),
		).toBe('replica')
		expect(probeCalls).toBe(2)
	})

	test('shares concurrent probes and retains no driver error in health', async () => {
		let resolveProbe:
			| ((value: {
					transactionReadOnly: boolean
					sensitiveDataRestricted: boolean
					writePrivilegesRestricted: boolean
					inRecovery: boolean
					replicationReceiverHealthy: boolean
					replayLagMs: number
			  }) => void)
			| undefined
		let probeCalls = 0
		const circuit = createDatabaseReadCircuit({
			configured: true,
			maxReplayLagMs: 100,
			probeIntervalMs: 5_000,
			cooldownMs: 5_000,
			probe: async () => {
				probeCalls++
				return await new Promise<{
					transactionReadOnly: boolean
					sensitiveDataRestricted: boolean
					writePrivilegesRestricted: boolean
					inRecovery: boolean
					replicationReceiverHealthy: boolean
					replayLagMs: number
				}>((resolve) => {
					resolveProbe = resolve
				})
			},
		})

		const first = circuit.withRead(
			async () => 'replica-one',
			async () => 'primary-one',
		)
		const second = circuit.withRead(
			async () => 'replica-two',
			async () => 'primary-two',
		)
		await Promise.resolve()
		expect(probeCalls).toBe(1)
		resolveProbe?.({
			transactionReadOnly: true,
			sensitiveDataRestricted: true,
			writePrivilegesRestricted: true,
			inRecovery: true,
			replicationReceiverHealthy: true,
			replayLagMs: 1,
		})
		expect(await Promise.all([first, second])).toEqual(['replica-one', 'replica-two'])
	})
})
