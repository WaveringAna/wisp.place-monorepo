/**
 * Core file serving logic for the hosting service
 * Handles file retrieval, caching, redirects, and HTML rewriting
 */

import { readFile } from 'fs/promises';
import { lookup } from 'mime-types';
import type { Record as WispSettings } from '@wisp/lexicons/types/place/wisp/settings';
import { shouldCompressMimeType } from '@wisp/atproto-utils/compression';
import { rewrittenHtmlCache, getCacheKey, isSiteBeingCached } from './cache';
import { getCachedFilePath, getCachedSettings } from './utils';
import { loadRedirectRules, matchRedirectRule, parseCookies, parseQueryString } from './redirects';
import { rewriteHtmlPaths, isHtmlContent } from './html-rewriter';
import { generate404Page, generateDirectoryListing, siteUpdatingResponse } from './page-generators';
import { getIndexFiles, applyCustomHeaders, fileExists } from './request-utils';
import { getRedirectRulesFromCache, setRedirectRulesInCache } from './site-cache';
import { storage } from './storage';

/**
 * Helper to retrieve a file with metadata from tiered storage
 * Logs which tier the file was served from
 */
async function getFileWithMetadata(did: string, rkey: string, filePath: string) {
  const key = `${did}/${rkey}/${filePath}`;
  const result = await storage.getWithMetadata(key);

  if (result) {
    const metadata = result.metadata;
    const tier =
      metadata && typeof metadata === 'object' && 'tier' in metadata
        ? String((metadata as Record<string, unknown>).tier)
        : 'unknown';
    const size = result.data ? (result.data as Uint8Array).length : 0;
    console.log(`[Storage] Served ${filePath} from ${tier} tier (${size} bytes) - ${did}:${rkey}`);
  }

  return result;
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

        const cachedFile = getCachedFilePath(did, rkey, checkPath);
        const fileExistsOnDisk = await fileExists(cachedFile);

        // If file exists and redirect is not forced, serve the file normally
        if (fileExistsOnDisk) {
          return serveFileInternal(did, rkey, filePath, settings);
        }
      }

      // Handle different status codes
      if (status === 200) {
        // Rewrite: serve different content but keep URL the same
        // Remove leading slash for internal path resolution
        const rewritePath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        return serveFileInternal(did, rkey, rewritePath, settings);
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
        const response = await serveFileInternal(did, rkey, custom404Path, settings);
        // Override status to 404
        return new Response(response.body, {
          status: 404,
          headers: response.headers,
        });
      }
    }
  }

  // No redirect matched, serve normally with settings
  return serveFileInternal(did, rkey, filePath, settings);
}

/**
 * Internal function to serve a file (used by both normal serving and rewrites)
 */
