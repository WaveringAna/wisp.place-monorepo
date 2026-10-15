/**
 * Times the backlink stream's per-event CPU on real Jetstream messages, stage by stage: JSON.parse, event
 * validation, and the backlink handler (firehose.ts) in prod-sized batches with in-memory repositories, so
 * database latency is excluded. Capture a sample first, one raw message per line.
 *
 * Every stage repeats for each pass, so later passes show JIT-warm cost.
 *
 *   NODE_ENV=development WEBHOOK_ALLOW_INSECURE_DEV=1 bun bench/backlink-profile.ts <sample.jsonl> [batch=4096] [passes=3]
 */

import { readFileSync } from 'node:fs'
import type { CursorRepository, PriorReferenceRepository } from '../src/lib/firehose'
import { initScopeDids, startFirehose } from '../src/lib/firehose'
import {
	type JetstreamClient,
	type JetstreamEvent,
	type JetstreamOptions,
	parseJetstreamEvent,
	parseJetstreamMessage,
} from '../src/lib/jetstream'

const [sample = '/tmp/jetstream-sample.jsonl', batchArg = '4096', passesArg = '3'] = process.argv.slice(2)
const batchSize = Number(batchArg)
const passes = Number(passesArg)
const lines = readFileSync(sample, 'utf8').split('\n').filter(Boolean)

function timed<T>(label: string, run: () => T): T {
	const started = performance.now()
	const result = run()
	const ms = performance.now() - started
	console.log(
		`${label.padEnd(22)} ${((ms * 1_000) / lines.length).toFixed(2).padStart(7)} us/event  (${ms.toFixed(0)} ms)`,
	)
	return result
}

let loads = 0
let writes = 0
const references: PriorReferenceRepository = {
	load: async () => {
		loads++
		return undefined
	},
	save: async () => {
		writes++
		return 'stale'
	},
	delete: async () => {
		writes++
		return false
	},
	keys: async () => ({ keys: [], complete: true }),
}
const cursor: CursorRepository = { load: async () => undefined, save: async () => undefined }
let backlink: JetstreamOptions | undefined
const scope = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
initScopeDids([
	{
		did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
		rkey: 'hook',
		record: {
			$type: 'place.wisp.v2.wh',
			scope: { aturi: `at://${scope}`, backlinks: true },
			url: 'https://receiver.example/hook',
			createdAt: '2025-01-01T00:00:00.000Z',
		},
	},
])
await startFirehose({
	cursorRepository: cursor,
	referenceRepository: references,
	runIntakeBatch: async <T>(work: (sql: undefined) => Promise<T>) => work(undefined),
	createJetstreamClient: (options: JetstreamOptions) => {
		if (!options.wantedDids && !options.wantedCollections) backlink = options
		return {
			start() {},
			pause() {},
			resume() {},
			stopAccepting() {},
			drain: async () => {},
			destroy() {},
		} as unknown as JetstreamClient
	},
	enqueueWebhookDeliveries: async (entries) => ({ enqueued: entries.length, deduplicated: 0 }),
	recordWebhookIntakeQuarantine: async () => undefined,
})
if (!backlink) throw new Error('backlink stream did not start')
const onEvents = backlink.onEvents
for (let pass = 1; pass <= passes; pass++) {
	console.log(`pass ${pass}`)
	const parsed = timed('JSON.parse', () => lines.map((line) => JSON.parse(line) as unknown))
	timed('parseJetstreamEvent', () => parsed.map(parseJetstreamEvent))
	const events = timed('parseJetstreamMessage', () =>
		lines.map(parseJetstreamMessage).filter((event): event is JetstreamEvent => event !== null),
	)
	const started = performance.now()
	for (let index = 0; index < events.length; index += batchSize) await onEvents(events.slice(index, index + batchSize))
	const ms = performance.now() - started
	console.log(
		`${'backlink handler'.padEnd(22)} ${((ms * 1_000) / events.length).toFixed(2).padStart(7)} us/event  (${ms.toFixed(0)} ms, ${loads} loads, ${writes} writes)`,
	)
}
process.exit(0)
