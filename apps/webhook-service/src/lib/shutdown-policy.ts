/**
 * Shared clients must outlive every callback that can still use them.
 * This policy is deliberately pure so shutdown safety stays independently testable.
 */
export interface ShutdownCleanupStatus {
	readonly initialBackfillSettled: boolean
	readonly intakeDrained: boolean
	readonly schedulerDrained: boolean
	readonly deliveryStopped: boolean
}

export function canCloseSharedClients(status: ShutdownCleanupStatus): boolean {
	return status.initialBackfillSettled && status.intakeDrained && status.schedulerDrained && status.deliveryStopped
}
