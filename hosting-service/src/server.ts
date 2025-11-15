import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getWispDomain, getCustomDomain, getCustomDomainByHash } from './lib/db';
import { resolveDid, getPdsForDid, fetchSiteRecord, downloadAndCacheSite, getCachedFilePath, isCached, sanitizePath, shouldCompressMimeType } from './lib/utils';
import { rewriteHtmlPaths, isHtmlContent } from './lib/html-rewriter';
import { existsSync } from 'fs';
import { readFile, access } from 'fs/promises';
import { lookup } from 'mime-types';
import { logger, observabilityMiddleware, observabilityErrorHandler, logCollector, errorTracker, metricsCollector } from './lib/observability';
import { fileCache, metadataCache, rewrittenHtmlCache, getCacheKey, type FileMetadata } from './lib/cache';
import { loadRedirectRules, matchRedirectRule, parseCookies, parseQueryString, type RedirectRule } from './lib/redirects';

const BASE_HOST = process.env.BASE_HOST || 'wisp.place';

/**
 * Validate site name (rkey) to prevent injection attacks
 * Must match AT Protocol rkey format
 */
function isValidRkey(rkey: string): boolean {
  if (!rkey || typeof rkey !== 'string') return false;
  if (rkey.length < 1 || rkey.length > 512) return false;
  if (rkey === '.' || rkey === '..') return false;
  if (rkey.includes('/') || rkey.includes('\\') || rkey.includes('\0')) return false;
  const validRkeyPattern = /^[a-zA-Z0-9._~:-]+$/;
  return validRkeyPattern.test(rkey);
}

/**
 * Async file existence check
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Cache for redirect rules (per site)
const redirectRulesCache = new Map<string, RedirectRule[]>();

/**
 * Clear redirect rules cache for a specific site
 * Should be called when a site is updated/recached
 */
export function clearRedirectRulesCache(did: string, rkey: string) {
  const cacheKey = `${did}:${rkey}`;
  redirectRulesCache.delete(cacheKey);
}

// Helper to serve files from cache
async function serveFromCache(
  did: string, 
  rkey: string, 
  filePath: string,
  fullUrl?: string,
  headers?: Record<string, string>
) {
  // Check for redirect rules first
  const redirectCacheKey = `${did}:${rkey}`;
  let redirectRules = redirectRulesCache.get(redirectCacheKey);
  
  if (redirectRules === undefined) {
    // Load rules for the first time
    redirectRules = await loadRedirectRules(did, rkey);
    redirectRulesCache.set(redirectCacheKey, redirectRules);
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
        let checkPath = filePath || 'index.html';
        if (checkPath.endsWith('/')) {
          checkPath += 'index.html';
        }

        const cachedFile = getCachedFilePath(did, rkey, checkPath);
        const fileExistsOnDisk = await fileExists(cachedFile);

        // If file exists and redirect is not forced, serve the file normally
        if (fileExistsOnDisk) {
          return serveFileInternal(did, rkey, filePath);
        }
      }

      // Handle different status codes
      if (status === 200) {
        // Rewrite: serve different content but keep URL the same
        // Remove leading slash for internal path resolution
        const rewritePath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        return serveFileInternal(did, rkey, rewritePath);
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
        // Custom 404 page
        const custom404Path = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        const response = await serveFileInternal(did, rkey, custom404Path);
        // Override status to 404
        return new Response(response.body, {
          status: 404,
          headers: response.headers,
        });
      }
    }
  }

  // No redirect matched, serve normally
  return serveFileInternal(did, rkey, filePath);
}

