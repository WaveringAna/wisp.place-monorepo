import {
	DEFAULT_CACHE_INVALIDATION_CHANNEL,
	DEFAULT_CACHE_INVALIDATION_STREAM,
	publishCacheInvalidationEvent,
	resolveCacheInvalidationStreamMaxLen,
} from '@wispplace/constants'
import { createLogger } from '@wispplace/observability'
import { getConnectedRedisClient } from './redis'

const logger = createLogger('main-app:cache-invalidation')

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

		const publisher = {
			xadd: (stream: string, ...args: string[]) => redis.send('XADD', [stream, ...args]),
			publish: (channel: string, message: string) => redis.publish(channel, message),
		}
		await publishCacheInvalidationEvent(
			publisher,
			{ action: 'domain', domain: normalizedDomain, domainKind, customDomainId },
			DEFAULT_CACHE_INVALIDATION_CHANNEL,
			process.env.WISP_CACHE_INVALIDATION_STREAM || DEFAULT_CACHE_INVALIDATION_STREAM,
			resolveCacheInvalidationStreamMaxLen(process.env.WISP_CACHE_INVALIDATION_STREAM_MAXLEN),
		)
	} catch (error) {
		logger.warn('[CacheInvalidation] Failed to publish domain invalidation', {
			domain: normalizedDomain,
			domainKind,
			customDomainId,
			errorKind: error instanceof Error ? error.name : 'UnknownError',
		})
	}
}
