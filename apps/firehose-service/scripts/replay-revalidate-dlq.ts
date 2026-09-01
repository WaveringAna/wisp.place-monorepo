/**
 * Bounded, auditable replay of revalidation DLQ entries back into the live
 * work stream.
 *
 * The revalidate worker is the only writer of storage: it re-fetches the
 * authoritative record from the user's canonical PDS (DID-document resolved,
 * SSRF-safe pinned transport) and re-materializes the site with full CID
 * verification, or re-quarantines on failure. This script therefore never
 * repairs bytes itself; it only re-enqueues (did, rkey) work items and leaves
 * every integrity decision to that fail-closed path.
 *
 * Safety properties:
 * - Dry-run by default; `--apply` is required for any write.
 * - Refuses to run without an explicit REDIS_URL and WISP_REVALIDATE_STREAM
 *   (it never guesses which stream is live).
 * - Caps distinct sites per run (--max-sites, default 200) and total enqueues.
 * - Only replays entries matching an error-code allowlist (default: the
 *   transient FETCH_FAILED class fixed by the PDS record size bound).
 * - Rate-limits enqueues and writes a JSON manifest of exactly what was
 *   enqueued for audit and rollback (XDEL by recorded stream id).
 *
 * Usage:
 *   bun run apps/firehose-service/scripts/replay-revalidate-dlq.ts [options]
 *
 * Options:
 *   --apply                 Perform the enqueues (default: dry-run).
 *   --max-sites N           Maximum distinct did/rkey pairs (default 200).
 *   --error CODE[,CODE...]  DLQ errorCodes to replay (default FETCH_FAILED).
 *   --since MS              Only entries quarantined at/after this epoch ms.
 *   --until MS              Only entries quarantined at/before this epoch ms.
 *   --did DID[,DID...]      Restrict to these DIDs.
 *   --exclude-did DID[,...]  Exclude these DIDs (quarantined/unavailable).
 *   --manifest PATH         Manifest output path (default ./dlq-replay-manifest.json).
 *   --rate-ms MS            Delay between enqueues (default 250).
 */

import fs from 'node:fs'
import Redis from 'ioredis'

interface Arguments {
	apply: boolean
	maxSites: number
	errorCodes: string[]
	since?: number
	until?: number
	dids?: string[]
	excludeDids?: string[]
	manifest: string
	rateMs: number
}

