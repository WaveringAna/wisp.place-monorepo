import { serve } from 'bun';
import app from './server';
import { FirehoseWorker } from './lib/firehose';
import { DNSVerificationWorker } from './lib/dns-verification-worker';
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

// Start DNS verification worker (runs every hour)
const dnsVerifier = new DNSVerificationWorker(
  60 * 60 * 1000, // 1 hour
  (msg, data) => {
    console.log('[DNS Verifier]', msg, data || '');
  }
);

dnsVerifier.start();

// Add health check endpoint
app.get('/health', (c) => {
  const firehoseHealth = firehose.getHealth();
  const dnsVerifierHealth = dnsVerifier.getHealth();
  return c.json({
    status: 'ok',
    firehose: firehoseHealth,
    dnsVerifier: dnsVerifierHealth,
  });
});

// Add manual DNS verification trigger (for testing/admin)
app.post('/admin/verify-dns', async (c) => {
  try {
    await dnsVerifier.trigger();
    return c.json({
      success: true,
      message: 'DNS verification triggered',
    });
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});

// Start HTTP server
const server = serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`
Wisp Hosting Service

Server:       http://localhost:${PORT}
Health:       http://localhost:${PORT}/health
Cache:        ${CACHE_DIR}
Firehose:     Connected to Jetstream
DNS Verifier: Checking every hour
`);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  firehose.stop();
  dnsVerifier.stop();
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down...');
  firehose.stop();
  dnsVerifier.stop();
  server.stop();
  process.exit(0);
});
