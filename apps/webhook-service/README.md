# Wisp Webhook Service

Delivers HTTP webhook notifications when AT Protocol records change. Watches the firehose for `place.wisp.v2.wh` record creations/updates/deletions, then sends matching events to registered URLs.

## Setup

```bash
bun install
bun run start
```

## Environment Variables

```bash
NODE_ENV=production
DATABASE_URL="postgres://user:password@localhost:5432/wisp"
JETSTREAM_URL="wss://jetstream2.us-east.bsky.network/subscribe"
# Defaults to 127.0.0.1. The container image sets 0.0.0.0 for orchestration.
HEALTH_HOST=127.0.0.1
HEALTH_PORT=3003
DELIVERY_TIMEOUT_MS=10000
DELIVERY_MAX_RETRIES=3
REDIS_URL="redis://localhost:6379"
WEBHOOK_EVENTS_CHANNEL="webhook:events"
# Reconnects continue indefinitely; this only caps exponential backoff.
JETSTREAM_RECONNECT_MAX_EXPONENT=8
```

The only HTTP listener is `GET /health`; it returns bounded service status and does not expose webhook records or endpoints.

See the [webhook documentation](../../docs/src/content/docs/lexicons/place-wisp-wh.md) for the full record schema, payload format, and signature verification.
