import { Elysia } from 'elysia';
import { node } from '@elysiajs/node'
import { opentelemetry } from '@elysiajs/opentelemetry';
import { getWispDomain, getCustomDomain, getCustomDomainByHash } from './lib/db';
import { resolveDid, getPdsForDid, fetchSiteRecord, downloadAndCacheSite, getCachedFilePath, isCached, sanitizePath } from './lib/utils';
import { rewriteHtmlPaths, isHtmlContent } from './lib/html-rewriter';
import { existsSync, readFileSync } from 'fs';
import { lookup } from 'mime-types';

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

    // Check if file has compression metadata
    if (existsSync(metaFile)) {
      const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
      if (meta.encoding === 'gzip' && meta.mimeType) {
        // Serve gzipped content with proper headers
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
    console.error('Site record not found', did, rkey);
    return false;
  }

  const pdsEndpoint = await getPdsForDid(did);
  if (!pdsEndpoint) {
    console.error('PDS not found for DID', did);
    return false;
  }

  try {
    await downloadAndCacheSite(did, rkey, siteData.record, pdsEndpoint, siteData.cid);
    return true;
  } catch (err) {
    console.error('Failed to cache site', did, rkey, err);
    return false;
  }
}

const app = new Elysia({ adapter: node() })
  .use(opentelemetry())
  .get('/*', async ({ request, set }) => {
    const url = new URL(request.url);
    const hostname = request.headers.get('host') || '';
    const rawPath = url.pathname.replace(/^\//, '');
    const path = sanitizePath(rawPath);

    // Check if this is sites.wisp.place subdomain
    if (hostname === `sites.${BASE_HOST}` || hostname === `sites.${BASE_HOST}:${process.env.PORT || 3000}`) {
      // Sanitize the path FIRST to prevent path traversal
      const sanitizedFullPath = sanitizePath(rawPath);

      // Extract identifier and site from sanitized path: did:plc:123abc/sitename/file.html
      const pathParts = sanitizedFullPath.split('/');
      if (pathParts.length < 2) {
        set.status = 400;
        return 'Invalid path format. Expected: /identifier/sitename/path';
      }

      const identifier = pathParts[0];
      const site = pathParts[1];
      const filePath = pathParts.slice(2).join('/');

      // Additional validation: identifier must be a valid DID or handle format
      if (!identifier || identifier.length < 3 || identifier.includes('..') || identifier.includes('\0')) {
        set.status = 400;
        return 'Invalid identifier';
      }

      // Validate site name (rkey)
      if (!isValidRkey(site)) {
        set.status = 400;
        return 'Invalid site name';
      }

      // Resolve identifier to DID
      const did = await resolveDid(identifier);
      if (!did) {
        set.status = 400;
        return 'Invalid identifier';
      }

      // Ensure site is cached
      const cached = await ensureSiteCached(did, site);
      if (!cached) {
        set.status = 404;
        return 'Site not found';
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

      if (baseDomain !== BASE_HOST) {
        set.status = 400;
        return 'Invalid base domain';
      }

      const customDomain = await getCustomDomainByHash(hash);
      if (!customDomain) {
        set.status = 404;
        return 'Custom domain not found or not verified';
      }

      const rkey = customDomain.rkey || 'self';
      if (!isValidRkey(rkey)) {
        set.status = 500;
        return 'Invalid site configuration';
      }

      const cached = await ensureSiteCached(customDomain.did, rkey);
      if (!cached) {
        set.status = 404;
        return 'Site not found';
      }

      return serveFromCache(customDomain.did, rkey, path);
    }

    // Route 2: Registered subdomains - /*.wisp.place/*
    if (hostname.endsWith(`.${BASE_HOST}`)) {
      const subdomain = hostname.replace(`.${BASE_HOST}`, '');

      const domainInfo = await getWispDomain(hostname);
      if (!domainInfo) {
        set.status = 404;
        return 'Subdomain not registered';
      }

      const rkey = domainInfo.rkey || 'self';
      if (!isValidRkey(rkey)) {
        set.status = 500;
        return 'Invalid site configuration';
      }

      const cached = await ensureSiteCached(domainInfo.did, rkey);
      if (!cached) {
        set.status = 404;
        return 'Site not found';
      }

      return serveFromCache(domainInfo.did, rkey, path);
    }

    // Route 1: Custom domains - /*
    const customDomain = await getCustomDomain(hostname);
    if (!customDomain) {
      set.status = 404;
      return 'Custom domain not found or not verified';
    }

    const rkey = customDomain.rkey || 'self';
    if (!isValidRkey(rkey)) {
      set.status = 500;
      return 'Invalid site configuration';
    }

    const cached = await ensureSiteCached(customDomain.did, rkey);
    if (!cached) {
      set.status = 404;
      return 'Site not found';
    }

    return serveFromCache(customDomain.did, rkey, path);
  });

export default app;
