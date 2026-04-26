import { createLogger } from '@wispplace/observability'
import { getRedisClient } from './redis'

const logger = createLogger('main-app:cache-invalidation')
const CHANNEL = 'wisp:cache-invalidate'

type DomainKind = 'wisp' | 'custom'

export async function publishDomainCacheInvalidation(
	domain: string,
	domainKind: DomainKind,
	customDomainId?: string,
): Promise<void> {
	const redis = getRedisClient()
	if (!redis) return

	const normalizedDomain = domain.trim().toLowerCase()
	if (!normalizedDomain) return

	try {
		const stream = process.env.WISP_CACHE_INVALIDATION_STREAM || 'wisp:cache-invalidate-stream'
		const maxLen = process.env.WISP_CACHE_INVALIDATION_STREAM_MAXLEN || '10000'
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
	} catch (err) {
		logger.warn('[CacheInvalidation] Failed to publish domain invalidation', {
			domain: normalizedDomain,
			domainKind,
			customDomainId,
			err,
		})
	}
}
