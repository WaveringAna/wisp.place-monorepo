import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getWispDomain, getCustomDomain, getCustomDomainByHash } from './lib/db';
import { resolveDid, getPdsForDid, fetchSiteRecord, downloadAndCacheSite, getCachedFilePath, isCached, sanitizePath, shouldCompressMimeType, getCachedSettings } from './lib/utils';
import type { Record as WispSettings } from './lexicon/types/place/wisp/settings';
import { rewriteHtmlPaths, isHtmlContent } from './lib/html-rewriter';
import { existsSync } from 'fs';
import { readFile, access } from 'fs/promises';
import { lookup } from 'mime-types';
import { logger, observabilityMiddleware, observabilityErrorHandler, logCollector, errorTracker, metricsCollector } from './lib/observability';
import { fileCache, metadataCache, rewrittenHtmlCache, getCacheKey, type FileMetadata, markSiteAsBeingCached, unmarkSiteAsBeingCached, isSiteBeingCached } from './lib/cache';
import { loadRedirectRules, matchRedirectRule, parseCookies, parseQueryString, type RedirectRule } from './lib/redirects';

const BASE_HOST = process.env.BASE_HOST || 'wisp.place';

/**
 * Default index file names to check for directory requests
 * Will be checked in order until one is found
 */
const DEFAULT_INDEX_FILES = ['index.html', 'index.htm'];

/**
 * Get index files list from settings or use defaults
 */
function getIndexFiles(settings: WispSettings | null): string[] {
  if (settings?.indexFiles && settings.indexFiles.length > 0) {
    return settings.indexFiles;
  }
  return DEFAULT_INDEX_FILES;
}

/**
 * Match a file path against a glob pattern
 * Supports * wildcard and basic path matching
 */
function matchGlob(path: string, pattern: string): boolean {
  // Normalize paths
  const normalizedPath = path.startsWith('/') ? path : '/' + path;
  const normalizedPattern = pattern.startsWith('/') ? pattern : '/' + pattern;

  // Convert glob pattern to regex
  const regexPattern = normalizedPattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp('^' + regexPattern + '$');
  return regex.test(normalizedPath);
}

/**
 * Apply custom headers from settings to response headers
 */
function applyCustomHeaders(headers: Record<string, string>, filePath: string, settings: WispSettings | null) {
  if (!settings?.headers || settings.headers.length === 0) return;

  for (const customHeader of settings.headers) {
    // If path glob is specified, check if it matches
    if (customHeader.path) {
      if (!matchGlob(filePath, customHeader.path)) {
        continue;
      }
    }
    // Apply the header
    headers[customHeader.name] = customHeader.value;
  }
}

/**
 * Generate 404 page HTML
 */
function generate404Page(): string {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>404 - Not Found</title>
  <style>
    @media (prefers-color-scheme: light) {
      :root {
        /* Warm beige background */
        --background: oklch(0.90 0.012 35);
        /* Very dark brown text */
        --foreground: oklch(0.18 0.01 30);
        --border: oklch(0.75 0.015 30);
        /* Bright pink accent for links */
        --accent: oklch(0.78 0.15 345);
      }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        /* Slate violet background */
        --background: oklch(0.23 0.015 285);
        /* Light gray text */
        --foreground: oklch(0.90 0.005 285);
        /* Subtle borders */
        --border: oklch(0.38 0.02 285);
        /* Soft pink accent */
        --accent: oklch(0.85 0.08 5);
      }
    }
    body {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
      background: var(--background);
      color: var(--foreground);
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      justify-content: center;
      align-items: center;
      text-align: center;
    }
    h1 {
      font-size: 6rem;
      margin: 0;
      font-weight: 700;
      line-height: 1;
    }
    h2 {
      font-size: 1.5rem;
      margin: 1rem 0 2rem;
      font-weight: 400;
      opacity: 0.8;
    }
    p {
      font-size: 1rem;
      opacity: 0.7;
      margin-bottom: 2rem;
    }
    a {
      color: var(--accent);
      text-decoration: none;
      font-size: 1rem;
    }
    a:hover {
      text-decoration: underline;
    }
    footer {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      text-align: center;
      font-size: 0.875rem;
      opacity: 0.7;
      color: var(--foreground);
    }
    footer a {
      color: var(--accent);
      text-decoration: none;
      display: inline;
    }
    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div>
    <h1>404</h1>
    <h2>Page not found</h2>
    <p>The page you're looking for doesn't exist.</p>
    <a href="/">← Back to home</a>
  </div>
  <footer>
    Hosted on <a href="https://wisp.place" target="_blank" rel="noopener">wisp.place</a> - Made by <a href="https://bsky.app/profile/nekomimi.pet" target="_blank" rel="noopener">@nekomimi.pet</a>
  </footer>
