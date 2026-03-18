export const config = {
	jetstreamUrl: process.env.JETSTREAM_URL || 'wss://jetstream2.us-east.bsky.network/subscribe',
	healthPort: parseInt(process.env.HEALTH_PORT || '3003', 10),
	deliveryTimeoutMs: parseInt(process.env.DELIVERY_TIMEOUT_MS || '10000', 10),
	deliveryMaxRetries: parseInt(process.env.DELIVERY_MAX_RETRIES || '3', 10),
	redisUrl: process.env.REDIS_URL,
	webhookEventsChannel: process.env.WEBHOOK_EVENTS_CHANNEL || 'webhook:events',
} as const
