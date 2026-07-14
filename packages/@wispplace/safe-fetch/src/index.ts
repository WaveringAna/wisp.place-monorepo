/**
 * SSRF-hardened fetch utility
 * Prevents requests to private networks, localhost, and enforces timeouts/size limits
 */

const BLOCKED_IP_RANGES = [
	/^127\./, // 127.0.0.0/8 - Loopback
	/^10\./, // 10.0.0.0/8 - Private
	/^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 - Private
	/^192\.168\./, // 192.168.0.0/16 - Private
	/^169\.254\./, // 169.254.0.0/16 - Link-local
	/^::1$/, // IPv6 loopback
	/^fe80:/, // IPv6 link-local
	/^fc00:/, // IPv6 unique local
	/^fd00:/, // IPv6 unique local
]

const BLOCKED_HOSTS = ['localhost', 'metadata.google.internal', '169.254.169.254']

export const DEFAULT_FETCH_TIMEOUT_MS = 30000 // 30 seconds for control-plane requests
const FETCH_TIMEOUT_BLOB = 120000 // 2 minutes for blob downloads
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_JSON_SIZE = 1024 * 1024 // 1MB
const MAX_BLOB_SIZE = 500 * 1024 * 1024 // 500MB
const _MAX_REDIRECTS = 10

// Retry configuration
const MAX_RETRIES = 3
const INITIAL_RETRY_DELAY = 1000 // 1 second
const MAX_RETRY_DELAY = 10000 // 10 seconds

function isBlockedHost(hostname: string): boolean {
	const lowerHost = hostname.toLowerCase()

	if (BLOCKED_HOSTS.includes(lowerHost)) {
		return true
	}

	for (const pattern of BLOCKED_IP_RANGES) {
		if (pattern.test(lowerHost)) {
			return true
		}
	}

	return false
}

/**
 * Check if an error is retryable (network/SSL errors, not HTTP errors)
 */
function isRetryableError(err: unknown): boolean {
	if (!(err instanceof Error)) return false

	// Network errors (ECONNRESET, ENOTFOUND, etc.)
	const errorCode = (err as any).code
	if (errorCode) {
		const retryableCodes = [
			'ECONNRESET',
			'ECONNREFUSED',
			'ETIMEDOUT',
			'ENOTFOUND',
			'ENETUNREACH',
			'EAI_AGAIN',
			'EPIPE',
			'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', // SSL/TLS handshake failures
			'ERR_SSL_WRONG_VERSION_NUMBER',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		]
		if (retryableCodes.includes(errorCode)) {
			return true
		}
	}

	// Timeout errors
	if (err.name === 'AbortError' || err.message.includes('timeout')) {
		return true
	}

	// Fetch failures (generic network errors)
	if (err.message.includes('fetch failed')) {
		return true
	}

	return false
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retry a function with exponential backoff
 */
async function withRetry<T>(
	fn: () => Promise<T>,
	options: { maxRetries?: number; initialDelay?: number; maxDelay?: number; context?: string } = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? MAX_RETRIES
	const initialDelay = options.initialDelay ?? INITIAL_RETRY_DELAY
	const maxDelay = options.maxDelay ?? MAX_RETRY_DELAY
	const context = options.context ?? 'Request'

	let lastError: unknown

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn()
		} catch (err) {
			lastError = err

			// Don't retry if this is the last attempt or error is not retryable
			if (attempt === maxRetries || !isRetryableError(err)) {
				throw err
			}

			// Calculate delay with exponential backoff
			const delay = Math.min(initialDelay * 2 ** attempt, maxDelay)

			const errorCode = (err as any)?.code
			const errorMsg = err instanceof Error ? err.message : String(err)
			console.warn(
				`${context} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMsg}${errorCode ? ` [${errorCode}]` : ''} - retrying in ${delay}ms`,
			)

			await sleep(delay)
		}
	}

	throw lastError
}

export async function safeFetch(
	url: string,
	options?: RequestInit & { maxSize?: number; timeout?: number; retry?: boolean },
): Promise<Response> {
	const shouldRetry = options?.retry === true // Retries must be explicitly enabled by background callers
	const timeoutMs = options?.timeout ?? DEFAULT_FETCH_TIMEOUT_MS
	const maxSize = options?.maxSize ?? MAX_RESPONSE_SIZE

	// Parse and validate URL (done once, outside retry loop)
	let parsedUrl: URL
	try {
		parsedUrl = new URL(url)
	} catch (_err) {
		throw new Error(`Invalid URL: ${url}`)
	}

	if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
		throw new Error(`Blocked protocol: ${parsedUrl.protocol}`)
	}

	const hostname = parsedUrl.hostname
	if (isBlockedHost(hostname)) {
		throw new Error(`Blocked host: ${hostname}`)
	}

	const fetchFn = async () => {
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

		try {
			const response = await fetch(url, {
				...options,
				signal: controller.signal,
				redirect: 'follow',
				headers: {
					'User-Agent': 'wisp-place hosting-service',
					...(options?.headers || {}),
				},
			})

			const contentLength = response.headers.get('content-length')
			if (contentLength && parseInt(contentLength, 10) > maxSize) {
				throw new Error(`Response too large: ${contentLength} bytes`)
			}

			return response
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				throw new Error(`Request timeout after ${timeoutMs}ms`)
			}
			throw err
		} finally {
			clearTimeout(timeoutId)
		}
	}

	if (shouldRetry) {
		return withRetry(fetchFn, { context: `Fetch ${parsedUrl.hostname}` })
	} else {
		return fetchFn()
	}
}

export async function safeFetchJson<T = any>(
	url: string,
	options?: RequestInit & { maxSize?: number; timeout?: number; retry?: boolean },
): Promise<T> {
	const maxJsonSize = options?.maxSize ?? MAX_JSON_SIZE
	const response = await safeFetch(url, { ...options, maxSize: maxJsonSize })

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`)
	}

	const reader = response.body?.getReader()
	if (!reader) {
		throw new Error('No response body')
	}

	const chunks: Uint8Array[] = []
	let totalSize = 0

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break

			totalSize += value.length
			if (totalSize > maxJsonSize) {
				throw new Error(`Response exceeds max size: ${maxJsonSize} bytes`)
			}

			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	const combined = new Uint8Array(totalSize)
	let offset = 0
	for (const chunk of chunks) {
		combined.set(chunk, offset)
		offset += chunk.length
	}

	const text = new TextDecoder().decode(combined)
	return JSON.parse(text)
}

export async function safeFetchBlob(
	url: string,
	options?: RequestInit & { maxSize?: number; timeout?: number; retry?: boolean },
): Promise<Uint8Array> {
	const maxBlobSize = options?.maxSize ?? MAX_BLOB_SIZE
	const timeoutMs = options?.timeout ?? FETCH_TIMEOUT_BLOB
	const response = await safeFetch(url, { ...options, maxSize: maxBlobSize, timeout: timeoutMs })

	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${response.statusText}`)
	}

	const reader = response.body?.getReader()
	if (!reader) {
		throw new Error('No response body')
	}

	const chunks: Uint8Array[] = []
	let totalSize = 0

	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break

			totalSize += value.length
			if (totalSize > maxBlobSize) {
				throw new Error(`Blob exceeds max size: ${maxBlobSize} bytes`)
			}

			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	const combined = new Uint8Array(totalSize)
	let offset = 0
	for (const chunk of chunks) {
		combined.set(chunk, offset)
		offset += chunk.length
	}

	return combined
}
