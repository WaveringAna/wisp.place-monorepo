import { MAX_REDIRECT_FILE_BYTES, parseRedirectsFileBytes, type RedirectRule } from '@wispplace/fs-utils'
import { createLogger } from '@wispplace/observability'
import { isStorageUnavailableError, storage } from './storage'

const logger = createLogger('redirects')

// Re-export everything from the shared package
export {
	type MatchRedirectContext,
	matchRedirectRule,
	parseCookies,
	parseQueryString,
	parseRedirectsFile,
	type RedirectMatch,
	type RedirectRule,
} from '@wispplace/fs-utils'

/**
 * Load redirect rules from a cached site.
 */
export async function loadRedirectRules(did: string, rkey: string): Promise<RedirectRule[]> {
	const key = `${did}/${rkey}/_redirects`
	try {
		const data = await storage.get(key)
		if (!data) return []

		const rules = parseRedirectsFileBytes(data)
		if (rules === null) {
			logger.warn('Rejected oversized _redirects file', {
				errorKind: 'redirect_file_too_large',
				maxBytes: MAX_REDIRECT_FILE_BYTES,
				byteLength: data.byteLength,
			})
			return []
		}

		return rules
	} catch (error) {
		if (isStorageUnavailableError(error)) throw error
		logger.warn('Failed to load _redirects file', { errorKind: 'redirect_file_load_failed' })
		return []
	}
}
