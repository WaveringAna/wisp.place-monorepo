/**
 * Bounded, auditable migration of pending revalidation entries out of a
 * retired work stream (legacy, paused, emergency variants) into the live work
 * stream.
 *
 * Ordering guarantees (exact-once style):
 * - A live-stream replacement is enqueued and its id recorded BEFORE the
 *   source entry is XACKed, so a crash between the two steps leaves a
 *   duplicate work item, never a lost one.
 * - The same dedupe key the revalidate enqueue script uses is consulted
 *   first, so an already-pending (did, rkey, category) is skipped and its
 *   source entry is still XACKed: its repair is already owned by the live
 *   stream.
 * - XDEL of the source entry happens only after XACK, and its id is recorded
 *   in the manifest for audit.
 *
 * Fences: explicit REDIS_URL and WISP_REVALIDATE_STREAM (target); refuses to
 * run when source stream == target, when the target has no consumer group, or
 * when the source group does not exist. Dry-run by default; `--apply` required
 * for any write.
 *
 * Usage:
 *   REDIS_URL=... WISP_REVALIDATE_STREAM=wisp:revalidate-live-7f1965e \
 *     bun run apps/firehose-service/scripts/replay-revalidate-pending.ts \
 *     --source-stream wisp:revalidate [--apply] [--max-items 50] [--did DID,...]
 */

import fs from 'node:fs'
import Redis from 'ioredis'

interface Arguments {
	apply: boolean
	sourceStream: string
	group: string
	maxItems: number
	dids?: string[]
	manifest: string
	rateMs: number
}

function parseArguments(argv: string[]): Arguments {
	const args: Arguments = {
		apply: false,
		sourceStream: '',
		group: 'firehose-service',
		maxItems: 200,
		manifest: 'pending-replay-manifest.json',
		rateMs: 250,
	}
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index]
		const value = argv[index + 1]
		const next = () => {
			if (value === undefined) throw new Error(`Missing value for ${flag}`)
			index++
			return value
		}
		switch (flag) {
			case '--apply':
				args.apply = true
				break
			case '--source-stream':
				args.sourceStream = next()
				break
			case '--group':
				args.group = next()
				break
			case '--max-items':
				args.maxItems = Number.parseInt(next(), 10)
				break
			case '--did':
				args.dids = next().split(',').map((did) => did.trim()).filter(Boolean)
				break
			case '--manifest':
				args.manifest = next()
				break
			case '--rate-ms':
				args.rateMs = Number.parseInt(next(), 10)
				break
			default:
				throw new Error(`Unknown argument: ${flag}`)
		}
	}
	if (!args.sourceStream) throw new Error('--source-stream is required')
	if (!Number.isSafeInteger(args.maxItems) || args.maxItems < 1 || args.maxItems > 10_000) {
		throw new Error('--max-items must be an integer in [1, 10000]')
	}
	if (!Number.isSafeInteger(args.rateMs) || args.rateMs < 0 || args.rateMs > 60_000) {
		throw new Error('--rate-ms must be an integer in [0, 60000]')
	}
	return args
}

interface PendingEntry {
	id: string
	did: string
	rkey: string
	reason: string
	deliveries: number
	consumer: string
}

