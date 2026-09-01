export const DEFAULT_CACHE_INVALIDATION_CHANNEL = 'wisp:cache-invalidate'
export const DEFAULT_CACHE_INVALIDATION_STREAM = 'wisp:cache-invalidate-stream'
export const DEFAULT_CACHE_INVALIDATION_STREAM_MAX_LEN = 10_000
const MAX_STREAM_LEN = 1_000_000

export type CacheInvalidationSiteAction = 'updating' | 'update' | 'delete' | 'settings'
export type CacheInvalidationAction = CacheInvalidationSiteAction | 'domain'
export type CacheInvalidationDomainKind = 'wisp' | 'custom'

export interface CacheInvalidationMessage {
	action: CacheInvalidationAction
	did?: string
	rkey?: string
	domain?: string
	domainKind?: CacheInvalidationDomainKind
	customDomainId?: string
	token?: string
	streamId?: string
	[key: string]: unknown
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
const isKind = (value: unknown): value is CacheInvalidationDomainKind => value === 'wisp' || value === 'custom'
const isString = (value: unknown): value is string => typeof value === 'string'
const ACTIONS = new Set<CacheInvalidationAction>(['updating', 'update', 'delete', 'settings', 'domain'])

/** Decode the legacy-compatible JSON payload without dropping unknown keys. */
export function decodeCacheInvalidationMessage(message: string): CacheInvalidationMessage | null {
	try {
		const parsed: unknown = JSON.parse(message)
		if (
			!isObject(parsed) ||
			typeof parsed.action !== 'string' ||
			!ACTIONS.has(parsed.action as CacheInvalidationAction)
		)
			return null
		if (parsed.action === 'domain') {
			if (!isString(parsed.domain) || (parsed.domainKind !== undefined && !isKind(parsed.domainKind))) return null
		} else if (!isString(parsed.did) || !isString(parsed.rkey)) {
			return null
		} else if (parsed.domainKind !== undefined && !isKind(parsed.domainKind)) {
			parsed.domainKind = undefined
		}
		parsed.domainKind = isKind(parsed.domainKind) ? parsed.domainKind : undefined
		for (const key of parsed.action === 'domain' ? ['customDomainId'] : ['domain', 'customDomainId', 'token']) {
			parsed[key] = isString(parsed[key]) ? parsed[key] : undefined
		}
		return parsed as CacheInvalidationMessage
	} catch {
		return null
	}
}

export function encodeCacheInvalidationMessage(message: CacheInvalidationMessage): string {
	return JSON.stringify(message)
}

/** Write XADD before PUBLISH; event insertion order is the existing field order. */
export async function publishCacheInvalidationEvent(
	redis: {
		xadd(stream: string, ...args: string[]): PromiseLike<unknown>
		publish(channel: string, message: string): PromiseLike<unknown>
	},
	event: CacheInvalidationMessage,
	channel: string,
	stream: string,
	streamMaxLen: number,
): Promise<string> {
	const fields = Object.entries(event)
		.filter(([key, value]) => key !== 'streamId' && Boolean(value))
		.flatMap(([key, value]) => [key, value as string])
		.concat('ts', Date.now().toString())
	const streamId = (await redis.xadd(stream, 'MAXLEN', '~', streamMaxLen.toString(), '*', ...fields)) as string
	await redis.publish(channel, encodeCacheInvalidationMessage({ ...event, streamId }))
	return streamId
}

export function resolveCacheInvalidationStreamMaxLen(value: string | undefined): number {
	if (value !== undefined && !/^(0|[1-9][0-9]*)$/.test(value)) return DEFAULT_CACHE_INVALIDATION_STREAM_MAX_LEN
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_STREAM_LEN
		? parsed
		: DEFAULT_CACHE_INVALIDATION_STREAM_MAX_LEN
}
