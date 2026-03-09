import { createLogger } from '@wispplace/observability';
import { config } from './config';
import { startFirehose, stopFirehose, getFirehoseHealth } from './lib/firehose';
import { closeDatabase, db } from './lib/db';

const logger = createLogger('webhook-service');

Bun.serve({
  port: 3004,
  routes: {
    '/': {
      POST: async (req) => {
        const body = await req.json();
        console.log('[webhook-receiver]', JSON.stringify(body, null, 2));
        return new Response('ok');
      },
    },
  },
  fetch: () => new Response('Not Found', { status: 404 }),
});

Bun.serve({
  port: 3005,
  routes: {
    '/': async () => {
      const rows = await db`SELECT k, v, updated_at FROM webhook_records ORDER BY updated_at DESC`;
      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>webhook_records</title>
<style>
  body { font-family: monospace; padding: 1rem; background: #111; color: #eee; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #444; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #222; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 0.85em; }
</style>
</head>
<body>
<h2>webhook_records (${rows.length})</h2>
<p><a href="/webhooks" style="color:#aaf">webhooks</a></p>
<table>
  <tr><th>k</th><th>v</th><th>updated_at</th></tr>
  ${rows.map((r: any) => `<tr><td>${r.k}</td><td><pre>${JSON.stringify(r.v, null, 2)}</pre></td><td>${new Date(Number(r.updated_at) * 1000).toISOString()}</td></tr>`).join('')}
</table>
</body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    },
    '/webhooks': async () => {
      const rows = await db`SELECT did, rkey, url, scope_aturi, enabled, created_at, updated_at FROM webhooks ORDER BY updated_at DESC`;
      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>webhooks</title>
<style>
  body { font-family: monospace; padding: 1rem; background: #111; color: #eee; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #444; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #222; }
</style>
</head>
<body>
<h2>webhooks (${rows.length})</h2>
<p><a href="/" style="color:#aaf">webhook_records</a></p>
<table>
  <tr><th>did</th><th>rkey</th><th>url</th><th>scope_aturi</th><th>enabled</th><th>updated_at</th></tr>
  ${rows.map((r: any) => `<tr><td>${r.did}</td><td>${r.rkey}</td><td>${r.url}</td><td>${r.scope_aturi}</td><td>${r.enabled}</td><td>${new Date(Number(r.updated_at) * 1000).toISOString()}</td></tr>`).join('')}
</table>
</body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    },

  },
  fetch: () => new Response('Not Found', { status: 404 }),
});

Bun.serve({
  port: config.healthPort,
  routes: {
    '/health': () => {
      const firehose = getFirehoseHealth();
      return Response.json({
        status: firehose.healthy ? 'healthy' : 'degraded',
        firehose,
      });
    },
  },
  fetch: () => new Response('Not Found', { status: 404 }),
});

let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Received ${signal}, shutting down...`);
  stopFirehose();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  logger.info('Starting webhook-service');
  logger.info(`Firehose: ${config.firehoseService}`);
  logger.info(`Health endpoint: http://localhost:${config.healthPort}/health`);

  startFirehose();
}

main().catch((err) => {
  logger.error('Fatal error', err);
  process.exit(1);
});