export async function serveFileInternal(
  did: string,
  rkey: string,
  filePath: string,
  settings: WispSettings | null = null
): Promise<Response> {
  // Check if site is currently being cached - if so, return updating response
  if (isSiteBeingCached(did, rkey)) {
    return siteUpdatingResponse();
  }

  const indexFiles = getIndexFiles(settings);

  // Normalize the request path (keep empty for root, remove trailing slash for others)
  let requestPath = filePath || '';
  if (requestPath.endsWith('/') && requestPath.length > 1) {
    requestPath = requestPath.slice(0, -1);
  }

  // Check if this path is a directory first
  const directoryPath = getCachedFilePath(did, rkey, requestPath);
  if (await fileExists(directoryPath)) {
    const { stat, readdir } = await import('fs/promises');
    try {
      const stats = await stat(directoryPath);
      if (stats.isDirectory()) {
        // It's a directory, try each index file in order
        for (const indexFile of indexFiles) {
          const indexPath = requestPath ? `${requestPath}/${indexFile}` : indexFile;
          const indexFilePath = getCachedFilePath(did, rkey, indexPath);
          if (await fileExists(indexFilePath)) {
            return serveFileInternal(did, rkey, indexPath, settings);
          }
        }
        // No index file found - check if directory listing is enabled
        if (settings?.directoryListing) {
          const { stat } = await import('fs/promises');
          const entries = await readdir(directoryPath);
          // Filter out .meta files and other hidden files
          const visibleEntries = entries.filter(entry => !entry.endsWith('.meta') && entry !== '.metadata.json');

          // Check which entries are directories
          const entriesWithType = await Promise.all(
            visibleEntries.map(async (name) => {
              try {
                const entryPath = `${directoryPath}/${name}`;
                const stats = await stat(entryPath);
                return { name, isDirectory: stats.isDirectory() };
              } catch {
                return { name, isDirectory: false };
              }
            })
          );

          const html = generateDirectoryListing(requestPath, entriesWithType);
          return new Response(html, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=300',
            },
          });
        }
        // Fall through to 404/SPA handling
      }
    } catch (err) {
      // If stat fails, continue with normal flow
    }
  }

  // Not a directory, try to serve as a file
  const fileRequestPath: string = requestPath || indexFiles[0] || 'index.html';

  // Retrieve from tiered storage
  const result = await getFileWithMetadata(did, rkey, fileRequestPath);

  if (result) {
    const content = Buffer.from(result.data);
    const meta = result.metadata.customMetadata as { encoding?: string; mimeType?: string } | undefined;

    // Build headers with caching
    const headers: Record<string, string> = {
      'X-Cache-Tier': result.source,
    };

    if (meta?.encoding === 'gzip' && meta.mimeType) {
      const shouldServeCompressed = shouldCompressMimeType(meta.mimeType);

      if (!shouldServeCompressed) {
        // Verify content is actually gzipped before attempting decompression
        const isGzipped = content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
        if (isGzipped) {
          const { gunzipSync } = await import('zlib');
          const decompressed = gunzipSync(content);
          headers['Content-Type'] = meta.mimeType;
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
          applyCustomHeaders(headers, fileRequestPath, settings);
          return new Response(decompressed, { headers });
        } else {
          // Meta says gzipped but content isn't - serve as-is
          console.warn(`File ${filePath} has gzip encoding in meta but content lacks gzip magic bytes`);
          headers['Content-Type'] = meta.mimeType;
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
          applyCustomHeaders(headers, fileRequestPath, settings);
          return new Response(content, { headers });
        }
      }

      headers['Content-Type'] = meta.mimeType;
      headers['Content-Encoding'] = 'gzip';
      headers['Cache-Control'] = meta.mimeType.startsWith('text/html')
        ? 'public, max-age=300'
        : 'public, max-age=31536000, immutable';
      applyCustomHeaders(headers, fileRequestPath, settings);
      return new Response(content, { headers });
    }

    // Non-compressed files
    const mimeType = meta?.mimeType || lookup(fileRequestPath) || 'application/octet-stream';
    headers['Content-Type'] = mimeType;
    headers['Cache-Control'] = mimeType.startsWith('text/html')
      ? 'public, max-age=300'
      : 'public, max-age=31536000, immutable';
    applyCustomHeaders(headers, fileRequestPath, settings);
    return new Response(content, { headers });
  }

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
    }
  }

  // Try clean URLs: /about -> /about.html
  if (settings?.cleanUrls && !fileRequestPath.includes('.')) {
    const htmlPath = `${fileRequestPath}.html`;
    const htmlFile = getCachedFilePath(did, rkey, htmlPath);
    if (await fileExists(htmlFile)) {
      return serveFileInternal(did, rkey, htmlPath, settings);
    }

    // Also try /about/index.html
    for (const indexFileName of indexFiles) {
      const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName;
      const indexFile = getCachedFilePath(did, rkey, indexPath);
      if (await fileExists(indexFile)) {
        return serveFileInternal(did, rkey, indexPath, settings);
      }
    }
  }

  // SPA mode: serve SPA file for all non-existing routes (wins over custom404 but loses to _redirects)
  if (settings?.spaMode) {
    const spaFile = settings.spaMode;
    const spaFilePath = getCachedFilePath(did, rkey, spaFile);
    if (await fileExists(spaFilePath)) {
      return serveFileInternal(did, rkey, spaFile, settings);
    }
  }

  // Custom 404: serve custom 404 file if configured (wins conflict battle)
  if (settings?.custom404) {
    const custom404File = settings.custom404;
    const custom404Path = getCachedFilePath(did, rkey, custom404File);
    if (await fileExists(custom404Path)) {
      const response: Response = await serveFileInternal(did, rkey, custom404File, settings);
      // Override status to 404
      return new Response(response.body, {
        status: 404,
        headers: response.headers,
      });
    }
  }

  // Autodetect 404 pages (GitHub Pages: 404.html, Neocities/Nekoweb: not_found.html)
  const auto404Pages = ['404.html', 'not_found.html'];
  for (const auto404Page of auto404Pages) {
    const auto404Path = getCachedFilePath(did, rkey, auto404Page);
    if (await fileExists(auto404Path)) {
      const response: Response = await serveFileInternal(did, rkey, auto404Page, settings);
      // Override status to 404
      return new Response(response.body, {
        status: 404,
        headers: response.headers,
      });
    }
  }

  // Directory listing fallback: if enabled, show root directory listing on 404
  if (settings?.directoryListing) {
    const rootPath = getCachedFilePath(did, rkey, '');
    if (await fileExists(rootPath)) {
      const { stat, readdir } = await import('fs/promises');
      try {
        const stats = await stat(rootPath);
        if (stats.isDirectory()) {
          const entries = await readdir(rootPath);
          // Filter out .meta files and metadata
          const visibleEntries = entries.filter(entry =>
            !entry.endsWith('.meta') && entry !== '.metadata.json'
          );

          // Check which entries are directories
          const entriesWithType = await Promise.all(
            visibleEntries.map(async (name) => {
              try {
                const entryPath = `${rootPath}/${name}`;
                const entryStats = await stat(entryPath);
                return { name, isDirectory: entryStats.isDirectory() };
              } catch {
                return { name, isDirectory: false };
              }
            })
          );

          const html = generateDirectoryListing('', entriesWithType);
          return new Response(html, {
            status: 404,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=300',
            },
          });
        }
      } catch (err) {
        // If directory listing fails, fall through to 404
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

        const cachedFile = getCachedFilePath(did, rkey, checkPath);
        const fileExistsOnDisk = await fileExists(cachedFile);

        // If file exists and redirect is not forced, serve the file normally
        if (fileExistsOnDisk) {
          return serveFileInternalWithRewrite(did, rkey, filePath, basePath, settings);
        }
      }

      // Handle different status codes
      if (status === 200) {
        // Rewrite: serve different content but keep URL the same
        const rewritePath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        return serveFileInternalWithRewrite(did, rkey, rewritePath, basePath, settings);
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
        const response = await serveFileInternalWithRewrite(did, rkey, custom404Path, basePath, settings);
        // Override status to 404
        return new Response(response.body, {
          status: 404,
          headers: response.headers,
        });
      }
    }
  }

  // No redirect matched, serve normally with settings
  return serveFileInternalWithRewrite(did, rkey, filePath, basePath, settings);
}

