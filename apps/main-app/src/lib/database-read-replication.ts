/** Raw, non-sensitive replica state collected by the bounded read endpoint probe. */
export interface DatabaseReadReplicationSample {
	inRecovery: boolean
	receivedLsn: string | null
	replayedLsn: string | null
	lastReplayAtMs: number | null
	receiverStreaming: boolean
	receiverLastMessageReceiptAtMs: number | null
}

export interface DatabaseReadReplicationAssessment {
	replayLagMs: number | null
	replicationReceiverHealthy: boolean
}

const isFiniteNumber = (value: number | null): value is number => value !== null && Number.isFinite(value)

/**
 * A quiet, caught-up standby can have an old last replayed transaction. Compare
 * the receive/replay WAL positions first; only age the replay timestamp while
 * there is a real backlog. A caught-up but disconnected receiver is still not
 * usable, so it separately needs a recent streaming heartbeat.
 */
export const assessDatabaseReadReplication = (
	sample: DatabaseReadReplicationSample,
	observedAtMs: number,
	receiverFreshnessMs: number,
): DatabaseReadReplicationAssessment => {
	if (!sample.inRecovery) {
		return { replayLagMs: null, replicationReceiverHealthy: true }
	}

	const caughtUp =
		sample.receivedLsn !== null && sample.replayedLsn !== null && sample.receivedLsn === sample.replayedLsn
	const replayLagMs = caughtUp
		? 0
		: isFiniteNumber(sample.lastReplayAtMs) && Number.isFinite(observedAtMs)
			? Math.max(0, observedAtMs - sample.lastReplayAtMs)
			: null
	const receiverAgeMs =
		isFiniteNumber(sample.receiverLastMessageReceiptAtMs) && Number.isFinite(observedAtMs)
			? observedAtMs - sample.receiverLastMessageReceiptAtMs
			: null
	const replicationReceiverHealthy =
		sample.receiverStreaming && receiverAgeMs !== null && receiverAgeMs >= 0 && receiverAgeMs <= receiverFreshnessMs

	return { replayLagMs, replicationReceiverHealthy }
}