function parseArguments(argv: string[]): Arguments {
	const args: Arguments = {
		apply: false,
		maxSites: 200,
		errorCodes: ['FETCH_FAILED'],
		manifest: 'dlq-replay-manifest.json',
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
			case '--max-sites':
				args.maxSites = Number.parseInt(next(), 10)
				break
			case '--error':
				args.errorCodes = next().split(',').map((code) => code.trim()).filter(Boolean)
				break
			case '--since':
				args.since = Number.parseInt(next(), 10)
				break
			case '--until':
				args.until = Number.parseInt(next(), 10)
				break
			case '--did':
				args.dids = next().split(',').map((did) => did.trim()).filter(Boolean)
				break
			case '--exclude-did':
				args.excludeDids = next().split(',').map((did) => did.trim()).filter(Boolean)
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
	if (!Number.isSafeInteger(args.maxSites) || args.maxSites < 1 || args.maxSites > 10_000) {
		throw new Error('--max-sites must be an integer in [1, 10000]')
	}
	if (args.errorCodes.length === 0) throw new Error('--error must select at least one error code')
	if (!Number.isSafeInteger(args.rateMs) || args.rateMs < 0 || args.rateMs > 60_000) {
		throw new Error('--rate-ms must be an integer in [0, 60000]')
	}
	return args
}

interface DlqEntry {
	id: string
	did: string
	rkey: string
	reason: string
	errorCode: string
	classification: string
	attempts: number
	quarantinedAt: number
}

function entryField(fields: string[], name: string): string {
	const index = fields.indexOf(name)
	return index >= 0 ? (fields[index + 1] ?? '') : ''
}

async function readDlqEntries(redis: Redis, dlqStream: string): Promise<DlqEntry[]> {
	const entries: DlqEntry[] = []
	let lastId = '-'
	while (true) {
		const page = await redis.xrange(dlqStream, lastId, '+', 'COUNT', 200)
		if (page.length === 0) break
		for (const [id, fields] of page) {
			const quarantinedAt = Number.parseInt(entryField(fields, 'quarantinedAt'), 10)
			entries.push({
				id,
				did: entryField(fields, 'did'),
				rkey: entryField(fields, 'rkey'),
				reason: entryField(fields, 'reason'),
				errorCode: entryField(fields, 'errorCode'),
				classification: entryField(fields, 'classification'),
				attempts: Number.parseInt(entryField(fields, 'attempts'), 10) || 0,
				quarantinedAt: Number.isFinite(quarantinedAt) ? quarantinedAt : 0,
			})
		}
		lastId = `(${page[page.length - 1][0]}`
	}
	return entries
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
	const dlqStream = process.env.WISP_REVALIDATE_DLQ_STREAM || 'wisp:revalidate:dlq'

	const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2, enableReadyCheck: true })
	try {
		const groups = (await redis.xinfo('GROUPS', targetStream).catch(() => null)) as unknown[] | null
		if (!groups || groups.length === 0) {
			throw new Error(`Consumer group missing on ${targetStream}; refusing to enqueue into an unowned stream.`)
		}

		const entries = await readDlqEntries(redis, dlqStream)
		const errorCodeSet = new Set(args.errorCodes)
		const didSet = args.dids ? new Set(args.dids) : undefined
		const excludedDidSet = args.excludeDids ? new Set(args.excludeDids) : undefined
		const filtered = entries.filter(
			(entry) =>
				errorCodeSet.has(entry.errorCode) &&
				(!args.since || entry.quarantinedAt >= args.since) &&
				(!args.until || entry.quarantinedAt <= args.until) &&
				(!didSet || didSet.has(entry.did)) &&
				(!excludedDidSet || !excludedDidSet.has(entry.did)) &&
				entry.did.startsWith('did:') &&
				entry.rkey.length > 0,
		)

		// One work item per distinct site, keeping the newest DLQ evidence.
		const newestBySite = new Map<string, DlqEntry>()
		for (const entry of filtered) {
			const key = `${entry.did}|${entry.rkey}`
			const existing = newestBySite.get(key)
			if (!existing || entry.quarantinedAt > existing.quarantinedAt) newestBySite.set(key, entry)
		}
		const selected = [...newestBySite.values()]
			.sort((a, b) => a.quarantinedAt - b.quarantinedAt)
			.slice(0, args.maxSites)

		console.log(
			`DLQ ${dlqStream}: ${entries.length} entries, ${filtered.length} matched filters, ${newestBySite.size} distinct sites, replaying ${selected.length} (cap ${args.maxSites}).`,
		)
		const byError = new Map<string, number>()
		for (const entry of filtered) byError.set(entry.errorCode, (byError.get(entry.errorCode) ?? 0) + 1)
		console.log(`Matched errorCodes: ${JSON.stringify([...byError.entries()])}`)

		const enqueued: Array<{
			streamId?: string
			did: string
			rkey: string
			reason: string
			sourceDlqId: string
			deduplicated?: boolean
		}> = []

		// Mirror the worker's own enqueue dedupe key so a replay cannot create a
		// duplicate live entry while the same (did, rkey, category) is already
		// pending in the target stream. The key is trusted only while XRANGE
		// proves its referenced entry still exists, exactly like the app script.
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

		if (args.apply) {
			for (const entry of selected) {
				const reason = entry.reason.startsWith('storage-miss') ? entry.reason : 'dlq-replay'
				if (await isAlreadyEnqueued(entry.did, entry.rkey, reason)) {
					enqueued.push({ did: entry.did, rkey: entry.rkey, reason, sourceDlqId: entry.id, deduplicated: true })
					console.log(`Skipped ${entry.did}/${entry.rkey}: already pending in ${targetStream}`)
					await sleep(args.rateMs)
					continue
				}
				const streamId = (await redis.xadd(
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
				enqueued.push({ streamId, did: entry.did, rkey: entry.rkey, reason, sourceDlqId: entry.id })
				console.log(`Enqueued ${entry.did}/${entry.rkey} (${reason}) as ${streamId}`)
				await sleep(args.rateMs)
			}
			console.log(`Applied ${enqueued.filter((item) => !item.deduplicated).length} enqueues, ${enqueued.filter((item) => item.deduplicated).length} deduplicated.`)
		} else {
			for (const entry of selected) {
				console.log(`[dry-run] Would enqueue ${entry.did}/${entry.rkey} (${entry.reason})`)
			}
			console.log(`Dry-run complete: ${selected.length} sites would be enqueued. Re-run with --apply to proceed.`)
		}

		const manifest = {
			generatedAt: new Date().toISOString(),
			applied: args.apply,
			dlqStream,
			targetStream,
			filters: { errorCodes: args.errorCodes, since: args.since, until: args.until, dids: args.dids, excludeDids: args.excludeDids },
			dlqEntryCount: entries.length,
			matchedEntryCount: filtered.length,
			distinctSiteCount: newestBySite.size,
			selectedSiteCount: selected.length,
			enqueued,
			rollbackHint:
				'Rollback: for each manifest item with a streamId, XDEL targetStream <streamId> (only safe while unconsumed). Deduplicated items have no streamId.',
		}
		fs.writeFileSync(args.manifest, `${JSON.stringify(manifest, null, 2)}
`)
		console.log(`Manifest written to ${args.manifest}`)
	} finally {
		await redis.quit().catch(() => undefined)
	}
}

await main()
