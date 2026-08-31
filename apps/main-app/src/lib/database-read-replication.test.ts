import { describe, expect, test } from 'bun:test'
import { assessDatabaseReadReplication } from './database-read-replication'

const now = 1_000_000
const freshness = 30_000

const streamingReplica = {
	inRecovery: true,
	receivedLsn: '0/100',
	replayedLsn: '0/100',
	lastReplayAtMs: now - 86_400_000,
	receiverStreaming: true,
	receiverLastMessageReceiptAtMs: now - 1_000,
}

describe('database read replication assessment', () => {
	test('treats a quiet caught-up replica as zero lag', () => {
		expect(assessDatabaseReadReplication(streamingReplica, now, freshness)).toEqual({
			replayLagMs: 0,
			replicationReceiverHealthy: true,
		})
	})

	test('keeps a caught-up replica healthy even when it has never replayed a transaction timestamp', () => {
		expect(assessDatabaseReadReplication({ ...streamingReplica, lastReplayAtMs: null }, now, freshness)).toEqual({
			replayLagMs: 0,
			replicationReceiverHealthy: true,
		})
	})

	test('ages the last replayed transaction only for a real WAL backlog', () => {
		expect(
			assessDatabaseReadReplication(
				{ ...streamingReplica, replayedLsn: '0/0F0', lastReplayAtMs: now - 4_000 },
				now,
				freshness,
			),
		).toEqual({ replayLagMs: 4_000, replicationReceiverHealthy: true })
	})

	test('reports unknown lag when a replica has a backlog but no replay timestamp', () => {
		expect(
			assessDatabaseReadReplication(
				{ ...streamingReplica, replayedLsn: '0/0F0', lastReplayAtMs: null },
				now,
				freshness,
			),
		).toEqual({ replayLagMs: null, replicationReceiverHealthy: true })
	})

	test('rejects a disconnected or stale receiver even when its replay LSN was caught up', () => {
		expect(assessDatabaseReadReplication({ ...streamingReplica, receiverStreaming: false }, now, freshness)).toEqual({
			replayLagMs: 0,
			replicationReceiverHealthy: false,
		})
		expect(
			assessDatabaseReadReplication(
				{ ...streamingReplica, receiverLastMessageReceiptAtMs: now - freshness - 1 },
				now,
				freshness,
			),
		).toEqual({ replayLagMs: 0, replicationReceiverHealthy: false })
		expect(
			assessDatabaseReadReplication({ ...streamingReplica, receiverLastMessageReceiptAtMs: null }, now, freshness),
		).toEqual({ replayLagMs: 0, replicationReceiverHealthy: false })
	})

	test('allows a readonly restricted primary without a WAL receiver', () => {
		expect(
			assessDatabaseReadReplication(
				{
					...streamingReplica,
					inRecovery: false,
					receivedLsn: null,
					replayedLsn: null,
					receiverStreaming: false,
					receiverLastMessageReceiptAtMs: null,
				},
				now,
				freshness,
			),
		).toEqual({ replayLagMs: null, replicationReceiverHealthy: true })
	})
})
