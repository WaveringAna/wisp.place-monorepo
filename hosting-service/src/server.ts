import { Hono } from 'hono';
import { getWispDomain, getCustomDomain, getCustomDomainByHash } from './lib/db';
import { resolveDid, getPdsForDid, fetchSiteRecord, downloadAndCacheSite, getCachedFilePath, isCached, sanitizePath } from './lib/utils';
import { rewriteHtmlPaths, isHtmlContent } from './lib/html-rewriter';
import { existsSync, readFileSync } from 'fs';
import { lookup } from 'mime-types';
import { logger, observabilityMiddleware, observabilityErrorHandler, logCollector, errorTracker, metricsCollector } from './lib/observability';

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

// Helper to serve files from cache
async function serveFromCache(did: string, rkey: string, filePath: string) {
  // Default to index.html if path is empty or ends with /
  let requestPath = filePath || 'index.html';
  if (requestPath.endsWith('/')) {
    requestPath += 'index.html';
  }

  const cachedFile = getCachedFilePath(did, rkey, requestPath);

  if (existsSync(cachedFile)) {
    const content = readFileSync(cachedFile);
    const metaFile = `${cachedFile}.meta`;

    console.log(`[DEBUG SERVE] ${requestPath}: file size=${content.length} bytes, metaFile exists=${existsSync(metaFile)}`);

    // Check if file has compression metadata
    if (existsSync(metaFile)) {
      const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
      console.log(`[DEBUG SERVE] ${requestPath}: meta=${JSON.stringify(meta)}`);
      
      // Check actual content for gzip magic bytes
      if (content.length >= 2) {
        const hasGzipMagic = content[0] === 0x1f && content[1] === 0x8b;
        const byte0 = content[0];
        const byte1 = content[1];
        console.log(`[DEBUG SERVE] ${requestPath}: has gzip magic bytes=${hasGzipMagic} (0x${byte0?.toString(16)}, 0x${byte1?.toString(16)})`);
      }
      
      if (meta.encoding === 'gzip' && meta.mimeType) {
        // Don't serve already-compressed media formats with Content-Encoding: gzip
        // These formats (video, audio, images) are already compressed and the browser
        // can't decode them if we add another layer of compression
        const alreadyCompressedTypes = [
          'video/', 'audio/', 'image/jpeg', 'image/jpg', 'image/png', 
          'image/gif', 'image/webp', 'application/pdf'
        ];
        
        const isAlreadyCompressed = alreadyCompressedTypes.some(type => 
          meta.mimeType.toLowerCase().startsWith(type)
        );
        
        if (isAlreadyCompressed) {
          // Decompress the file before serving
          console.log(`[DEBUG SERVE] ${requestPath}: decompressing already-compressed media type`);
          const { gunzipSync } = await import('zlib');
          const decompressed = gunzipSync(content);
          console.log(`[DEBUG SERVE] ${requestPath}: decompressed from ${content.length} to ${decompressed.length} bytes`);
          return new Response(decompressed, {
            headers: {
              'Content-Type': meta.mimeType,
            },
          });
        }
        
        // Serve gzipped content with proper headers (for HTML, CSS, JS, etc.)
        console.log(`[DEBUG SERVE] ${requestPath}: serving as gzipped with Content-Encoding header`);
        return new Response(content, {
          headers: {
            'Content-Type': meta.mimeType,
            'Content-Encoding': 'gzip',
          },
        });
      }
    }

    // Serve non-compressed files normally
    const mimeType = lookup(cachedFile) || 'application/octet-stream';
    return new Response(content, {
      headers: {
        'Content-Type': mimeType,
      },
    });
  }

  // Try index.html for directory-like paths
  if (!requestPath.includes('.')) {
    const indexFile = getCachedFilePath(did, rkey, `${requestPath}/index.html`);
    if (existsSync(indexFile)) {
      const content = readFileSync(indexFile);
      const metaFile = `${indexFile}.meta`;

      // Check if file has compression metadata
      if (existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
        if (meta.encoding === 'gzip' && meta.mimeType) {
          return new Response(content, {
            headers: {
              'Content-Type': meta.mimeType,
              'Content-Encoding': 'gzip',
            },
          });
        }
      }

      return new Response(content, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}

// Helper to serve files from cache with HTML path rewriting for sites.wisp.place routes
async function serveFromCacheWithRewrite(
  did: string,
  rkey: string,
  filePath: string,
  basePath: string
) {
  // Default to index.html if path is empty or ends with /
  let requestPath = filePath || 'index.html';
  if (requestPath.endsWith('/')) {
    requestPath += 'index.html';
  }

  const cachedFile = getCachedFilePath(did, rkey, requestPath);

  if (existsSync(cachedFile)) {
    const metaFile = `${cachedFile}.meta`;
    let mimeType = lookup(cachedFile) || 'application/octet-stream';
    let isGzipped = false;

    // Check if file has compression metadata
    if (existsSync(metaFile)) {
      const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
      if (meta.encoding === 'gzip' && meta.mimeType) {
        mimeType = meta.mimeType;
        isGzipped = true;
      }
    }

    // Check if this is HTML content that needs rewriting
    // Note: For gzipped HTML with path rewriting, we need to decompress, rewrite, and serve uncompressed
    // This is a trade-off for the sites.wisp.place domain which needs path rewriting
    if (isHtmlContent(requestPath, mimeType)) {
      let content: string;
      if (isGzipped) {
        const { gunzipSync } = await import('zlib');
        const compressed = readFileSync(cachedFile);
        content = gunzipSync(compressed).toString('utf-8');
      } else {
        content = readFileSync(cachedFile, 'utf-8');
      }
      const rewritten = rewriteHtmlPaths(content, basePath);
      return new Response(rewritten, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        },
      });
    }

    // Non-HTML files: serve gzipped content as-is with proper headers
    const content = readFileSync(cachedFile);
    if (isGzipped) {
      // Don't serve already-compressed media formats with Content-Encoding: gzip
      const alreadyCompressedTypes = [
        'video/', 'audio/', 'image/jpeg', 'image/jpg', 'image/png', 
        'image/gif', 'image/webp', 'application/pdf'
      ];
      
      const isAlreadyCompressed = alreadyCompressedTypes.some(type => 
        mimeType.toLowerCase().startsWith(type)
      );
      
      if (isAlreadyCompressed) {
        // Decompress the file before serving
        const { gunzipSync } = await import('zlib');
        const decompressed = gunzipSync(content);
        return new Response(decompressed, {
          headers: {
            'Content-Type': mimeType,
          },
        });
      }
      
      return new Response(content, {
        headers: {
          'Content-Type': mimeType,
          'Content-Encoding': 'gzip',
        },
      });
    }
    return new Response(content, {
      headers: {
        'Content-Type': mimeType,
      },
    });
  }

  // Try index.html for directory-like paths
  if (!requestPath.includes('.')) {
    const indexFile = getCachedFilePath(did, rkey, `${requestPath}/index.html`);
    if (existsSync(indexFile)) {
      const metaFile = `${indexFile}.meta`;
      let isGzipped = false;

      if (existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
        if (meta.encoding === 'gzip') {
          isGzipped = true;
        }
      }

      // HTML needs path rewriting, so decompress if needed
      let content: string;
      if (isGzipped) {
        const { gunzipSync } = await import('zlib');
        const compressed = readFileSync(indexFile);
        content = gunzipSync(compressed).toString('utf-8');
      } else {
        content = readFileSync(indexFile, 'utf-8');
      }
      const rewritten = rewriteHtmlPaths(content, basePath);
      return new Response(rewritten, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
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
    logger.info('Site cached successfully', { did, rkey });
    return true;
  } catch (err) {
    logger.error('Failed to cache site', err, { did, rkey });
    return false;
  }
}

const app = new Hono();

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
    return serveFromCacheWithRewrite(did, site, filePath, basePath);
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

    return serveFromCache(customDomain.did, rkey, path);
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

    return serveFromCache(domainInfo.did, rkey, path);
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

  return serveFromCache(customDomain.did, rkey, path);
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

export default app;
