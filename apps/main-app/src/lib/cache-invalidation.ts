import { createLogger } from '@wispplace/observability'
import { getConnectedRedisClient } from './redis'

const logger = createLogger('main-app:cache-invalidation')
const CHANNEL = 'wisp:cache-invalidate'

type DomainKind = 'wisp' | 'custom'

export async function publishDomainCacheInvalidation(
	domain: string,
	domainKind: DomainKind,
	customDomainId?: string,
): Promise<void> {
	const normalizedDomain = domain.trim().toLowerCase()
	if (!normalizedDomain) return

	try {
		const redis = await getConnectedRedisClient()
		if (!redis) return

		const stream = process.env.WISP_CACHE_INVALIDATION_STREAM || 'wisp:cache-invalidate-stream'
		const configuredMaxLen = Number.parseInt(process.env.WISP_CACHE_INVALIDATION_STREAM_MAXLEN || '', 10)
		const maxLen = Number.isSafeInteger(configuredMaxLen) && configuredMaxLen > 0 ? `${configuredMaxLen}` : '10000'
		const fields = [
			'action',
			'domain',
			'domain',
			normalizedDomain,
			'domainKind',
			domainKind,
			...(customDomainId ? ['customDomainId', customDomainId] : []),
			'ts',
			Date.now().toString(),
		]

		const streamId = (await redis.send('XADD', [stream, 'MAXLEN', '~', maxLen, '*', ...fields])) as string
		const message = JSON.stringify({
			action: 'domain',
			domain: normalizedDomain,
			domainKind,
			customDomainId,
			streamId,
		})
		await redis.publish(CHANNEL, message)
	} catch (error) {
		logger.warn('[CacheInvalidation] Failed to publish domain invalidation', {
			domain: normalizedDomain,
			domainKind,
			customDomainId,
			errorKind: error instanceof Error ? error.name : 'UnknownError',
		})
	}
}
