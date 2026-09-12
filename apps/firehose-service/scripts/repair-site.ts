/** Exact-site, verified quarantine recovery. See docs/operations/repair-site.md. */
import Redis from 'ioredis'
import { fetchAuthoritativeSiteRecord, verifySiteBlobs } from '../src/lib/cache-writer'
import { closeDatabase } from '../src/lib/db'
import { createRevalidationResourceContext } from '../src/lib/revalidate-resources'
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
				preflight: async (did, rkey, signal) => {
					// Each pass has a real cancellation deadline and a shared streamed byte cap.
					const resources = createRevalidationResourceContext(600_000, 1024 * 1024 * 1024, signal)
					try {
						const current = await fetchAuthoritativeSiteRecord(did, rkey, resources)
						if (!current) throw new Error('Canonical site record is absent; no repair is safe')
						return await verifySiteBlobs(did, rkey, current.record, current.cid, resources)
					} finally {
						resources.close()
					}
				},
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
