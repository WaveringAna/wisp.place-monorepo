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
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
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
