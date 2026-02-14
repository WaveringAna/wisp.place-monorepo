/**
 * Core file serving logic for the hosting service
 * Handles file retrieval, caching, redirects, and HTML rewriting
 */

import { lookup } from 'mime-types';
import { gunzipSync } from 'zlib';
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings';
import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression';
import { getCachedSettings } from './utils';
import { loadRedirectRules, matchRedirectRule, parseCookies, parseQueryString } from './redirects';
import { isHtmlContent } from './html-rewriter';
import { generate404Page, generateDirectoryListing } from './page-generators';
import { getIndexFiles, applyCustomHeaders } from './request-utils';
import { getRedirectRulesFromCache, setRedirectRulesInCache } from './site-cache';
import { storage } from './storage';
import { getSiteCache } from './db';
import { enqueueRevalidate } from './revalidate-queue';
import { recordStorageMiss } from './revalidate-metrics';
import { normalizeFileCids } from '@wispplace/fs-utils';
import { fetchAndCacheSite } from './on-demand-cache';
import type { StorageResult } from '@wispplace/tiered-storage';
import { createLogger } from '@wispplace/observability';

const logger = createLogger('file-serving');

type FileStorageResult = StorageResult<Uint8Array>;

/**
 * Helper to retrieve a file with metadata from tiered storage
 * Logs which tier the file was served from
 */
async function getFileWithMetadata(did: string, rkey: string, filePath: string) {
  const key = `${did}/${rkey}/${filePath}`;
  const result = await storage.getWithMetadata(key);

  if (result) {
    const tier = result.source || 'unknown';
    const size = result.data ? (result.data as Uint8Array).length : 0;
    logger.debug(`Served ${filePath} from ${tier} tier`, { did, rkey, size, tier });
  }

  return result;
}

function buildStorageKey(did: string, rkey: string, filePath: string): string {
  const normalized = filePath.startsWith('/') ? filePath.slice(1) : filePath;
  return `${did}/${rkey}/${normalized}`;
}

async function storageExists(did: string, rkey: string, filePath: string): Promise<boolean> {
  const key = buildStorageKey(did, rkey, filePath);
  return storage.exists(key);
}

function buildStorageMissResponse(): Response {
  return new Response('Storage temporarily unavailable', {
    status: 503,
    headers: {
      'Cache-Control': 'no-store',
      'Retry-After': '5',
    },
  });
}

async function listDirectoryEntries(
  did: string,
  rkey: string,
  requestPath: string
): Promise<Array<{ name: string; isDirectory: boolean }>> {
  const prefix = buildStorageKey(did, rkey, requestPath ? `${requestPath}/` : '');
  const entries = new Map<string, boolean>();

  for await (const key of storage.listKeys(prefix)) {
    const relative = key.slice(prefix.length);
    if (!relative) continue;
    if (relative.startsWith('.rewritten/')) continue;

    const [name, ...rest] = relative.split('/');
    if (!name || name === '.metadata.json' || name.endsWith('.meta')) continue;

    const isDirectory = rest.length > 0;
    const existing = entries.get(name);
    if (existing === undefined || (isDirectory && !existing)) {
      entries.set(name, isDirectory);
    }
  }

  return Array.from(entries.entries()).map(([name, isDirectory]) => ({ name, isDirectory }));
}

async function getFileForRequest(
  did: string,
  rkey: string,
  filePath: string,
  preferRewrittenHtml: boolean
): Promise<{ result: FileStorageResult; filePath: string } | null> {
  const mimeTypeGuess = lookup(filePath) || 'application/octet-stream';
  if (preferRewrittenHtml && isHtmlContent(filePath, mimeTypeGuess)) {
    const rewrittenPath = `.rewritten/${filePath}`;
    const rewritten = await getFileWithMetadata(did, rkey, rewrittenPath);
    if (rewritten) {
      return { result: rewritten, filePath };
    }
  }

  const result = await getFileWithMetadata(did, rkey, filePath);
  if (!result) return null;
  return { result, filePath };
}

