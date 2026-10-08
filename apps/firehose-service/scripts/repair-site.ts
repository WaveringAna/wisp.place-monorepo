/** Exact-site, verified quarantine recovery. See docs/operations/repair-site.md. */
import Redis from 'ioredis'
import { preflightVerifiedRepair } from '../src/lib/cache-writer'
import { closeDatabase } from '../src/lib/db'
import { repairSite } from '../src/lib/site-repair'
import { parseRepairSiteArguments } from '../src/lib/site-repair-cli'
import { verifiedRepairReceiptKey } from '../src/lib/site-repair-protocol'

export async function main(): Promise<void> {
	const options = parseRepairSiteArguments(process.argv.slice(2), process.env)
	if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be explicit for read-only quota admission')
	const controller = new AbortController()
	const abort = () => controller.abort(new Error('Operator cancelled repair'))
	process.once('SIGINT', abort)
	process.once('SIGTERM', abort)
	const redis = new Redis(process.env.REDIS_URL!, {
		lazyConnect: true,
		maxRetriesPerRequest: 0,
		enableOfflineQueue: false,
		connectTimeout: 5_000,
		commandTimeout: 5_000,
		retryStrategy: () => null,
	})
	redis.on('error', () => undefined)
	try {
		await redis.connect()
		const result = await repairSite(
			options,
			{
				redis,
				// Each pass has a real cancellation deadline and a shared streamed byte cap.
				preflight: (did, rkey, signal) => preflightVerifiedRepair(did, rkey, signal, 600_000, 1024 * 1024 * 1024),
				onEnqueued: ({ streamId, request }) =>
					console.log(
						JSON.stringify({
							status: 'enqueued-unconfirmed',
							did: options.did,
							rkey: options.rkey,
							stream: options.stream,
							streamId,
							receiptKey: verifiedRepairReceiptKey(options.stream, request.token),
							...request,
						}),
					),
			},
			controller.signal,
		)
		console.log(JSON.stringify(result))
	} finally {
		redis.disconnect()
		process.removeListener('SIGINT', abort)
		process.removeListener('SIGTERM', abort)
		await closeDatabase()
	}
}

if (import.meta.main) {
	try {
		await main()
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'Repair failed')
		process.exitCode = 1
	}
}
