/**
 * SSRF-hardened fetch utility
 * Prevents requests to private networks, localhost, and enforces timeouts/size limits
 */

const BLOCKED_IP_RANGES = [
  /^127\./,              // 127.0.0.0/8 - Loopback
  /^10\./,               // 10.0.0.0/8 - Private
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 - Private
  /^192\.168\./,         // 192.168.0.0/16 - Private
  /^169\.254\./,         // 169.254.0.0/16 - Link-local
  /^::1$/,               // IPv6 loopback
  /^fe80:/,              // IPv6 link-local
  /^fc00:/,              // IPv6 unique local
  /^fd00:/,              // IPv6 unique local
];

const BLOCKED_HOSTS = [
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',
];

const FETCH_TIMEOUT = 120000; // 120 seconds
const FETCH_TIMEOUT_BLOB = 120000; // 2 minutes for blob downloads
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_JSON_SIZE = 1024 * 1024; // 1MB
const MAX_BLOB_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_REDIRECTS = 10;

function isBlockedHost(hostname: string): boolean {
  const lowerHost = hostname.toLowerCase();

  if (BLOCKED_HOSTS.includes(lowerHost)) {
    return true;
  }

  for (const pattern of BLOCKED_IP_RANGES) {
    if (pattern.test(lowerHost)) {
      return true;
    }
  }

  return false;
}

export async function safeFetch(
  url: string,
  options?: RequestInit & { maxSize?: number; timeout?: number }
): Promise<Response> {
  const timeoutMs = options?.timeout ?? FETCH_TIMEOUT;
  const maxSize = options?.maxSize ?? MAX_RESPONSE_SIZE;

  // Parse and validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (err) {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error(`Blocked protocol: ${parsedUrl.protocol}`);
  }

  const hostname = parsedUrl.hostname;
  if (isBlockedHost(hostname)) {
    throw new Error(`Blocked host: ${hostname}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'follow',
    });

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxSize) {
      throw new Error(`Response too large: ${contentLength} bytes`);
    }

    return response;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function safeFetchJson<T = any>(
  url: string,
  options?: RequestInit & { maxSize?: number; timeout?: number }
): Promise<T> {
  const maxJsonSize = options?.maxSize ?? MAX_JSON_SIZE;
  const response = await safeFetch(url, { ...options, maxSize: maxJsonSize });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > maxJsonSize) {
        throw new Error(`Response exceeds max size: ${maxJsonSize} bytes`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const text = new TextDecoder().decode(combined);
  return JSON.parse(text);
}

export async function safeFetchBlob(
  url: string,
  options?: RequestInit & { maxSize?: number; timeout?: number }
): Promise<Uint8Array> {
  const maxBlobSize = options?.maxSize ?? MAX_BLOB_SIZE;
  const timeoutMs = options?.timeout ?? FETCH_TIMEOUT_BLOB;
  const response = await safeFetch(url, { ...options, maxSize: maxBlobSize, timeout: timeoutMs });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalSize += value.length;
      if (totalSize > maxBlobSize) {
        throw new Error(`Blob exceeds max size: ${maxBlobSize} bytes`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return combined;
}
