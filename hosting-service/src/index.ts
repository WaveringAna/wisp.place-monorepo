import { serve } from 'bun';
import app from './server';
import { FirehoseWorker } from './lib/firehose';
import { mkdirSync, existsSync } from 'fs';

const PORT = process.env.PORT || 3001;
const CACHE_DIR = './cache/sites';

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log('Created cache directory:', CACHE_DIR);
}

// Start firehose worker
const firehose = new FirehoseWorker((msg, data) => {
  console.log(msg, data);
});

firehose.start();

// Add health check endpoint
app.get('/health', (c) => {
  const firehoseHealth = firehose.getHealth();
  return c.json({
    status: 'ok',
    firehose: firehoseHealth,
  });
});

// Start HTTP server
const server = serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`
Wisp Hosting Service

Server:    http://localhost:${PORT}
Health:    http://localhost:${PORT}/health
Cache:     ${CACHE_DIR}
Firehose:  Connected to Jetstream
`);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  firehose.stop();
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down...');
  firehose.stop();
  server.stop();
  process.exit(0);
});