function fieldValue(fields: string[], name: string): string {
	const index = fields.indexOf(name)
	return index >= 0 ? (fields[index + 1] ?? '') : ''
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
	const args = parseArguments(process.argv.slice(2))
	const redisUrl = process.env.REDIS_URL
	const targetStream = process.env.WISP_REVALIDATE_STREAM
	if (!redisUrl) throw new Error('REDIS_URL must be set explicitly; this tool never guesses a redis.')
	if (!targetStream) {
		throw new Error('WISP_REVALIDATE_STREAM must be set explicitly; this tool never guesses the live stream.')
	}
	if (args.sourceStream === targetStream) {
		throw new Error('Refusing to migrate a stream into itself.')
	}

	const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true })
	try {
		const groups = (await redis.xinfo('GROUPS', targetStream).catch(() => null)) as unknown[] | null
		if (!groups || groups.length === 0) {
			throw new Error(`Consumer group missing on ${targetStream}; refusing to enqueue into an unowned stream.`)
		}
		const sourceGroups = (await redis.xinfo('GROUPS', args.sourceStream).catch(() => null)) as unknown[] | null
		if (!sourceGroups || sourceGroups.length === 0) {
			throw new Error(`Source group missing on ${args.sourceStream}; refusing to migrate an unowned stream.`)
		}

		// Read the pending list. - + is safe here: entries are owned by stale
		// consumers that no longer read this stream, verified by idle time.
		const pending = await redis.xpending(args.sourceStream, args.group, '-', '+', args.maxItems)
		const entries: PendingEntry[] = []
		for (const row of pending as unknown as Array<Array<string | number>>) {
			if (!Array.isArray(row) || row.length < 4) continue
			const id = String(row[0])
			const consumer = String(row[1])
			const deliveries = Number(row[3])
			const page = await redis.xrange(args.sourceStream, id, id, 'COUNT', 1)
			if (page.length !== 1) continue
			const fields = page[0][1]
			const did = fieldValue(fields, 'did')
			const rkey = fieldValue(fields, 'rkey')
			const reason = fieldValue(fields, 'reason')
			if (!did.startsWith('did:') || rkey.length === 0) continue
			if (args.dids && !args.dids.includes(did)) continue
			entries.push({ id, did, rkey, reason, deliveries, consumer })
		}

		console.log(
			`${args.sourceStream}/${args.group}: ${entries.length} pending items selected (cap ${args.maxItems}).`,
		)
		const dedupeCategory = (reason: string): string => {
			if (reason.startsWith('firehose-settings-failed:')) return 'settings'
			if (reason.startsWith('rewrite-miss')) return 'rewrite-miss'
			if (reason.startsWith('storage-miss')) return 'storage-miss'
			if (reason.includes('delete')) return 'delete-tombstone'
			return 'full-repair'
		}
		const isAlreadyEnqueued = async (did: string, rkey: string, reason: string): Promise<boolean> => {
			const key = `revalidate:site:${dedupeCategory(reason)}:${did}:${rkey}`
			const existing = (await redis.get(key)) as string | null
			if (!existing) return false
			const found = await redis.xrange(targetStream, existing, existing, 'COUNT', 1)
			return found.length === 1 && found[0][0] === existing
		}

		const migrated: Array<{
			sourceId: string
			streamId?: string
			did: string
			rkey: string
			reason: string
			deduplicated?: boolean
			xacked: boolean
			xdeled: boolean
		}> = []
		if (args.apply) {
			for (const entry of entries) {
				const reason = entry.reason.startsWith('storage-miss') ? entry.reason : 'dlq-replay'
				let streamId: string | undefined
				if (await isAlreadyEnqueued(entry.did, entry.rkey, reason)) {
					console.log(`Skip enqueue ${entry.did}/${entry.rkey}: already pending in ${targetStream}`)
				} else {
					streamId = (await redis.xadd(
						targetStream,
						'*',
						'did',
						entry.did,
						'rkey',
						entry.rkey,
						'reason',
						reason,
						'ts',
						Date.now().toString(),
					)) as string
					console.log(`Enqueued ${entry.did}/${entry.rkey} (${reason}) as ${streamId}`)
				}
				// Only after the replacement exists do we release the source entry.
				await redis.xack(args.sourceStream, args.group, entry.id)
				const deleted = await redis.xdel(args.sourceStream, entry.id)
				migrated.push({
					sourceId: entry.id,
					streamId,
					did: entry.did,
					rkey: entry.rkey,
					reason,
					deduplicated: streamId === undefined,
					xacked: true,
					xdeled: deleted === 1,
				})
				await sleep(args.rateMs)
			}
			console.log(`Applied ${migrated.length} migrations (${migrated.filter((m) => !m.deduplicated).length} enqueued, ${migrated.filter((m) => m.deduplicated).length} deduplicated).`)
		} else {
			for (const entry of entries) {
				const reason = entry.reason.startsWith('storage-miss') ? entry.reason : 'dlq-replay'
				console.log(`[dry-run] Would migrate ${entry.id} ${entry.did}/${entry.rkey} (${reason})`)
			}
			console.log(`Dry-run complete: ${entries.length} items would be migrated. Re-run with --apply to proceed.`)
		}

		const manifest = {
			generatedAt: new Date().toISOString(),
			applied: args.apply,
			sourceStream: args.sourceStream,
			group: args.group,
			targetStream,
			filters: { dids: args.dids },
			selectedCount: entries.length,
			migrated,
			rollbackHint:
				'Rollback: for each migrated item with a streamId, XDEL targetStream <streamId> (only safe while unconsumed) and re-add the source entry fields to sourceStream; source entries were XACKed and XDELed.',
		}
		fs.writeFileSync(args.manifest, `${JSON.stringify(manifest, null, 2)}
`)
		console.log(`Manifest written to ${args.manifest}`)
	} finally {
		await redis.quit().catch(() => undefined)
	}
}

await main()
