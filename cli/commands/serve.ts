import { IdResolver } from '@atproto/identity';
import { Firehose } from '@atproto/sync';
import { Hono } from 'hono';
import { serve as honoNodeServe } from '@hono/node-server';
import type { Record as SettingsRecord } from '@wisp/lexicons/types/place/wisp/settings';
import { resolveDid, getPdsForDid } from '@wisp/atproto-utils';
import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join, extname } from 'path';
import { lookup } from 'mime-types';
import { pull } from './pull.ts';
import { createSpinner, pc } from '../lib/progress.ts';
import { parseRedirectsFile, matchRedirectRule, parseQueryString, type RedirectRule } from '@wisp/fs-utils';
import { isBun } from '../lib/runtime.ts';
import { BunFirehose } from '../lib/firehose.ts';

export interface ServeOptions {
  site: string;
  path: string;
  port: number;
}

interface SiteState {
  did: string;
  rkey: string;
  pdsEndpoint: string;
  siteDir: string;
  settings: SettingsRecord | null;
  redirectRules: RedirectRule[];
}

async function fetchSettings(pdsEndpoint: string, did: string, rkey: string): Promise<SettingsRecord | null> {
  try {
    const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.settings&rkey=${encodeURIComponent(rkey)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as { value: SettingsRecord };
    return data.value;
  } catch {
    return null;
  }
}

function loadRedirectRules(siteDir: string): RedirectRule[] {
  const redirectsPath = join(siteDir, '_redirects');
  if (!existsSync(redirectsPath)) {
    return [];
  }
  try {
    const content = readFileSync(redirectsPath, 'utf-8');
    return parseRedirectsFile(content);
  } catch {
    return [];
  }
}

function getIndexFiles(settings: SettingsRecord | null): string[] {
  return settings?.indexFiles || ['index.html', 'index.htm'];
}

function generateDirectoryListing(dirPath: string, urlPath: string): string {
  const entries = readdirSync(dirPath, { withFileTypes: true });

  const items = entries
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .map(entry => {
      const isDir = entry.isDirectory();
      const name = isDir ? `${entry.name}/` : entry.name;
      const href = urlPath === '/' ? `/${entry.name}` : `${urlPath}/${entry.name}`;
      return `<li><a href="${href}">${name}</a></li>`;
    });

  const parentLink = urlPath !== '/'
    ? `<li><a href="${urlPath.split('/').slice(0, -1).join('/') || '/'}">..</a></li>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><title>Index of ${urlPath}</title>
<style>body{font-family:system-ui;padding:2rem}ul{list-style:none;padding:0}li{padding:0.25rem 0}a{color:#0066cc}</style>
</head>
<body>
<h1>Index of ${urlPath}</h1>
<ul>${parentLink}${items.join('')}</ul>
</body>
</html>`;
}

function generate404Page(): string {
  return `<!DOCTYPE html>
<html>
<head><title>404 Not Found</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.container{text-align:center}h1{font-size:4rem;margin:0;color:#666}p{color:#999}</style>
</head>
<body>
<div class="container"><h1>404</h1><p>Page not found</p></div>
</body>
</html>`;
}

function serveFile(filePath: string): Response {
  const content = readFileSync(filePath);
  const mimeType = lookup(filePath) || 'application/octet-stream';

  return new Response(content, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'no-cache'
    }
  });
}

function handleRequest(req: Request, state: SiteState): Response {
  const url = new URL(req.url);
  let urlPath = decodeURIComponent(url.pathname);

  // Prevent directory traversal
  if (urlPath.includes('..')) {
    return new Response('Forbidden', { status: 403 });
  }

  // Check redirect rules first
  const queryParams = parseQueryString(url.search);
  const redirectMatch = matchRedirectRule(urlPath, state.redirectRules, { queryParams });

  if (redirectMatch) {
    if (redirectMatch.status === 200) {
      // Rewrite - serve the target path instead
      urlPath = redirectMatch.targetPath;
    } else if ([301, 302, 307, 308].includes(redirectMatch.status)) {
      // Redirect
      return new Response(null, {
        status: redirectMatch.status,
        headers: { Location: redirectMatch.targetPath }
      });
    } else if (redirectMatch.status === 404) {
      // Custom 404
      const custom404Path = join(state.siteDir, redirectMatch.targetPath);
      if (existsSync(custom404Path)) {
        const content = readFileSync(custom404Path);
        return new Response(content, {
          status: 404,
          headers: { 'Content-Type': 'text/html' }
        });
      }
    }
  }

  // Resolve file path
  let filePath = join(state.siteDir, urlPath);

  // Check if it's a directory
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    // Try index files
    const indexFiles = getIndexFiles(state.settings);
    for (const indexFile of indexFiles) {
      const indexPath = join(filePath, indexFile);
      if (existsSync(indexPath)) {
        return serveFile(indexPath);
      }
    }

    // Directory listing if enabled
    if (state.settings?.directoryListing) {
      const html = generateDirectoryListing(filePath, urlPath);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
  }

  // Try exact file
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return serveFile(filePath);
  }

  // Clean URLs - try adding .html
  if (state.settings?.cleanUrls !== false) {
    const htmlPath = `${filePath}.html`;
    if (existsSync(htmlPath) && statSync(htmlPath).isFile()) {
      return serveFile(htmlPath);
    }

    // Try /path/index.html
    const indexPath = join(filePath, 'index.html');
    if (existsSync(indexPath) && statSync(indexPath).isFile()) {
      return serveFile(indexPath);
    }
  }

  // SPA mode - serve index.html for all routes
  if (state.settings?.spaMode) {
    const spaPath = join(state.siteDir, state.settings.spaMode);
    if (existsSync(spaPath)) {
      return serveFile(spaPath);
    }
  }

  // Custom 404
  if (state.settings?.custom404) {
    const custom404Path = join(state.siteDir, state.settings.custom404);
    if (existsSync(custom404Path)) {
      const content = readFileSync(custom404Path);
      return new Response(content, {
        status: 404,
        headers: { 'Content-Type': 'text/html' }
      });
    }
  }

  // Auto-detect 404.html
  const auto404Paths = ['404.html', 'not_found.html'];
  for (const notFoundFile of auto404Paths) {
    const notFoundPath = join(state.siteDir, notFoundFile);
    if (existsSync(notFoundPath)) {
      const content = readFileSync(notFoundPath);
      return new Response(content, {
        status: 404,
        headers: { 'Content-Type': 'text/html' }
      });
    }
  }

  // Default 404
  return new Response(generate404Page(), {
    status: 404,
    headers: { 'Content-Type': 'text/html' }
  });
}

