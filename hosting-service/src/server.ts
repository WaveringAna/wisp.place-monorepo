import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { getWispDomain, getCustomDomain, getCustomDomainByHash } from './lib/db';
import { resolveDid, getPdsForDid, fetchSiteRecord, downloadAndCacheSite, getCachedFilePath, isCached } from './lib/utils';
import { rewriteHtmlPaths, isHtmlContent } from './lib/html-rewriter';
import { existsSync } from 'fs';

const app = new Hono();

const BASE_HOST = process.env.BASE_HOST || 'wisp.place';

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
    return new Response(file);
  }

  // Try index.html for directory-like paths
  if (!requestPath.includes('.')) {
    const indexFile = getCachedFilePath(did, rkey, `${requestPath}/index.html`);
    if (existsSync(indexFile)) {
      const file = Bun.file(indexFile);
      return new Response(file);
    }
  }

  return new Response('Not Found', { status: 404 });
}

// Helper to serve files from cache with HTML path rewriting for /s/ routes
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

    // Non-HTML files served as-is
    return new Response(file);
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
  const record = await fetchSiteRecord(did, rkey);
  if (!record) {
    console.error('Site record not found', did, rkey);
    return false;
  }

  const pdsEndpoint = await getPdsForDid(did);
  if (!pdsEndpoint) {
    console.error('PDS not found for DID', did);
    return false;
  }

  try {
    await downloadAndCacheSite(did, rkey, record, pdsEndpoint);
    return true;
  } catch (err) {
    console.error('Failed to cache site', did, rkey, err);
    return false;
  }
}

// Route 4: Direct file serving (no DB) - /s.wisp.place/:identifier/:site/*
app.get('/s/:identifier/:site/*', async (c) => {
  const identifier = c.req.param('identifier');
  const site = c.req.param('site');
  const filePath = c.req.path.replace(`/s/${identifier}/${site}/`, '');

  console.log('[Direct] Serving', { identifier, site, filePath });

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
  const basePath = `/s/${identifier}/${site}/`;
  return serveFromCacheWithRewrite(did, site, filePath, basePath);
});

// Route 3: DNS routing for custom domains - /hash.dns.wisp.place/*
app.get('/*', async (c) => {
  const hostname = c.req.header('host') || '';
  const path = c.req.path.replace(/^\//, '');

  console.log('[Request]', { hostname, path });

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
  const cached = await ensureSiteCached(customDomain.did, rkey);
  if (!cached) {
    return c.text('Site not found', 404);
  }

  return serveFromCache(customDomain.did, rkey, path);
});

export default app;