</body>
</html>`;
  return html;
}

/**
 * Generate directory listing HTML
 */
function generateDirectoryListing(path: string, entries: Array<{name: string, isDirectory: boolean}>): string {
  const title = path || 'Index';

  // Sort: directories first, then files, alphabetically within each group
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Index of /${path}</title>
  <style>
    @media (prefers-color-scheme: light) {
      :root {
        /* Warm beige background */
        --background: oklch(0.90 0.012 35);
        /* Very dark brown text */
        --foreground: oklch(0.18 0.01 30);
        --border: oklch(0.75 0.015 30);
        /* Bright pink accent for links */
        --accent: oklch(0.78 0.15 345);
        /* Lavender for folders */
        --folder: oklch(0.60 0.12 295);
        --icon: oklch(0.28 0.01 30);
      }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        /* Slate violet background */
        --background: oklch(0.23 0.015 285);
        /* Light gray text */
        --foreground: oklch(0.90 0.005 285);
        /* Subtle borders */
        --border: oklch(0.38 0.02 285);
        /* Soft pink accent */
        --accent: oklch(0.85 0.08 5);
        /* Lavender for folders */
        --folder: oklch(0.70 0.10 295);
        --icon: oklch(0.85 0.005 285);
      }
    }
    body {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
      background: var(--background);
      color: var(--foreground);
      padding: 2rem;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 2rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    ul {
      list-style: none;
      padding: 0;
    }
    li {
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
    }
    li:last-child {
      border-bottom: none;
    }
    li a {
      color: var(--accent);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    li a:hover {
      text-decoration: underline;
    }
    .folder {
      color: var(--folder);
      font-weight: 600;
    }
    .file {
      color: var(--accent);
    }
    .folder::before,
    .file::before,
    .parent::before {
      content: "";
      display: inline-block;
      width: 1.25em;
      height: 1.25em;
      background-color: var(--icon);
      flex-shrink: 0;
      -webkit-mask-size: contain;
      mask-size: contain;
      -webkit-mask-repeat: no-repeat;
      mask-repeat: no-repeat;
      -webkit-mask-position: center;
      mask-position: center;
    }
    .folder::before {
      -webkit-mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M64 15v37a5.006 5.006 0 0 1-5 5H5a5.006 5.006 0 0 1-5-5V12a5.006 5.006 0 0 1 5-5h14.116a6.966 6.966 0 0 1 5.466 2.627l5 6.247A2.983 2.983 0 0 0 31.922 17H59a1 1 0 0 1 0 2H31.922a4.979 4.979 0 0 1-3.9-1.876l-5-6.247A4.976 4.976 0 0 0 19.116 9H5a3 3 0 0 0-3 3v40a3 3 0 0 0 3 3h54a3 3 0 0 0 3-3V15a3 3 0 0 0-3-3H30a1 1 0 0 1 0-2h29a5.006 5.006 0 0 1 5 5z"/></svg>');
      mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M64 15v37a5.006 5.006 0 0 1-5 5H5a5.006 5.006 0 0 1-5-5V12a5.006 5.006 0 0 1 5-5h14.116a6.966 6.966 0 0 1 5.466 2.627l5 6.247A2.983 2.983 0 0 0 31.922 17H59a1 1 0 0 1 0 2H31.922a4.979 4.979 0 0 1-3.9-1.876l-5-6.247A4.976 4.976 0 0 0 19.116 9H5a3 3 0 0 0-3 3v40a3 3 0 0 0 3 3h54a3 3 0 0 0 3-3V15a3 3 0 0 0-3-3H30a1 1 0 0 1 0-2h29a5.006 5.006 0 0 1 5 5z"/></svg>');
    }
    .file::before {
      -webkit-mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><g><path d="M18 8.28a.59.59 0 0 0-.13-.18l-4-3.9h-.05a.41.41 0 0 0-.15-.2.41.41 0 0 0-.19 0h-9a.5.5 0 0 0-.5.5v19a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V8.43a.58.58 0 0 0 .02-.15zM16.3 8H14V5.69zM5 23V5h8v3.5a.49.49 0 0 0 .15.36.5.5 0 0 0 .35.14l3.5-.06V23z"/><path d="M20.5 1h-13a.5.5 0 0 0-.5.5V3a.5.5 0 0 0 1 0V2h12v18h-1a.5.5 0 0 0 0 1h1.5a.5.5 0 0 0 .5-.5v-19a.5.5 0 0 0-.5-.5z"/><path d="M7.5 8h3a.5.5 0 0 0 0-1h-3a.5.5 0 0 0 0 1zM7.5 11h4a.5.5 0 0 0 0-1h-4a.5.5 0 0 0 0 1zM13.5 13h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zM13.5 16h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zM13.5 19h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1z"/></g></svg>');
      mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><g><path d="M18 8.28a.59.59 0 0 0-.13-.18l-4-3.9h-.05a.41.41 0 0 0-.15-.2.41.41 0 0 0-.19 0h-9a.5.5 0 0 0-.5.5v19a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V8.43a.58.58 0 0 0 .02-.15zM16.3 8H14V5.69zM5 23V5h8v3.5a.49.49 0 0 0 .15.36.5.5 0 0 0 .35.14l3.5-.06V23z"/><path d="M20.5 1h-13a.5.5 0 0 0-.5.5V3a.5.5 0 0 0 1 0V2h12v18h-1a.5.5 0 0 0 0 1h1.5a.5.5 0 0 0 .5-.5v-19a.5.5 0 0 0-.5-.5z"/><path d="M7.5 8h3a.5.5 0 0 0 0-1h-3a.5.5 0 0 0 0 1zM7.5 11h4a.5.5 0 0 0 0-1h-4a.5.5 0 0 0 0 1zM13.5 13h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zM13.5 16h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1zM13.5 19h-6a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1z"/></g></svg>');
    }
    .parent::before {
      -webkit-mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>');
      mask-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>');
    }
    footer {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      text-align: center;
      font-size: 0.875rem;
      opacity: 0.7;
      color: var(--foreground);
    }
    footer a {
      color: var(--accent);
      text-decoration: none;
      display: inline;
    }
    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <h1>Index of /${path}</h1>
  <ul>
    ${path ? '<li><a href="../" class="parent">../</a></li>' : ''}
    ${sortedEntries.map(e =>
      `<li><a href="${e.name}${e.isDirectory ? '/' : ''}" class="${e.isDirectory ? 'folder' : 'file'}">${e.name}${e.isDirectory ? '/' : ''}</a></li>`
    ).join('\n    ')}
  </ul>
  <footer>
    Hosted on <a href="https://wisp.place" target="_blank" rel="noopener">wisp.place</a> - Made by <a href="https://bsky.app/profile/nekomimi.pet" target="_blank" rel="noopener">@nekomimi.pet</a>
  </footer>
</body>
</html>`;
  return html;
}

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

