import app from './server';
import { FirehoseWorker } from './lib/firehose';
import { logger } from './lib/observability';
import { mkdirSync, existsSync } from 'fs';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const CACHE_DIR = './cache/sites';

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log('Created cache directory:', CACHE_DIR);
}

// Start firehose worker with observability logger
const firehose = new FirehoseWorker((msg, data) => {
  logger.info(msg, data);
});

firehose.start();

// Add health check endpoint
app.get('/health', () => {
  const firehoseHealth = firehose.getHealth();
  return {
    status: 'ok',
    firehose: firehoseHealth,
  };
});

// Start HTTP server
app.listen(PORT, () => {
  console.log(`
Wisp Hosting Service

Server:       http://localhost:${PORT}
Health:       http://localhost:${PORT}/health
Cache:        ${CACHE_DIR}
Firehose:     Connected to Firehose
`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  firehose.stop();
  app.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  firehose.stop();
  app.stop();
  process.exit(0);
});
