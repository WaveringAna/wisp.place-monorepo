import { revalidationQuarantineKey } from '@wispplace/constants'
import { createLogger } from '@wispplace/observability'
import { getConnectedRedisClient } from './redis'

const logger = createLogger('main-app')
/** The flag is a hint: never hold the site list behind a slow Redis. */
const LOOKUP_TIMEOUT_MS = 500

export interface SiteFenceReader {
	send(command: 'MGET', args: string[]): Promise<unknown>
}

/**
 * Flag sites the firehose has fenced after its repairs kept failing: hosting
 * answers 503 for their missing files until the owner redeploys (or a
 * scheduled retry succeeds). One MGET for all of the user's sites; any Redis
 * problem leaves the list unflagged rather than failing it.
 */
export async function flagSitesNeedingAttention<T extends { did: string; rkey: string }>(
	sites: T[],
	connect: () => Promise<SiteFenceReader | null> = getConnectedRedisClient,
): Promise<Array<T & { needs_attention?: true }>> {
	if (sites.length === 0) return sites
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error('Fence lookup timed out')), LOOKUP_TIMEOUT_MS)
		})
		const lookup = connect().then((client) =>
			client?.send(
				'MGET',
				sites.map((site) => revalidationQuarantineKey(site.did, site.rkey)),
			),
		)
		const fences = await Promise.race([lookup, timeout])
		if (!Array.isArray(fences)) return sites
		return sites.map((site, index) => (fences[index] == null ? site : { ...site, needs_attention: true as const }))
	} catch (error) {
		logger.warn('[User] Site fence lookup failed', { errorName: error instanceof Error ? error.name : 'UnknownError' })
		return sites
	} finally {
		clearTimeout(timer)
	}
}
