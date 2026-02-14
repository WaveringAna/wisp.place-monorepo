/**
 * Main server entry point for the hosting service
 * Handles routing and request dispatching
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getWispDomain, getCustomDomain, getCustomDomainByHash } from './lib/db';
import { resolveDid } from './lib/utils';
import { logCollector, errorTracker, metricsCollector } from '@wispplace/observability';
import { observabilityMiddleware, observabilityErrorHandler } from '@wispplace/observability/middleware/hono';
import { sanitizePath } from '@wispplace/fs-utils';
import { isValidRkey, extractHeaders } from './lib/request-utils';
import { serveFromCache, serveFromCacheWithRewrite } from './lib/file-serving';
import { getRevalidateMetrics } from './lib/revalidate-metrics';

const BASE_HOST_ENV = process.env.BASE_HOST || 'wisp.place';
const BASE_HOST = BASE_HOST_ENV.split(':')[0] || BASE_HOST_ENV;

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
  const hostnameWithoutPort = hostname.split(':')[0] || '';
  const rawPath = url.pathname.replace(/^\//, '');
  const path = sanitizePath(rawPath);

  console.log(`[Server] Request: host=${hostname} hostnameWithoutPort=${hostnameWithoutPort} path=${path} BASE_HOST=${BASE_HOST}`);

  // Check if this is sites.wisp.place subdomain (strip port for comparison)
  if (hostnameWithoutPort === `sites.${BASE_HOST}`) {
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

    console.log(`[Server] sites.wisp.place request: identifier=${identifier}, site=${site}, filePath=${filePath}`);

    // Serve with HTML path rewriting to handle absolute paths
    const basePath = `/${identifier}/${site}/`;
    console.log(`[Server] Serving with basePath: ${basePath}`);
    const headers = extractHeaders(c.req.raw.headers);
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

    const headers = extractHeaders(c.req.raw.headers);
    return serveFromCache(customDomain.did, rkey, path, c.req.url, headers);
  }

  // Route 2: Registered subdomains - /*.wisp.place/*
  if (hostnameWithoutPort.endsWith(`.${BASE_HOST}`)) {
    const domainInfo = await getWispDomain(hostnameWithoutPort);
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

    const headers = extractHeaders(c.req.raw.headers);
    return serveFromCache(domainInfo.did, rkey, path, c.req.url, headers);
  }

  // Route 1: Custom domains - /*
  const customDomain = await getCustomDomain(hostnameWithoutPort);
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

  const headers = extractHeaders(c.req.raw.headers);
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
  return c.json({ stats, revalidate: getRevalidateMetrics(), timeWindow });
});

app.get('/__internal__/observability/cache', async (c) => {
  const { getCacheStats } = await import('./lib/cache');
  const stats = await getCacheStats();
  return c.json({ cache: stats });
});

export default app;
