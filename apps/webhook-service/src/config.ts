export const config = {
  firehoseService: process.env.FIREHOSE_SERVICE || 'wss://bsky.network',
  healthPort: parseInt(process.env.HEALTH_PORT || '3003', 10),
  deliveryTimeoutMs: parseInt(process.env.DELIVERY_TIMEOUT_MS || '10000', 10),
  deliveryMaxRetries: parseInt(process.env.DELIVERY_MAX_RETRIES || '3', 10),
} as const;