export async function serve(
  identifier: string,
  options: ServeOptions
): Promise<void> {
  const { site, path: outputPath, port } = options;

  console.log(pc.cyan(`\nServing ${pc.bold(site)} from ${identifier}\n`));

  // 1. Resolve DID
  const spinner = createSpinner('Resolving identity...').start();
  const did = await resolveDid(identifier);

  if (!did) {
    spinner.fail('Failed to resolve identity');
    throw new Error(`Could not resolve: ${identifier}`);
  }

  spinner.succeed(`Resolved to ${did}`);

  // 2. Get PDS endpoint
  const pdsSpinner = createSpinner('Getting PDS endpoint...').start();
  const pdsEndpoint = await getPdsForDid(did);

  if (!pdsEndpoint) {
    pdsSpinner.fail('Failed to get PDS endpoint');
    throw new Error(`Could not get PDS for: ${did}`);
  }

  pdsSpinner.succeed(`PDS: ${pdsEndpoint}`);

  // 3. Initial pull
  await pull(identifier, { site, path: outputPath });

  // 4. Load settings and redirects
  const settings = await fetchSettings(pdsEndpoint, did, site);
  const redirectRules = loadRedirectRules(outputPath);

  const state: SiteState = {
    did,
    rkey: site,
    pdsEndpoint,
    siteDir: outputPath,
    settings,
    redirectRules
  };

  // 5. Start HTTP server with Hono (works on both Bun and Node)
  const app = new Hono();

  app.all('*', (c) => {
    const req = c.req.raw;
    return handleRequest(req, state);
  });

  let serverHandle: { close: () => void };

  if (isBun) {
    // @ts-ignore - Bun global
    const bunServer = Bun.serve({
      port,
      fetch: app.fetch,
    });
    serverHandle = { close: () => bunServer.stop() };
  } else {
    const nodeServer = honoNodeServe({
      fetch: app.fetch,
      port,
    });
    serverHandle = { close: () => nodeServer.close() };
  }

  console.log(pc.green(`\n✓ Server running at http://localhost:${port}\n`));
  console.log(pc.dim('Watching for updates via firehose...\n'));

  // 6. Connect to firehose for live updates (runtime-aware)
  const idResolver = new IdResolver();

  const firehoseHandleEvent = async (evt: any) => {
    // Only handle commit events for this DID
    if (evt.event !== 'create' && evt.event !== 'update' && evt.event !== 'delete') return;
    if (evt.did !== did) return;
    if (evt.rkey !== site) return;

    if (evt.collection === 'place.wisp.fs') {
      console.log(pc.yellow('\nSite updated, re-pulling...\n'));
      await pull(identifier, { site, path: outputPath });

      // Reload redirects
      state.redirectRules = loadRedirectRules(outputPath);
      console.log(pc.green('✓ Site reloaded\n'));
    } else if (evt.collection === 'place.wisp.settings') {
      console.log(pc.yellow('\nSettings updated...\n'));
      state.settings = await fetchSettings(pdsEndpoint, did, site);
      console.log(pc.green('✓ Settings reloaded\n'));
    }
  };

  const firehoseOnError = (err: Error) => {
    console.error(pc.red('Firehose error:'), err.message);
    if (err.cause) {
      console.error(pc.red('  Cause:'), err.cause);
    }
  };

  let firehoseHandle: { destroy: () => void };

  if (isBun) {
    // Use BunFirehose for Bun
    const bunFirehose = new BunFirehose({
      idResolver,
      service: pdsEndpoint,
      filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
      handleEvent: firehoseHandleEvent,
      onError: firehoseOnError,
    });
    bunFirehose.start();
    firehoseHandle = { destroy: () => bunFirehose.destroy() };
  } else {
    // Use @atproto/sync Firehose for Node.js
    const nodeFirehose = new Firehose({
      idResolver,
      service: pdsEndpoint,
      filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
      handleEvent: firehoseHandleEvent,
      onError: firehoseOnError,
    });
    nodeFirehose.start();
    firehoseHandle = { destroy: () => nodeFirehose.destroy() };
  }

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log(pc.dim('\nShutting down...'));
    firehoseHandle.destroy();
    serverHandle.close();
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}
