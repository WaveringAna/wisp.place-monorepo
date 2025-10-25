import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { getWispDomain, getCustomDomain, getCustomDomainByHash } from './lib/db';
import { resolveDid, getPdsForDid, fetchSiteRecord, downloadAndCacheSite, getCachedFilePath, isCached, sanitizePath } from './lib/utils';
import { rewriteHtmlPaths, isHtmlContent } from './lib/html-rewriter';
import { existsSync } from 'fs';

const app = new Hono();

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
    const file = Bun.file(cachedFile);
    return new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
      },
    });
  }

  // Try index.html for directory-like paths
  if (!requestPath.includes('.')) {
    const indexFile = getCachedFilePath(did, rkey, `${requestPath}/index.html`);
    if (existsSync(indexFile)) {
      const file = Bun.file(indexFile);
      return new Response(file, {
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
    const file = Bun.file(cachedFile);

    // Check if this is HTML content that needs rewriting
    if (isHtmlContent(requestPath, file.type)) {
      const content = await file.text();
      const rewritten = rewriteHtmlPaths(content, basePath);
      return new Response(rewritten, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
        },
      });
    }

    // Non-HTML files served with proper MIME type
    return new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
      },
    });
  }

  // Try index.html for directory-like paths
  if (!requestPath.includes('.')) {
    const indexFile = getCachedFilePath(did, rkey, `${requestPath}/index.html`);
    if (existsSync(indexFile)) {
      const file = Bun.file(indexFile);
      const content = await file.text();
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

// Route 4: Direct file serving (no DB) - sites.wisp.place/:identifier/:site/*
// This route is now handled in the catch-all route below

// Route 3: DNS routing for custom domains - /hash.dns.wisp.place/*
app.get('/*', async (c) => {
  const hostname = c.req.header('host') || '';
  const rawPath = c.req.path.replace(/^\//, '');
  const path = sanitizePath(rawPath);

  console.log('[Request]', { hostname, path });

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

    console.log('[Sites] Serving', { identifier, site, filePath });

    // Additional validation: identifier must be a valid DID or handle format
    if (!identifier || identifier.length < 3 || identifier.includes('..') || identifier.includes('\0')) {
      return c.text('Invalid identifier', 400);
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

    console.log('[DNS Hash] Looking up', { hash, baseDomain });

    if (baseDomain !== BASE_HOST) {
      return c.text('Invalid base domain', 400);
    }

    const customDomain = await getCustomDomainByHash(hash);
    if (!customDomain) {
      return c.text('Custom domain not found or not verified', 404);
    }

    const rkey = customDomain.rkey || 'self';
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
    const subdomain = hostname.replace(`.${BASE_HOST}`, '');

    console.log('[Subdomain] Looking up', { subdomain, fullDomain: hostname });

    const domainInfo = await getWispDomain(hostname);
    if (!domainInfo) {
      return c.text('Subdomain not registered', 404);
    }

    const rkey = domainInfo.rkey || 'self';
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
  console.log('[Custom Domain] Looking up', { hostname });

  const customDomain = await getCustomDomain(hostname);
  if (!customDomain) {
    return c.text('Custom domain not found or not verified', 404);
  }

  const rkey = customDomain.rkey || 'self';
  if (!isValidRkey(rkey)) {
    return c.text('Invalid site configuration', 500);
  }

  const cached = await ensureSiteCached(customDomain.did, rkey);
  if (!cached) {
    return c.text('Site not found', 404);
  }

  return serveFromCache(customDomain.did, rkey, path);
});

export default app;