function buildResponseFromStorageResult(
  result: FileStorageResult,
  filePath: string,
  settings: WispSettings | null,
  requestHeaders?: Record<string, string>
): Response {
  const content = Buffer.from(result.data);
  const meta = result.metadata.customMetadata as { encoding?: string; mimeType?: string } | undefined;
  const mimeType = meta?.mimeType || lookup(filePath) || 'application/octet-stream';

  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Cache-Control': mimeType.startsWith('text/html')
      ? 'public, max-age=300'
      : 'public, max-age=31536000, immutable',
    'X-Cache-Tier': result.source,
  };

  if (meta?.encoding === 'gzip') {
    const shouldServeCompressed = shouldCompressMimeType(mimeType);
    const acceptEncoding = requestHeaders?.['accept-encoding'] ?? '';
    const clientAcceptsGzip = acceptEncoding.includes('gzip');
    const hasGzipMagic = content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;

    if (!clientAcceptsGzip || !shouldServeCompressed) {
      if (hasGzipMagic) {
        const decompressed = gunzipSync(content);
        applyCustomHeaders(headers, filePath, settings);
        return new Response(decompressed, { headers });
      }
      logger.warn(`File marked as gzipped but lacks magic bytes, serving as-is`, { filePath });
      applyCustomHeaders(headers, filePath, settings);
      return new Response(content, { headers });
    }

    headers['Content-Encoding'] = 'gzip';
  }

  applyCustomHeaders(headers, filePath, settings);
  return new Response(content, { headers });
}

/**
 * Helper to serve files from cache (for custom domains and subdomains)
 */
export async function serveFromCache(
  did: string,
  rkey: string,
  filePath: string,
  fullUrl?: string,
  headers?: Record<string, string>
): Promise<Response> {
  // Load settings for this site
  const settings = await getCachedSettings(did, rkey);
  const indexFiles = getIndexFiles(settings);

  // Check for redirect rules first (_redirects wins over settings)
  let redirectRules = getRedirectRulesFromCache(did, rkey);

  if (redirectRules === null) {
    // Load rules (not in cache or evicted)
    redirectRules = await loadRedirectRules(did, rkey);
    setRedirectRulesInCache(did, rkey, redirectRules);
  }

  // Apply redirect rules if any exist
  if (redirectRules.length > 0) {
    const requestPath = '/' + (filePath || '');
    const queryParams = fullUrl ? parseQueryString(fullUrl) : {};
    const cookies = parseCookies(headers?.['cookie']);

    const redirectMatch = matchRedirectRule(requestPath, redirectRules, {
      queryParams,
      headers,
      cookies,
    });

    if (redirectMatch) {
      const { rule, targetPath, status } = redirectMatch;

      // If not forced, check if the requested file exists before redirecting
      if (!rule.force) {
        // Build the expected file path
        let checkPath: string = filePath || indexFiles[0] || 'index.html';
        if (checkPath.endsWith('/')) {
          checkPath += indexFiles[0] || 'index.html';
        }

        const fileExistsInStorage = await storageExists(did, rkey, checkPath);

        // If file exists and redirect is not forced, serve the file normally
        if (fileExistsInStorage) {
          return serveFileInternal(did, rkey, filePath, settings, headers);
        }
      }

      // Handle different status codes
      if (status === 200) {
        // Rewrite: serve different content but keep URL the same
        // Remove leading slash for internal path resolution
        const rewritePath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        return serveFileInternal(did, rkey, rewritePath, settings, headers);
      } else if (status === 301 || status === 302) {
        // External redirect: change the URL
        return new Response(null, {
          status,
          headers: {
            'Location': targetPath,
            'Cache-Control': status === 301 ? 'public, max-age=31536000' : 'public, max-age=0',
          },
        });
      } else if (status === 404) {
        // Custom 404 page from _redirects (wins over settings.custom404)
        const custom404Path = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        const response = await serveFileInternal(did, rkey, custom404Path, settings, headers);
        // Override status to 404
        return new Response(response.body, {
          status: 404,
          headers: response.headers,
        });
      }
    }
  }

  // No redirect matched, serve normally with settings
  return serveFileInternal(did, rkey, filePath, settings, headers);
}

/**
 * Internal function to serve a file (used by both normal serving and rewrites)
 */
