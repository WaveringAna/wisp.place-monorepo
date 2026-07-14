import { jsonToLex } from '@atproto/lexicon'

/**
 * Convert the JSON representation returned by AT Protocol XRPC endpoints
 * into the in-memory representation expected by these generated validators.
 */
export function parseLexiconJson<T>(value: unknown): T {
	return jsonToLex(value as Parameters<typeof jsonToLex>[0]) as T
}
