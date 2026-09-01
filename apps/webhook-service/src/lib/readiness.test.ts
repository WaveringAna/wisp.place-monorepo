import { describe, expect, test } from 'bun:test'
import { isWebhookServingReady } from './readiness'

describe('webhook serving readiness', () => {
	test('allows reconciling-live because durable intake is already serving', () => {
		expect(
			isWebhookServingReady({
				phase: 'reconciling-live',
				intakeHealthy: true,
				backfillInfrastructureHealthy: true,
				retryInfrastructureHealthy: true,
			}),
		).toBe(true)
	})

	test('does not let owner failures or scans flap global readiness', () => {
		expect(
			isWebhookServingReady({
				phase: 'live',
				intakeHealthy: true,
				backfillInfrastructureHealthy: true,
				retryInfrastructureHealthy: true,
			}),
		).toBe(true)
	})

	test('gates startup and shared infrastructure failures', () => {
		for (const phase of ['starting', 'stopping', 'stopped', 'failed'] as const) {
			expect(
				isWebhookServingReady({
					phase,
					intakeHealthy: true,
					backfillInfrastructureHealthy: true,
					retryInfrastructureHealthy: true,
				}),
			).toBe(false)
		}
		for (const key of ['intakeHealthy', 'backfillInfrastructureHealthy', 'retryInfrastructureHealthy'] as const) {
			expect(
				isWebhookServingReady({
					phase: 'live',
					intakeHealthy: key !== 'intakeHealthy',
					backfillInfrastructureHealthy: key !== 'backfillInfrastructureHealthy',
					retryInfrastructureHealthy: key !== 'retryInfrastructureHealthy',
				}),
			).toBe(false)
		}
	})
})
