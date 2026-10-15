/**
 * Replays the unfiltered Jetstream (the backlink stream's subscription) from a
 * past cursor through JetstreamClient with prod's queue settings and a handler
 * that costs `usPerEvent` per event, then reports how fast the client catches up.
 *
 * The client loads ./config, which needs a database unless development is explicit:
 *
 *   NODE_ENV=development WEBHOOK_ALLOW_INSECURE_DEV=1 \
 *     bun bench/jetstream-catchup.ts [hoursBack=10] [seconds=60] [usPerEvent=7.5] [relay]
 */

import { JetstreamClient } from '../src/lib/jetstream'

const hoursBack = Number(process.argv[2] ?? 10)
const seconds = Number(process.argv[3] ?? 60)
const usPerEvent = Number(process.argv[4] ?? 7.5)
const url = process.argv[5] ?? 'wss://jetstream2.us-west.bsky.network/subscribe'
const start = (Date.now() - hoursBack * 3_600_000) * 1_000

let events = 0
let connects = 0
const client = new JetstreamClient({
	url,
	cursor: start,
	maxQueue: 8_192,
	batchMax: 4_096,
	onEvents: async (batch) => {
		await Bun.sleep((batch.length * usPerEvent) / 1_000)
		events += batch.length
	},
	onConnect: () => {
		connects++
	},
})
const cpuBefore = process.cpuUsage()
client.start()
await Bun.sleep(seconds * 1_000)
const cpu = process.cpuUsage(cpuBefore)
const reached = client.cursor ?? start
client.destroy()

const replayedSeconds = (reached - start) / 1e6
console.log(
	JSON.stringify({
		seconds,
		events,
		eventsPerSecond: Math.round(events / seconds),
		connects,
		replayedSeconds: Math.round(replayedSeconds),
		realtimeMultiple: Number((replayedSeconds / seconds).toFixed(1)),
		cpuPercent: Math.round((cpu.user + cpu.system) / (seconds * 10_000)),
	}),
)
