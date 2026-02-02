/**
 * Shared constants for wisp.place
 */

// Domain configuration
export const getBaseHost = () => {
  if (typeof Bun !== 'undefined') {
    return Bun.env.BASE_DOMAIN || "wisp.place";
  }
  return process.env.BASE_DOMAIN || "wisp.place";
};

export const BASE_HOST = getBaseHost();

// File size limits
export const MAX_SITE_SIZE = 300 * 1024 * 1024; // 300MB
export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
export const MAX_FILE_COUNT = 1000;

// Cache configuration
export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Fetch timeouts and limits
export const FETCH_TIMEOUT_MS = 30000; // 30 seconds
export const MAX_JSON_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_BLOB_SIZE = MAX_FILE_SIZE; // Use file size limit

// Directory limits (AT Protocol lexicon constraints)
export const MAX_ENTRIES_PER_DIRECTORY = 500;

// Compression settings
export const GZIP_COMPRESSION_LEVEL = 9;

// CLI Binary URLs
export const CLI_BINARY_BASE_URL = "https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries";
export const CLI_BINARIES = {
  "darwin-universal": `${CLI_BINARY_BASE_URL}/wisp-cli-darwin-universal`,
  "darwin-arm64": `${CLI_BINARY_BASE_URL}/wisp-cli-aarch64-darwin`,
  "darwin-x86_64": `${CLI_BINARY_BASE_URL}/wisp-cli-darwin-x86_64`,
  "linux-arm64": `${CLI_BINARY_BASE_URL}/wisp-cli-aarch64-linux`,
  "linux-x86_64": `${CLI_BINARY_BASE_URL}/wisp-cli-x86_64-linux`,
} as const;