// Internal function to serve a file (used by both normal serving and rewrites)
async function serveFileInternal(did: string, rkey: string, filePath: string) {
  // Default to index.html if path is empty or ends with /
  let requestPath = filePath || 'index.html';
  if (requestPath.endsWith('/')) {
    requestPath += 'index.html';
  }

  const cacheKey = getCacheKey(did, rkey, requestPath);
  const cachedFile = getCachedFilePath(did, rkey, requestPath);

  // Check in-memory cache first
  let content = fileCache.get(cacheKey);
  let meta = metadataCache.get(cacheKey);

  if (!content && await fileExists(cachedFile)) {
    // Read from disk and cache
    content = await readFile(cachedFile);
    fileCache.set(cacheKey, content, content.length);

    const metaFile = `${cachedFile}.meta`;
    if (await fileExists(metaFile)) {
      const metaJson = await readFile(metaFile, 'utf-8');
      meta = JSON.parse(metaJson);
      metadataCache.set(cacheKey, meta!, JSON.stringify(meta).length);
    }
  }

  if (content) {
    // Build headers with caching
    const headers: Record<string, string> = {};

    if (meta && meta.encoding === 'gzip' && meta.mimeType) {
      const shouldServeCompressed = shouldCompressMimeType(meta.mimeType);

      if (!shouldServeCompressed) {
        // Verify content is actually gzipped before attempting decompression
        const isGzipped = content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
        if (isGzipped) {
          const { gunzipSync } = await import('zlib');
          const decompressed = gunzipSync(content);
          headers['Content-Type'] = meta.mimeType;
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
          return new Response(decompressed, { headers });
        } else {
          // Meta says gzipped but content isn't - serve as-is
          console.warn(`File ${filePath} has gzip encoding in meta but content lacks gzip magic bytes`);
          headers['Content-Type'] = meta.mimeType;
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
          return new Response(content, { headers });
        }
      }

      headers['Content-Type'] = meta.mimeType;
      headers['Content-Encoding'] = 'gzip';
      headers['Cache-Control'] = meta.mimeType.startsWith('text/html')
        ? 'public, max-age=300'
        : 'public, max-age=31536000, immutable';
      return new Response(content, { headers });
    }

    // Non-compressed files
    const mimeType = lookup(cachedFile) || 'application/octet-stream';
    headers['Content-Type'] = mimeType;
    headers['Cache-Control'] = mimeType.startsWith('text/html')
      ? 'public, max-age=300'
      : 'public, max-age=31536000, immutable';
    return new Response(content, { headers });
  }

  // Try index.html for directory-like paths
  if (!requestPath.includes('.')) {
    const indexPath = `${requestPath}/index.html`;
    const indexCacheKey = getCacheKey(did, rkey, indexPath);
    const indexFile = getCachedFilePath(did, rkey, indexPath);

    let indexContent = fileCache.get(indexCacheKey);
    let indexMeta = metadataCache.get(indexCacheKey);

    if (!indexContent && await fileExists(indexFile)) {
      indexContent = await readFile(indexFile);
      fileCache.set(indexCacheKey, indexContent, indexContent.length);

      const indexMetaFile = `${indexFile}.meta`;
      if (await fileExists(indexMetaFile)) {
        const metaJson = await readFile(indexMetaFile, 'utf-8');
        indexMeta = JSON.parse(metaJson);
        metadataCache.set(indexCacheKey, indexMeta!, JSON.stringify(indexMeta).length);
      }
    }

    if (indexContent) {
      const headers: Record<string, string> = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      };

      if (indexMeta && indexMeta.encoding === 'gzip') {
        headers['Content-Encoding'] = 'gzip';
      }

      return new Response(indexContent, { headers });
    }
  }

  return new Response('Not Found', { status: 404 });
}

// Helper to serve files from cache with HTML path rewriting for sites.wisp.place routes
async function serveFromCacheWithRewrite(
  did: string,
  rkey: string,
  filePath: string,
  basePath: string,
  fullUrl?: string,
  headers?: Record<string, string>
) {
  // Check for redirect rules first
  const redirectCacheKey = `${did}:${rkey}`;
  let redirectRules = redirectRulesCache.get(redirectCacheKey);
  
  if (redirectRules === undefined) {
    // Load rules for the first time
    redirectRules = await loadRedirectRules(did, rkey);
    redirectRulesCache.set(redirectCacheKey, redirectRules);
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
        let checkPath = filePath || 'index.html';
        if (checkPath.endsWith('/')) {
          checkPath += 'index.html';
        }

        const cachedFile = getCachedFilePath(did, rkey, checkPath);
        const fileExistsOnDisk = await fileExists(cachedFile);

        // If file exists and redirect is not forced, serve the file normally
        if (fileExistsOnDisk) {
          return serveFileInternalWithRewrite(did, rkey, filePath, basePath);
        }
      }

      // Handle different status codes
      if (status === 200) {
        // Rewrite: serve different content but keep URL the same
        const rewritePath = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        return serveFileInternalWithRewrite(did, rkey, rewritePath, basePath);
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
        // Custom 404 page
        const custom404Path = targetPath.startsWith('/') ? targetPath.slice(1) : targetPath;
        const response = await serveFileInternalWithRewrite(did, rkey, custom404Path, basePath);
        // Override status to 404
        return new Response(response.body, {
          status: 404,
          headers: response.headers,
        });
      }
    }
  }

  // No redirect matched, serve normally
  return serveFileInternalWithRewrite(did, rkey, filePath, basePath);
}

