/**
 * Shared constants for wisp.place
 */

// Domain configuration
export const getBaseHost = () => {
	if (typeof Bun !== 'undefined') {
		return Bun.env.BASE_DOMAIN || 'wisp.place'
	}
	return process.env.BASE_DOMAIN || 'wisp.place'
}

export const BASE_HOST = getBaseHost()

// File size limits
export const MAX_SITE_SIZE = 300 * 1024 * 1024 // 300MB
export const MAX_SITE_SIZE_SUPPORTER = 700 * 1024 * 1024 // 700MB for supporters
export const MAX_FILE_SIZE = 200 * 1024 * 1024 // 200MB
export const MAX_FILE_COUNT = 1000

// Bun's server cap applies before Elysia can parse multipart bodies. Keep the
// allowance finite, but leave room for the bounded filenames and multipart
// headers of a maximum-size supporter upload.
export const MAX_PUBLIC_UPLOAD_MULTIPART_OVERHEAD = 16 * 1024 * 1024
export const MAX_PUBLIC_UPLOAD_ABSOLUTE_REQUEST_SIZE = 768 * 1024 * 1024
export const MAX_PUBLIC_UPLOAD_REQUEST_SIZE = Math.min(
	MAX_SITE_SIZE_SUPPORTER + MAX_PUBLIC_UPLOAD_MULTIPART_OVERHEAD,
	MAX_PUBLIC_UPLOAD_ABSOLUTE_REQUEST_SIZE,
)

// Cache configuration
export const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
// Durable empty site_cache rows use this non-CID marker after an authoritative delete.
export const DELETED_SITE_RECORD_CID = 'wisp:deleted:v1'

// Fetch timeouts and limits
export const FETCH_TIMEOUT_MS = 30000 // 30 seconds
export const MAX_JSON_SIZE = 10 * 1024 * 1024 // 10MB
export const MAX_BLOB_SIZE = MAX_FILE_SIZE // Use file size limit

// Directory limits (AT Protocol lexicon constraints)
export const MAX_ENTRIES_PER_DIRECTORY = 500

// Compression settings
export const GZIP_COMPRESSION_LEVEL = 9

// Expiry contract: omitted -> default, 0 -> never expires, n -> now + n minutes.
export const DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES = 7 * 24 * 60
export const MAX_PRIVATE_SITE_EXPIRY_MINUTES = 365 * 24 * 60
export const MAX_PRIVATE_SITE_SIZE = 100 * 1024 * 1024
export const MAX_PRIVATE_SITE_FILE_COUNT = 500
// Multipart boundaries and headers are transport overhead, not private file bytes.
export const MAX_PRIVATE_UPLOAD_MULTIPART_OVERHEAD = 1024 * 1024
export const MAX_PRIVATE_UPLOAD_REQUEST_SIZE = MAX_PRIVATE_SITE_SIZE + MAX_PRIVATE_UPLOAD_MULTIPART_OVERHEAD
// This value is a credential and must be redacted before URLs are logged.
export const PRIVATE_SHARE_QUERY_PARAM = 'k'

// Default ignore patterns for file uploads
export const DEFAULT_IGNORE_PATTERNS: string[] = [
	'.git',
	'.git/**',
	'.github',
	'.github/**',
	'.gitlab',
	'.gitlab/**',
	'.DS_Store',
	'.wisp.metadata.json',
	'.wisp-metadata.json',
	'.env',
	'.env.*',
	'node_modules',
	'node_modules/**',
	'Thumbs.db',
	'desktop.ini',
	'._*',
	'.Spotlight-V100',
	'.Spotlight-V100/**',
	'.Trashes',
	'.Trashes/**',
	'.fseventsd',
	'.fseventsd/**',
	'.cache',
	'.cache/**',
	'.temp',
	'.temp/**',
	'.tmp',
	'.tmp/**',
	'__pycache__',
	'__pycache__/**',
	'*.pyc',
	'.venv',
	'.venv/**',
	'venv',
	'venv/**',
	'env',
	'env/**',
	'*.swp',
	'*.swo',
	'.tangled',
	'.tangled/**',
	'.wispignore',
]

// CLI Binary URLs
export const CLI_BINARY_BASE_URL = 'https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries'
export const CLI_BINARIES = {
	'darwin-universal': `${CLI_BINARY_BASE_URL}/wisp-cli-universal-darwin`,
	'darwin-arm64': `${CLI_BINARY_BASE_URL}/wisp-cli-aarch64-darwin`,
	'darwin-x86_64': `${CLI_BINARY_BASE_URL}/wisp-cli-x86_64-darwin`,
	'linux-arm64': `${CLI_BINARY_BASE_URL}/wisp-cli-aarch64-linux`,
	'linux-x86_64': `${CLI_BINARY_BASE_URL}/wisp-cli-x86_64-linux`,
} as const

// AT Protocol OAuth permission sets for the place.wisp.* namespace
export * from './oauth-scopes'
