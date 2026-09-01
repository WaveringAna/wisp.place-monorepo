export type WebhookReadinessPhase = 'starting' | 'reconciling-live' | 'live' | 'stopping' | 'stopped' | 'failed'

export interface WebhookReadinessInput {
	phase: WebhookReadinessPhase
	intakeHealthy: boolean
	backfillInfrastructureHealthy: boolean
	retryInfrastructureHealthy: boolean
}

/**
 * Live intake is deliberately started before the bounded initial backfill.
 * Both phases can serve traffic; only shared infrastructure failures gate
 * readiness. Per-owner reconciliation counts remain diagnostic in /health.
 */
export function isWebhookServingReady(input: WebhookReadinessInput): boolean {
	return (
		(input.phase === 'reconciling-live' || input.phase === 'live') &&
		input.intakeHealthy &&
		input.backfillInfrastructureHealthy &&
		input.retryInfrastructureHealthy
	)
}
