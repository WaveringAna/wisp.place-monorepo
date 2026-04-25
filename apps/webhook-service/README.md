# Wisp Webhook Service

Delivers HTTP webhook notifications when AT Protocol records change. Watches the firehose for `place.wisp.v2.wh` record creations/updates/deletions, then sends matching events to registered URLs.

## Setup

```bash
bun install
bun run start
```

## Environment Variables

```bash
DATABASE_URL="postgres://user:password@localhost:5432/wisp"
JETSTREAM_URL="wss://jetstream2.us-east.bsky.network/subscribe"
HEALTH_PORT=3003
DELIVERY_TIMEOUT_MS=10000
DELIVERY_MAX_RETRIES=3
REDIS_URL="redis://localhost:6379"
WEBHOOK_EVENTS_CHANNEL="webhook:events"
```

See the [webhook documentation](../../docs/src/content/docs/lexicons/place-wisp-wh.md) for the full record schema, payload format, and signature verification.