/**
 * Return a response indicating the site is being updated
 */
function siteUpdatingResponse(): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Site Updating</title>
  <style>
    @media (prefers-color-scheme: light) {
      :root {
        --background: oklch(0.90 0.012 35);
        --foreground: oklch(0.18 0.01 30);
        --primary: oklch(0.35 0.02 35);
        --accent: oklch(0.78 0.15 345);
      }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: oklch(0.23 0.015 285);
        --foreground: oklch(0.90 0.005 285);
        --primary: oklch(0.70 0.10 295);
        --accent: oklch(0.85 0.08 5);
      }
    }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: var(--background);
      color: var(--foreground);
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 500px;
    }
    h1 {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      font-weight: 600;
      color: var(--primary);
    }
    p {
      font-size: 1.25rem;
      opacity: 0.8;
      margin-bottom: 2rem;
      color: var(--foreground);
    }
    .spinner {
      border: 4px solid var(--accent);
      border-radius: 50%;
      border-top: 4px solid var(--primary);
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 0 auto;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
  <meta http-equiv="refresh" content="3">
</head>
<body>
  <div class="container">
    <h1>Site Updating</h1>
    <p>This site is undergoing an update right now. Check back in a moment...</p>
    <div class="spinner"></div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Retry-After': '3',
    },
  });
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
  // Load settings for this site
  const settings = await getCachedSettings(did, rkey);
  const indexFiles = getIndexFiles(settings);

  // Check for redirect rules first (_redirects wins over settings)
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
        let checkPath = filePath || indexFiles[0];
        if (checkPath.endsWith('/')) {
          checkPath += indexFiles[0];
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

// Internal function to serve a file (used by both normal serving and rewrites)
async function serveFileInternal(did: string, rkey: string, filePath: string, settings: WispSettings | null = null) {
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
  const fileRequestPath = requestPath || indexFiles[0];
  const cacheKey = getCacheKey(did, rkey, fileRequestPath);
  const cachedFile = getCachedFilePath(did, rkey, fileRequestPath);

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
    const mimeType = lookup(cachedFile) || 'application/octet-stream';
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
      const response = await serveFileInternal(did, rkey, custom404File, settings);
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
      const response = await serveFileInternal(did, rkey, auto404Page, settings);
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

// Helper to serve files from cache with HTML path rewriting for sites.wisp.place routes
async function serveFromCacheWithRewrite(
  did: string,
  rkey: string,
  filePath: string,
  basePath: string,
  fullUrl?: string,
  headers?: Record<string, string>
) {
  // Load settings for this site
  const settings = await getCachedSettings(did, rkey);
  const indexFiles = getIndexFiles(settings);

  // Check for redirect rules first (_redirects wins over settings)
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
        let checkPath = filePath || indexFiles[0];
        if (checkPath.endsWith('/')) {
          checkPath += indexFiles[0];
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

// Internal function to serve a file with rewriting
async function serveFileInternalWithRewrite(did: string, rkey: string, filePath: string, basePath: string, settings: WispSettings | null = null) {
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
  const fileRequestPath = requestPath || indexFiles[0];
  const cacheKey = getCacheKey(did, rkey, fileRequestPath);
  const cachedFile = getCachedFilePath(did, rkey, fileRequestPath);

  // Check for rewritten HTML in cache first (if it's HTML)
  const mimeTypeGuess = lookup(fileRequestPath) || 'application/octet-stream';
  if (isHtmlContent(fileRequestPath, mimeTypeGuess)) {
    const rewrittenKey = getCacheKey(did, rkey, fileRequestPath, `rewritten:${basePath}`);
    const rewrittenContent = rewrittenHtmlCache.get(rewrittenKey);
    if (rewrittenContent) {
      const headers: Record<string, string> = {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'public, max-age=300',
      };
      applyCustomHeaders(headers, fileRequestPath, settings);
      return new Response(rewrittenContent, { headers });
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
    if (isHtmlContent(fileRequestPath, mimeType)) {
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
      const rewritten = rewriteHtmlPaths(htmlContent, basePath, fileRequestPath);

      // Recompress and cache the rewritten HTML
      const { gzipSync } = await import('zlib');
      const recompressed = gzipSync(Buffer.from(rewritten, 'utf-8'));

      const rewrittenKey = getCacheKey(did, rkey, fileRequestPath, `rewritten:${basePath}`);
      rewrittenHtmlCache.set(rewrittenKey, recompressed, recompressed.length);

      const htmlHeaders: Record<string, string> = {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'public, max-age=300',
      };
      applyCustomHeaders(htmlHeaders, fileRequestPath, settings);
      return new Response(recompressed, { headers: htmlHeaders });
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
      const indexCacheKey = getCacheKey(did, rkey, indexPath);
      const indexFile = getCachedFilePath(did, rkey, indexPath);

      // Check for rewritten index file in cache
      const rewrittenKey = getCacheKey(did, rkey, indexPath, `rewritten:${basePath}`);
      const rewrittenContent = rewrittenHtmlCache.get(rewrittenKey);
      if (rewrittenContent) {
        const headers: Record<string, string> = {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=300',
        };
        applyCustomHeaders(headers, indexPath, settings);
        return new Response(rewrittenContent, { headers });
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

        const headers: Record<string, string> = {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Cache-Control': 'public, max-age=300',
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
      const response = await serveFileInternalWithRewrite(did, rkey, custom404File, basePath, settings);
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
      const response = await serveFileInternalWithRewrite(did, rkey, auto404Page, basePath, settings);
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

  // Mark site as being cached to prevent serving stale content during update
  markSiteAsBeingCached(did, rkey);

  try {
    await downloadAndCacheSite(did, rkey, siteData.record, pdsEndpoint, siteData.cid);
    // Clear redirect rules cache since the site was updated
    clearRedirectRulesCache(did, rkey);
    logger.info('Site cached successfully', { did, rkey });
    return true;
  } catch (err) {
    logger.error('Failed to cache site', err, { did, rkey });
    return false;
  } finally {
    // Always unmark, even if caching fails
    unmarkSiteAsBeingCached(did, rkey);
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

  // Check if this is sites.wisp.place subdomain (strip port for comparison)
  const hostnameWithoutPort = hostname.split(':')[0];
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

    // Check if site is currently being cached - return updating response early
    if (isSiteBeingCached(did, site)) {
      return siteUpdatingResponse();
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

    // Check if site is currently being cached - return updating response early
    if (isSiteBeingCached(customDomain.did, rkey)) {
      return siteUpdatingResponse();
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

    // Check if site is currently being cached - return updating response early
    if (isSiteBeingCached(domainInfo.did, rkey)) {
      return siteUpdatingResponse();
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

  // Check if site is currently being cached - return updating response early
  if (isSiteBeingCached(customDomain.did, rkey)) {
    return siteUpdatingResponse();
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