/**
 * Internal function to serve a file with rewriting
 */
export async function serveFileInternalWithRewrite(
  did: string,
  rkey: string,
  filePath: string,
  basePath: string,
  settings: WispSettings | null = null
): Promise<Response> {
  // Check if site is currently being cached - if so, return updating response
  if (isSiteBeingCached(did, rkey)) {
    return siteUpdatingResponse();
  }

  const indexFiles = getIndexFiles(settings);

  // Normalize the request path (keep empty for root, remove trailing slash for others)
  let requestPath = filePath || '';
  if (requestPath.endsWith('/') && requestPath.length > 1) {
    requestPath = requestPath.slice(0, -1);
  }

  // Check if this path is a directory first
  const directoryPath = getCachedFilePath(did, rkey, requestPath);
  if (await fileExists(directoryPath)) {
    const { stat, readdir } = await import('fs/promises');
    try {
      const stats = await stat(directoryPath);
      if (stats.isDirectory()) {
        // It's a directory, try each index file in order
        for (const indexFile of indexFiles) {
          const indexPath = requestPath ? `${requestPath}/${indexFile}` : indexFile;
          const indexFilePath = getCachedFilePath(did, rkey, indexPath);
          if (await fileExists(indexFilePath)) {
            return serveFileInternalWithRewrite(did, rkey, indexPath, basePath, settings);
          }
        }
        // No index file found - check if directory listing is enabled
        if (settings?.directoryListing) {
          const { stat } = await import('fs/promises');
          const entries = await readdir(directoryPath);
          // Filter out .meta files and other hidden files
          const visibleEntries = entries.filter(entry => !entry.endsWith('.meta') && entry !== '.metadata.json');

          // Check which entries are directories
          const entriesWithType = await Promise.all(
            visibleEntries.map(async (name) => {
              try {
                const entryPath = `${directoryPath}/${name}`;
                const stats = await stat(entryPath);
                return { name, isDirectory: stats.isDirectory() };
              } catch {
                return { name, isDirectory: false };
              }
            })
          );

          const html = generateDirectoryListing(requestPath, entriesWithType);
          return new Response(html, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=300',
            },
          });
        }
        // Fall through to 404/SPA handling
      }
    } catch (err) {
      // If stat fails, continue with normal flow
    }
  }

  // Not a directory, try to serve as a file
  const fileRequestPath: string = requestPath || indexFiles[0] || 'index.html';

  // Check for rewritten HTML in cache first (if it's HTML)
  const mimeTypeGuess = lookup(fileRequestPath) || 'application/octet-stream';
  if (isHtmlContent(fileRequestPath, mimeTypeGuess)) {
    const rewrittenKey = getCacheKey(did, rkey, fileRequestPath, `rewritten:${basePath}`);
    const rewrittenContent = rewrittenHtmlCache.get(rewrittenKey);
    if (rewrittenContent) {
      console.log(`[HTML Rewrite] Serving from rewritten cache: ${rewrittenKey}`);
      const headers: Record<string, string> = {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'public, max-age=300',
        'X-Cache-Tier': 'local', // Rewritten HTML is stored locally
      };
      applyCustomHeaders(headers, fileRequestPath, settings);
      return new Response(rewrittenContent, { headers });
    }
  }

  // Retrieve from tiered storage
  const result = await getFileWithMetadata(did, rkey, fileRequestPath);

  if (result) {
    const content = Buffer.from(result.data);
    const meta = result.metadata.customMetadata as { encoding?: string; mimeType?: string } | undefined;
    const mimeType = meta?.mimeType || lookup(fileRequestPath) || 'application/octet-stream';
    const isGzipped = meta?.encoding === 'gzip';

    console.log(`[File Serve] Serving ${fileRequestPath}, mimeType: ${mimeType}, isHTML: ${isHtmlContent(fileRequestPath, mimeType)}, basePath: ${basePath}`);

    // Check if this is HTML content that needs rewriting
    if (isHtmlContent(fileRequestPath, mimeType)) {
      console.log(`[HTML Rewrite] Processing ${fileRequestPath}, basePath: ${basePath}, mimeType: ${mimeType}, isGzipped: ${isGzipped}`);
      let htmlContent: string;
      if (isGzipped) {
        // Verify content is actually gzipped
        const hasGzipMagic = content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
        if (hasGzipMagic) {
          const { gunzipSync } = await import('zlib');
          htmlContent = gunzipSync(content).toString('utf-8');
        } else {
          console.warn(`File ${fileRequestPath} marked as gzipped but lacks magic bytes, serving as-is`);
          htmlContent = content.toString('utf-8');
        }
      } else {
        htmlContent = content.toString('utf-8');
      }
      // Check for <base> tag which can override paths
      const baseTagMatch = htmlContent.match(/<base\s+[^>]*href=["'][^"']+["'][^>]*>/i);
      if (baseTagMatch) {
        console.warn(`[HTML Rewrite] WARNING: <base> tag found: ${baseTagMatch[0]} - this may override path rewrites`);
      }

      // Find src/href attributes (quoted and unquoted) to debug
      const allMatches = htmlContent.match(/(?:src|href)\s*=\s*["']?\/[^"'\s>]+/g);
      console.log(`[HTML Rewrite] Found ${allMatches ? allMatches.length : 0} local path attrs`);
      if (allMatches && allMatches.length > 0) {
        console.log(`[HTML Rewrite] Sample paths: ${allMatches.slice(0, 5).join(', ')}`);
      }

      const rewritten = rewriteHtmlPaths(htmlContent, basePath, fileRequestPath);

      const rewrittenMatches = rewritten.match(/(?:src|href)\s*=\s*["']?\/[^"'\s>]+/g);
      console.log(`[HTML Rewrite] After rewrite, found ${rewrittenMatches ? rewrittenMatches.length : 0} local paths`);
      if (rewrittenMatches && rewrittenMatches.length > 0) {
        console.log(`[HTML Rewrite] Sample rewritten: ${rewrittenMatches.slice(0, 5).join(', ')}`);
      }

      // Recompress and cache the rewritten HTML
      const { gzipSync } = await import('zlib');
      const recompressed = gzipSync(Buffer.from(rewritten, 'utf-8'));

      const rewrittenKey = getCacheKey(did, rkey, fileRequestPath, `rewritten:${basePath}`);
      rewrittenHtmlCache.set(rewrittenKey, recompressed, recompressed.length);

      const htmlHeaders: Record<string, string> = {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'public, max-age=300',
        'X-Cache-Tier': result.source,
      };
      applyCustomHeaders(htmlHeaders, fileRequestPath, settings);
      return new Response(recompressed, { headers: htmlHeaders });
    }

    // Non-HTML files: serve as-is
    const headers: Record<string, string> = {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Cache-Tier': result.source,
    };

    if (isGzipped) {
      const shouldServeCompressed = shouldCompressMimeType(mimeType);
      if (!shouldServeCompressed) {
        // Verify content is actually gzipped
        const hasGzipMagic = content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
        if (hasGzipMagic) {
          const { gunzipSync } = await import('zlib');
          const decompressed = gunzipSync(content);
          applyCustomHeaders(headers, fileRequestPath, settings);
          return new Response(decompressed, { headers });
        } else {
          console.warn(`File ${fileRequestPath} marked as gzipped but lacks magic bytes, serving as-is`);
          applyCustomHeaders(headers, fileRequestPath, settings);
          return new Response(content, { headers });
        }
      }
      headers['Content-Encoding'] = 'gzip';
    }

    applyCustomHeaders(headers, fileRequestPath, settings);
    return new Response(content, { headers });
  }

  // Try index files for directory-like paths
  if (!fileRequestPath.includes('.')) {
    for (const indexFileName of indexFiles) {
      const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName;

      // Check for rewritten index file in cache
      const rewrittenKey = getCacheKey(did, rkey, indexPath, `rewritten:${basePath}`);
      const rewrittenContent = rewrittenHtmlCache.get(rewrittenKey);
      if (rewrittenContent) {
        const headers: Record<string, string> = {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=300',
          'X-Cache-Tier': 'local', // Rewritten HTML is stored locally
        };
        applyCustomHeaders(headers, indexPath, settings);
        return new Response(rewrittenContent, { headers });
      }

      const indexResult = await getFileWithMetadata(did, rkey, indexPath);

      if (indexResult) {
        const indexContent = Buffer.from(indexResult.data);
        const indexMeta = indexResult.metadata.customMetadata as { encoding?: string; mimeType?: string } | undefined;
        const isGzipped = indexMeta?.encoding === 'gzip';

        let htmlContent: string;
        if (isGzipped) {
          // Verify content is actually gzipped
          const hasGzipMagic = indexContent.length >= 2 && indexContent[0] === 0x1f && indexContent[1] === 0x8b;
          if (hasGzipMagic) {
            const { gunzipSync } = await import('zlib');
            htmlContent = gunzipSync(indexContent).toString('utf-8');
          } else {
            console.warn(`Index file marked as gzipped but lacks magic bytes, serving as-is`);
            htmlContent = indexContent.toString('utf-8');
          }
        } else {
          htmlContent = indexContent.toString('utf-8');
        }
        const rewritten = rewriteHtmlPaths(htmlContent, basePath, indexPath);

        const { gzipSync } = await import('zlib');
        const recompressed = gzipSync(Buffer.from(rewritten, 'utf-8'));

        rewrittenHtmlCache.set(rewrittenKey, recompressed, recompressed.length);

        const headers: Record<string, string> = {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=300',
          'X-Cache-Tier': indexResult.source,
        };
        applyCustomHeaders(headers, indexPath, settings);
        return new Response(recompressed, { headers });
      }
    }
  }

  // Try clean URLs: /about -> /about.html
  if (settings?.cleanUrls && !fileRequestPath.includes('.')) {
    const htmlPath = `${fileRequestPath}.html`;
    const htmlFile = getCachedFilePath(did, rkey, htmlPath);
    if (await fileExists(htmlFile)) {
      return serveFileInternalWithRewrite(did, rkey, htmlPath, basePath, settings);
    }

    // Also try /about/index.html
    for (const indexFileName of indexFiles) {
      const indexPath = fileRequestPath ? `${fileRequestPath}/${indexFileName}` : indexFileName;
      const indexFile = getCachedFilePath(did, rkey, indexPath);
      if (await fileExists(indexFile)) {
        return serveFileInternalWithRewrite(did, rkey, indexPath, basePath, settings);
      }
    }
  }

  // SPA mode: serve SPA file for all non-existing routes
  if (settings?.spaMode) {
    const spaFile = settings.spaMode;
    const spaFilePath = getCachedFilePath(did, rkey, spaFile);
    if (await fileExists(spaFilePath)) {
      return serveFileInternalWithRewrite(did, rkey, spaFile, basePath, settings);
    }
  }

  // Custom 404: serve custom 404 file if configured (wins conflict battle)
  if (settings?.custom404) {
    const custom404File = settings.custom404;
    const custom404Path = getCachedFilePath(did, rkey, custom404File);
    if (await fileExists(custom404Path)) {
      const response: Response = await serveFileInternalWithRewrite(did, rkey, custom404File, basePath, settings);
      // Override status to 404
      return new Response(response.body, {
        status: 404,
        headers: response.headers,
      });
    }
  }

  // Autodetect 404 pages (GitHub Pages: 404.html, Neocities/Nekoweb: not_found.html)
  const auto404Pages = ['404.html', 'not_found.html'];
  for (const auto404Page of auto404Pages) {
    const auto404Path = getCachedFilePath(did, rkey, auto404Page);
    if (await fileExists(auto404Path)) {
      const response: Response = await serveFileInternalWithRewrite(did, rkey, auto404Page, basePath, settings);
      // Override status to 404
      return new Response(response.body, {
        status: 404,
        headers: response.headers,
      });
    }
  }

  // Directory listing fallback: if enabled, show root directory listing on 404
  if (settings?.directoryListing) {
    const rootPath = getCachedFilePath(did, rkey, '');
    if (await fileExists(rootPath)) {
      const { stat, readdir } = await import('fs/promises');
      try {
        const stats = await stat(rootPath);
        if (stats.isDirectory()) {
          const entries = await readdir(rootPath);
          // Filter out .meta files and metadata
          const visibleEntries = entries.filter(entry =>
            !entry.endsWith('.meta') && entry !== '.metadata.json'
          );

          // Check which entries are directories
          const entriesWithType = await Promise.all(
            visibleEntries.map(async (name) => {
              try {
                const entryPath = `${rootPath}/${name}`;
                const entryStats = await stat(entryPath);
                return { name, isDirectory: entryStats.isDirectory() };
              } catch {
                return { name, isDirectory: false };
              }
            })
          );

          const html = generateDirectoryListing('', entriesWithType);
          return new Response(html, {
            status: 404,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=300',
            },
          });
        }
      } catch (err) {
        // If directory listing fails, fall through to 404
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