export async function serveFileInternal(
  did: string,
  rkey: string,
  filePath: string,
  settings: WispSettings | null = null,
  requestHeaders?: Record<string, string>
): Promise<Response> {
  let expectedFileCids: Record<string, string> | null | undefined;
  let expectedMissPath: string | null = null;

  const getExpectedFileCids = async (): Promise<Record<string, string> | null> => {
    if (expectedFileCids !== undefined) return expectedFileCids;
    const siteCache = await getSiteCache(did, rkey);
    if (!siteCache) {
      expectedFileCids = null;
      return null;
    }
    expectedFileCids = normalizeFileCids(siteCache.file_cids).value;
    return expectedFileCids;
  };

  const markExpectedMiss = async (path: string) => {
    if (expectedMissPath) return;
    const fileCids = await getExpectedFileCids();
    if (!fileCids) return;
    const normalized = path.startsWith('/') ? path.slice(1) : path;
    if (fileCids[normalized]) {
      expectedMissPath = normalized;
    }
  };

  const maybeReturnStorageMiss = async (): Promise<Response | null> => {
    if (!expectedMissPath) return null;
    recordStorageMiss(expectedMissPath);
    await enqueueRevalidate(did, rkey, `storage-miss:${expectedMissPath}`);
    return buildStorageMissResponse();
  };

  const indexFiles = getIndexFiles(settings);

  // Normalize the request path (keep empty for root, remove trailing slash for others)
  let requestPath = filePath || '';
  if (requestPath.endsWith('/') && requestPath.length > 1) {
    requestPath = requestPath.slice(0, -1);
  }

  // For directory-like paths (empty or no extension), try index files FIRST (fast)
  // Only do expensive directory listing if needed for directory listing feature
  if (!requestPath || !requestPath.includes('.')) {
    for (const indexFile of indexFiles) {
      const indexPath = requestPath ? `${requestPath}/${indexFile}` : indexFile;
      const result = await getFileWithMetadata(did, rkey, indexPath);
      if (result) {
        return buildResponseFromStorageResult(result, indexPath, settings, requestHeaders);
      }
      await markExpectedMiss(indexPath);
    }

    // Index not found - check if we need directory listing
    if (settings?.directoryListing) {
      const directoryEntries = await listDirectoryEntries(did, rkey, requestPath);
      if (directoryEntries.length > 0) {
        const missResponse = await maybeReturnStorageMiss();
        if (missResponse) return missResponse;
        const html = generateDirectoryListing(requestPath, directoryEntries);
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }
    }
    // Fall through to normal file serving / 404 handling
  }

  // Not a directory, try to serve as a file
  const fileRequestPath: string = requestPath || indexFiles[0] || 'index.html';

  // Retrieve from tiered storage
  const result = await getFileWithMetadata(did, rkey, fileRequestPath);

  if (result) {
    return buildResponseFromStorageResult(result, fileRequestPath, settings, requestHeaders);
  }
  await markExpectedMiss(fileRequestPath);

  // Try index files for directory-like paths
  if (!fileRequestPath.includes('.')) {
    for (const indexFileName of indexFiles) {
      const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName;

      const indexResult = await getFileWithMetadata(did, rkey, indexPath);

      if (indexResult) {
        const indexContent = Buffer.from(indexResult.data);
        const indexMeta = indexResult.metadata.customMetadata as { encoding?: string; mimeType?: string } | undefined;

        const headers: Record<string, string> = {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'X-Cache-Tier': indexResult.source,
        };

        if (indexMeta?.encoding === 'gzip') {
          headers['Content-Encoding'] = 'gzip';
        }

        applyCustomHeaders(headers, indexPath, settings);
        return new Response(indexContent, { headers });
      }
      await markExpectedMiss(indexPath);
    }
  }

  // Try clean URLs: /about -> /about.html
  if (settings?.cleanUrls && !fileRequestPath.includes('.')) {
    const htmlPath = `${fileRequestPath}.html`;
    if (await storageExists(did, rkey, htmlPath)) {
      return serveFileInternal(did, rkey, htmlPath, settings, requestHeaders);
    }
    await markExpectedMiss(htmlPath);

    // Also try /about/index.html
    for (const indexFileName of indexFiles) {
      const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName;
      if (await storageExists(did, rkey, indexPath)) {
        return serveFileInternal(did, rkey, indexPath, settings, requestHeaders);
      }
      await markExpectedMiss(indexPath);
    }
  }

  // SPA mode: serve SPA file for all non-existing routes (wins over custom404 but loses to _redirects)
  if (settings?.spaMode) {
    const spaFile = settings.spaMode;
    if (await storageExists(did, rkey, spaFile)) {
      return serveFileInternal(did, rkey, spaFile, settings, requestHeaders);
    }
    await markExpectedMiss(spaFile);
  }

  // Custom 404: serve custom 404 file if configured (wins conflict battle)
  if (settings?.custom404) {
    const custom404File = settings.custom404;
    if (await storageExists(did, rkey, custom404File)) {
      const response: Response = await serveFileInternal(did, rkey, custom404File, settings, requestHeaders);
      // Override status to 404
      return new Response(response.body, {
        status: 404,
        headers: response.headers,
      });
    }
    await markExpectedMiss(custom404File);
  }

  // Autodetect 404 pages (GitHub Pages: 404.html, Neocities/Nekoweb: not_found.html)
  const auto404Pages = ['404.html', 'not_found.html'];
  for (const auto404Page of auto404Pages) {
    if (await storageExists(did, rkey, auto404Page)) {
      const response: Response = await serveFileInternal(did, rkey, auto404Page, settings, requestHeaders);
      // Override status to 404
      return new Response(response.body, {
        status: 404,
        headers: response.headers,
      });
    }
    await markExpectedMiss(auto404Page);
  }

  // Directory listing fallback: if enabled, show root directory listing on 404
  if (settings?.directoryListing) {
    const rootEntries = await listDirectoryEntries(did, rkey, '');
    if (rootEntries.length > 0) {
      const missResponse = await maybeReturnStorageMiss();
      if (missResponse) return missResponse;
      const html = generateDirectoryListing('', rootEntries);
      return new Response(html, {
        status: 404,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
  }

  const missResponse = await maybeReturnStorageMiss();
  if (missResponse) return missResponse;

  // Last resort: if site not in DB at all, try on-demand fetch
  const fileCids = await getExpectedFileCids();
  if (fileCids === null) {
    logger.info(`Site not found in DB, attempting on-demand fetch before 404`, { did, rkey });
    const success = await fetchAndCacheSite(did, rkey);
    if (success) {
      // Retry serving the originally requested file
      const retryPath = filePath || indexFiles[0] || 'index.html';
      const retryResult = await getFileWithMetadata(did, rkey, retryPath);
      if (retryResult) {
        return buildResponseFromStorageResult(retryResult, retryPath, settings, requestHeaders);
      }
    }
  }

  // Default styled 404 page
  const html = generate404Page();
  return new Response(html, {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

/**
 * Helper to serve files from cache with HTML path rewriting for sites.wisp.place routes
 */
export async function serveFromCacheWithRewrite(
  did: string,
  rkey: string,
  filePath: string,
  basePath: string,
  fullUrl?: string,
  headers?: Record<string, string>
): Promise<Response> {
  // Load settings for this site
  const settings = await getCachedSettings(did, rkey);
  const indexFiles = getIndexFiles(settings);

  // Check for redirect rules first (_redirects wins over settings)
  let redirectRules = getRedirectRulesFromCache(did, rkey);

  if (redirectRules === null) {
    // Load rules (not in cache or evicted)
    redirectRules = await loadRedirectRules(did, rkey);
    setRedirectRulesInCache(did, rkey, redirectRules);
  }

  // Apply redirect rules if any exist
  if (redirectRules.length > 0) {
    const requestPath = '/' + (filePath || '');
    const queryParams = fullUrl ? parseQueryString(fullUrl) : {};
    const cookies = parseCookies(headers?.['cookie']);

    const redirectMatch = matchRedirectRule(requestPath, redirectRules, {
      queryParams,
      headers,
      cookies,
    });

    if (redirectMatch) {
      const { rule, targetPath, status } = redirectMatch;

      // If not forced, check if the requested file exists before redirecting
      if (!rule.force) {
        // Build the expected file path
        let checkPath: string = filePath || indexFiles[0] || 'index.html';
        if (checkPath.endsWith('/')) {
          checkPath += indexFiles[0] || 'index.html';
        }

        const fileExistsInStorage = await storageExists(did, rkey, checkPath);

        // If file exists and redirect is not forced, serve the file normally
        if (fileExistsInStorage) {
          return serveFileInternalWithRewrite(did, rkey, filePath, basePath, settings, headers);
        }
      }

      // Handle different status codes
      if (status === 200) {
        // Rewrite: serve different content but keep URL the same
        const rewritePath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        return serveFileInternalWithRewrite(did, rkey, rewritePath, basePath, settings, headers);
      } else if (status === 301 || status === 302) {
        // External redirect: change the URL
        // For sites.wisp.place, we need to adjust the target path to include the base path
        // unless it's an absolute URL
        let redirectTarget = targetPath;
        if (!targetPath.startsWith('http://') && !targetPath.startsWith('https://')) {
          redirectTarget = basePath + (targetPath.startsWith('/') ? targetPath.slice(1) : targetPath);
        }
        return new Response(null, {
          status,
          headers: {
            'Location': redirectTarget,
            'Cache-Control': status === 301 ? 'public, max-age=31536000' : 'public, max-age=0',
          },
        });
      } else if (status === 404) {
        // Custom 404 page from _redirects (wins over settings.custom404)
        const custom404Path = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        const response = await serveFileInternalWithRewrite(did, rkey, custom404Path, basePath, settings, headers);
        // Override status to 404
        return new Response(response.body, {
          status: 404,
          headers: response.headers,
        });
      }
    }
  }

  // No redirect matched, serve normally with settings
  return serveFileInternalWithRewrite(did, rkey, filePath, basePath, settings, headers);
}

/**
 * Internal function to serve a file with rewriting
 */
export async function serveFileInternalWithRewrite(
  did: string,
  rkey: string,
  filePath: string,
  basePath: string,
  settings: WispSettings | null = null,
  requestHeaders?: Record<string, string>
): Promise<Response> {
  let expectedFileCids: Record<string, string> | null | undefined;
  let expectedMissPath: string | null = null;

  const getExpectedFileCids = async (): Promise<Record<string, string> | null> => {
    if (expectedFileCids !== undefined) return expectedFileCids;
    const siteCache = await getSiteCache(did, rkey);
    if (!siteCache) {
      expectedFileCids = null;
      return null;
    }
    expectedFileCids = normalizeFileCids(siteCache.file_cids).value;
    return expectedFileCids;
  };

  const markExpectedMiss = async (path: string) => {
    if (expectedMissPath) return;
    const fileCids = await getExpectedFileCids();
    if (!fileCids) return;
    const normalized = path.startsWith('/') ? path.slice(1) : path;
    if (fileCids[normalized]) {
      expectedMissPath = normalized;
    }
  };

  const maybeReturnStorageMiss = async (): Promise<Response | null> => {
    if (!expectedMissPath) return null;
    recordStorageMiss(expectedMissPath);
    await enqueueRevalidate(did, rkey, `storage-miss:${expectedMissPath}`);
    return buildStorageMissResponse();
  };

  const indexFiles = getIndexFiles(settings);

  // Normalize the request path (keep empty for root, remove trailing slash for others)
  let requestPath = filePath || '';
  if (requestPath.endsWith('/') && requestPath.length > 1) {
    requestPath = requestPath.slice(0, -1);
  }

  // For directory-like paths (empty or no extension), try index files FIRST (fast)
  // Only do expensive directory listing if needed for directory listing feature
  if (!requestPath || !requestPath.includes('.')) {
    for (const indexFile of indexFiles) {
      const indexPath = requestPath ? `${requestPath}/${indexFile}` : indexFile;
      const fileResult = await getFileForRequest(did, rkey, indexPath, true);
      if (fileResult) {
        return buildResponseFromStorageResult(fileResult.result, indexPath, settings, requestHeaders);
      }
      await markExpectedMiss(indexPath);
    }

    // Index not found - check if we need directory listing
    if (settings?.directoryListing) {
      const directoryEntries = await listDirectoryEntries(did, rkey, requestPath);
      if (directoryEntries.length > 0) {
        const missResponse = await maybeReturnStorageMiss();
        if (missResponse) return missResponse;
        const html = generateDirectoryListing(requestPath, directoryEntries);
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=300',
          },
        });
      }
    }
    // Fall through to normal file serving / 404 handling
  }

  // Not a directory, try to serve as a file
  const fileRequestPath: string = requestPath || indexFiles[0] || 'index.html';

  const fileResult = await getFileForRequest(did, rkey, fileRequestPath, true);
  if (fileResult) {
    return buildResponseFromStorageResult(fileResult.result, fileRequestPath, settings, requestHeaders);
  }
  await markExpectedMiss(fileRequestPath);

  // Try index files for directory-like paths
  if (!fileRequestPath.includes('.')) {
    for (const indexFileName of indexFiles) {
      const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName;
      const indexResult = await getFileForRequest(did, rkey, indexPath, true);
      if (indexResult) {
        return buildResponseFromStorageResult(indexResult.result, indexPath, settings, requestHeaders);
      }
      await markExpectedMiss(indexPath);
    }
  }

  // Try clean URLs: /about -> /about.html
  if (settings?.cleanUrls && !fileRequestPath.includes('.')) {
    const htmlPath = `${fileRequestPath}.html`;
    if (await storageExists(did, rkey, htmlPath)) {
      return serveFileInternalWithRewrite(did, rkey, htmlPath, basePath, settings, requestHeaders);
    }
    await markExpectedMiss(htmlPath);

    // Also try /about/index.html
    for (const indexFileName of indexFiles) {
      const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName;
      if (await storageExists(did, rkey, indexPath)) {
        return serveFileInternalWithRewrite(did, rkey, indexPath, basePath, settings, requestHeaders);
      }
      await markExpectedMiss(indexPath);
    }
  }

  // SPA mode: serve SPA file for all non-existing routes
  if (settings?.spaMode) {
    const spaFile = settings.spaMode;
    if (await storageExists(did, rkey, spaFile)) {
      return serveFileInternalWithRewrite(did, rkey, spaFile, basePath, settings, requestHeaders);
    }
    await markExpectedMiss(spaFile);
  }

  // Custom 404: serve custom 404 file if configured (wins conflict battle)
  if (settings?.custom404) {
    const custom404File = settings.custom404;
    if (await storageExists(did, rkey, custom404File)) {
      const response: Response = await serveFileInternalWithRewrite(did, rkey, custom404File, basePath, settings, requestHeaders);
      // Override status to 404
      return new Response(response.body, {
        status: 404,
        headers: response.headers,
      });
    }
    await markExpectedMiss(custom404File);
  }

  // Autodetect 404 pages (GitHub Pages: 404.html, Neocities/Nekoweb: not_found.html)
  const auto404Pages = ['404.html', 'not_found.html'];
  for (const auto404Page of auto404Pages) {
    if (await storageExists(did, rkey, auto404Page)) {
      const response: Response = await serveFileInternalWithRewrite(did, rkey, auto404Page, basePath, settings, requestHeaders);
      // Override status to 404
      return new Response(response.body, {
        status: 404,
        headers: response.headers,
      });
    }
    await markExpectedMiss(auto404Page);
  }

  // Directory listing fallback: if enabled, show root directory listing on 404
  if (settings?.directoryListing) {
    const rootEntries = await listDirectoryEntries(did, rkey, '');
    if (rootEntries.length > 0) {
      const missResponse = await maybeReturnStorageMiss();
      if (missResponse) return missResponse;
      const html = generateDirectoryListing('', rootEntries);
      return new Response(html, {
        status: 404,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
  }

  const missResponse = await maybeReturnStorageMiss();
  if (missResponse) return missResponse;

  // Last resort: if site not in DB at all, try on-demand fetch
  const fileCids = await getExpectedFileCids();
  if (fileCids === null) {
    logger.info(`Site not found in DB, attempting on-demand fetch before 404`, { did, rkey });
    const success = await fetchAndCacheSite(did, rkey);
    if (success) {
      // Retry serving the originally requested file
      const retryPath = filePath || indexFiles[0] || 'index.html';
      const retryResult = await getFileWithMetadata(did, rkey, retryPath);
      if (retryResult) {
        return buildResponseFromStorageResult(retryResult, retryPath, settings, requestHeaders);
      }
    }
  }

  // Default styled 404 page
  const html = generate404Page();
  return new Response(html, {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