// Internal function to serve a file with rewriting
async function serveFileInternalWithRewrite(did: string, rkey: string, filePath: string, basePath: string) {
  // Default to index.html if path is empty or ends with /
  let requestPath = filePath || 'index.html';
  if (requestPath.endsWith('/')) {
    requestPath += 'index.html';
  }

  const cacheKey = getCacheKey(did, rkey, requestPath);
  const cachedFile = getCachedFilePath(did, rkey, requestPath);

  // Check for rewritten HTML in cache first (if it's HTML)
  const mimeTypeGuess = lookup(requestPath) || 'application/octet-stream';
  if (isHtmlContent(requestPath, mimeTypeGuess)) {
    const rewrittenKey = getCacheKey(did, rkey, requestPath, `rewritten:${basePath}`);
    const rewrittenContent = rewrittenHtmlCache.get(rewrittenKey);
    if (rewrittenContent) {
      return new Response(rewrittenContent, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
  }

  // Check in-memory file cache
  let content = fileCache.get(cacheKey);
  let meta = metadataCache.get(cacheKey);

  if (!content && await fileExists(cachedFile)) {
    // Read from disk and cache
    content = await readFile(cachedFile);
    fileCache.set(cacheKey, content, content.length);

    const metaFile = `${cachedFile}.meta`;
    if (await fileExists(metaFile)) {
      const metaJson = await readFile(metaFile, 'utf-8');
      meta = JSON.parse(metaJson);
      metadataCache.set(cacheKey, meta!, JSON.stringify(meta).length);
    }
  }

  if (content) {
    const mimeType = meta?.mimeType || lookup(cachedFile) || 'application/octet-stream';
    const isGzipped = meta?.encoding === 'gzip';

    // Check if this is HTML content that needs rewriting
    if (isHtmlContent(requestPath, mimeType)) {
      let htmlContent: string;
      if (isGzipped) {
        // Verify content is actually gzipped
        const hasGzipMagic = content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
        if (hasGzipMagic) {
          const { gunzipSync } = await import('zlib');
          htmlContent = gunzipSync(content).toString('utf-8');
        } else {
          console.warn(`File ${requestPath} marked as gzipped but lacks magic bytes, serving as-is`);
          htmlContent = content.toString('utf-8');
        }
      } else {
        htmlContent = content.toString('utf-8');
      }
      const rewritten = rewriteHtmlPaths(htmlContent, basePath, requestPath);

      // Recompress and cache the rewritten HTML
      const { gzipSync } = await import('zlib');
      const recompressed = gzipSync(Buffer.from(rewritten, 'utf-8'));

      const rewrittenKey = getCacheKey(did, rkey, requestPath, `rewritten:${basePath}`);
      rewrittenHtmlCache.set(rewrittenKey, recompressed, recompressed.length);

      return new Response(recompressed, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    // Non-HTML files: serve as-is
    const headers: Record<string, string> = {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    };

    if (isGzipped) {
      const shouldServeCompressed = shouldCompressMimeType(mimeType);
      if (!shouldServeCompressed) {
        // Verify content is actually gzipped
        const hasGzipMagic = content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b;
        if (hasGzipMagic) {
          const { gunzipSync } = await import('zlib');
          const decompressed = gunzipSync(content);
          return new Response(decompressed, { headers });
        } else {
          console.warn(`File ${requestPath} marked as gzipped but lacks magic bytes, serving as-is`);
          return new Response(content, { headers });
        }
      }
      headers['Content-Encoding'] = 'gzip';
    }

    return new Response(content, { headers });
  }

  // Try index.html for directory-like paths
  if (!requestPath.includes('.')) {
    const indexPath = `${requestPath}/index.html`;
    const indexCacheKey = getCacheKey(did, rkey, indexPath);
    const indexFile = getCachedFilePath(did, rkey, indexPath);

    // Check for rewritten index.html in cache
    const rewrittenKey = getCacheKey(did, rkey, indexPath, `rewritten:${basePath}`);
    const rewrittenContent = rewrittenHtmlCache.get(rewrittenKey);
    if (rewrittenContent) {
      return new Response(rewrittenContent, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    let indexContent = fileCache.get(indexCacheKey);
    let indexMeta = metadataCache.get(indexCacheKey);

    if (!indexContent && await fileExists(indexFile)) {
      indexContent = await readFile(indexFile);
      fileCache.set(indexCacheKey, indexContent, indexContent.length);

      const indexMetaFile = `${indexFile}.meta`;
      if (await fileExists(indexMetaFile)) {
        const metaJson = await readFile(indexMetaFile, 'utf-8');
        indexMeta = JSON.parse(metaJson);
        metadataCache.set(indexCacheKey, indexMeta!, JSON.stringify(indexMeta).length);
      }
    }

    if (indexContent) {
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

      return new Response(recompressed, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}

// Helper to ensure site is cached
async function ensureSiteCached(did: string, rkey: string): Promise<boolean> {
  if (isCached(did, rkey)) {
    return true;
  }

  // Fetch and cache the site
  const siteData = await fetchSiteRecord(did, rkey);
  if (!siteData) {
    logger.error('Site record not found', null, { did, rkey });
    return false;
  }

  const pdsEndpoint = await getPdsForDid(did);
  if (!pdsEndpoint) {
    logger.error('PDS not found for DID', null, { did });
    return false;
  }

  try {
    await downloadAndCacheSite(did, rkey, siteData.record, pdsEndpoint, siteData.cid);
    // Clear redirect rules cache since the site was updated
    clearRedirectRulesCache(did, rkey);
    logger.info('Site cached successfully', { did, rkey });
    return true;
  } catch (err) {
    logger.error('Failed to cache site', err, { did, rkey });
    return false;
  }
}

const app = new Hono();

// Add CORS middleware - allow all origins for static site hosting
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'HEAD', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length', 'Content-Type', 'Content-Encoding', 'Cache-Control'],
  maxAge: 86400, // 24 hours
  credentials: false,
}));

// Add observability middleware
app.use('*', observabilityMiddleware('hosting-service'));

// Error handler
app.onError(observabilityErrorHandler('hosting-service'));

// Main site serving route
app.get('/*', async (c) => {
  const url = new URL(c.req.url);
  const hostname = c.req.header('host') || '';
  const rawPath = url.pathname.replace(/^\//, '');
  const path = sanitizePath(rawPath);

  // Check if this is sites.wisp.place subdomain
  if (hostname === `sites.${BASE_HOST}` || hostname === `sites.${BASE_HOST}:${process.env.PORT || 3000}`) {
    // Sanitize the path FIRST to prevent path traversal
    const sanitizedFullPath = sanitizePath(rawPath);

    // Extract identifier and site from sanitized path: did:plc:123abc/sitename/file.html
    const pathParts = sanitizedFullPath.split('/');
    if (pathParts.length < 2) {
      return c.text('Invalid path format. Expected: /identifier/sitename/path', 400);
    }

    const identifier = pathParts[0];
    const site = pathParts[1];
    const filePath = pathParts.slice(2).join('/');

    // Additional validation: identifier must be a valid DID or handle format
    if (!identifier || identifier.length < 3 || identifier.includes('..') || identifier.includes('\0')) {
      return c.text('Invalid identifier', 400);
    }

    // Validate site parameter exists
    if (!site) {
      return c.text('Site name required', 400);
    }

    // Validate site name (rkey)
    if (!isValidRkey(site)) {
      return c.text('Invalid site name', 400);
    }

    // Resolve identifier to DID
    const did = await resolveDid(identifier);
    if (!did) {
      return c.text('Invalid identifier', 400);
    }

    // Ensure site is cached
    const cached = await ensureSiteCached(did, site);
    if (!cached) {
      return c.text('Site not found', 404);
    }

    // Serve with HTML path rewriting to handle absolute paths
    const basePath = `/${identifier}/${site}/`;
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return serveFromCacheWithRewrite(did, site, filePath, basePath, c.req.url, headers);
  }

  // Check if this is a DNS hash subdomain
  const dnsMatch = hostname.match(/^([a-f0-9]{16})\.dns\.(.+)$/);
  if (dnsMatch) {
    const hash = dnsMatch[1];
    const baseDomain = dnsMatch[2];

    if (!hash) {
      return c.text('Invalid DNS hash', 400);
    }

    if (baseDomain !== BASE_HOST) {
      return c.text('Invalid base domain', 400);
    }

    const customDomain = await getCustomDomainByHash(hash);
    if (!customDomain) {
      return c.text('Custom domain not found or not verified', 404);
    }

    if (!customDomain.rkey) {
      return c.text('Domain not mapped to a site', 404);
    }

    const rkey = customDomain.rkey;
    if (!isValidRkey(rkey)) {
      return c.text('Invalid site configuration', 500);
    }

    const cached = await ensureSiteCached(customDomain.did, rkey);
    if (!cached) {
      return c.text('Site not found', 404);
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return serveFromCache(customDomain.did, rkey, path, c.req.url, headers);
  }

  // Route 2: Registered subdomains - /*.wisp.place/*
  if (hostname.endsWith(`.${BASE_HOST}`)) {
    const domainInfo = await getWispDomain(hostname);
    if (!domainInfo) {
      return c.text('Subdomain not registered', 404);
    }

    if (!domainInfo.rkey) {
      return c.text('Domain not mapped to a site', 404);
    }

    const rkey = domainInfo.rkey;
    if (!isValidRkey(rkey)) {
      return c.text('Invalid site configuration', 500);
    }

    const cached = await ensureSiteCached(domainInfo.did, rkey);
    if (!cached) {
      return c.text('Site not found', 404);
    }

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return serveFromCache(domainInfo.did, rkey, path, c.req.url, headers);
  }

  // Route 1: Custom domains - /*
  const customDomain = await getCustomDomain(hostname);
  if (!customDomain) {
    return c.text('Custom domain not found or not verified', 404);
  }

  if (!customDomain.rkey) {
    return c.text('Domain not mapped to a site', 404);
  }

  const rkey = customDomain.rkey;
  if (!isValidRkey(rkey)) {
    return c.text('Invalid site configuration', 500);
  }

  const cached = await ensureSiteCached(customDomain.did, rkey);
  if (!cached) {
    return c.text('Site not found', 404);
  }

  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return serveFromCache(customDomain.did, rkey, path, c.req.url, headers);
});

// Internal observability endpoints (for admin panel)
app.get('/__internal__/observability/logs', (c) => {
  const query = c.req.query();
  const filter: any = {};
  if (query.level) filter.level = query.level;
  if (query.service) filter.service = query.service;
  if (query.search) filter.search = query.search;
  if (query.eventType) filter.eventType = query.eventType;
  if (query.limit) filter.limit = parseInt(query.limit as string);
  return c.json({ logs: logCollector.getLogs(filter) });
});

app.get('/__internal__/observability/errors', (c) => {
  const query = c.req.query();
  const filter: any = {};
  if (query.service) filter.service = query.service;
  if (query.limit) filter.limit = parseInt(query.limit as string);
  return c.json({ errors: errorTracker.getErrors(filter) });
});

app.get('/__internal__/observability/metrics', (c) => {
  const query = c.req.query();
  const timeWindow = query.timeWindow ? parseInt(query.timeWindow as string) : 3600000;
  const stats = metricsCollector.getStats('hosting-service', timeWindow);
  return c.json({ stats, timeWindow });
});

app.get('/__internal__/observability/cache', async (c) => {
  const { getCacheStats } = await import('./lib/cache');
  const stats = getCacheStats();
  return c.json({ cache: stats });
});

export default app;
