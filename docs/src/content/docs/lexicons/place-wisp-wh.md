---
title: place.wisp.v2.wh
description: Webhook record lexicon for receiving HTTP callbacks on AT Protocol events
---

Webhooks let you receive HTTP POST notifications when AT Protocol records are created, updated, or deleted. They're scoped to an AT-URI — you can watch a specific record, an entire collection, or everything from a DID.

Webhooks are stored as `place.wisp.v2.wh` records in your AT Protocol repository. The webhook service watches the firehose and delivers payloads to your URL.

## Creating a Webhook

Create and manage webhooks from the **Webhooks** tab in the editor, or via the [REST API](#rest-api).

**Scope** controls what you're watching:

| Scope AT-URI | Watches |
|---|---|
| `at://did:plc:abc` | All record changes from that DID |
| `at://did:plc:abc/app.bsky.feed.post` | All posts from that DID |
| `at://did:plc:abc/app.bsky.feed.post/rkey` | One specific record |

Enable **backlinks** to also fire when records in *any* repo reference your DID or collection — useful for watching Bluesky likes, Tangled pull requests, etc directed at you.

**Events** can be filtered to `create`, `update`, `delete`, or any combination. Omit the filter to receive all three.

**Secret** — if set, every delivery includes an `X-Webhook-Signature` header for verification.

## Payload

Each delivery is an HTTP POST with `Content-Type: application/json`:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "event": "create",
  "did": "did:plc:abc123",
  "collection": "app.bsky.feed.post",
  "rkey": "3kl2jd9s8f7g",
  "cid": "bafyreiabc...",
  "record": { ... },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

`record` is the full record body and is absent on `delete` events.

**Headers:**

```
User-Agent: wisp.place-webhook/1.0
X-Webhook-Signature: sha256=<hex>   (only if secret is set)
```

## Verifying Signatures

If you set a secret, verify the `X-Webhook-Signature` header using HMAC-SHA256:

```typescript
import { createHmac, timingSafeEqual } from 'crypto'

function verifySignature(body: string, secret: string, header: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected))
}
```

Always use a timing-safe comparison. Compute the HMAC over the raw request body before parsing.

## Delivery

The webhook service delivers with a 10 second timeout and retries up to 3 times with exponential backoff on failure. Your endpoint should return a 2xx response quickly — do any heavy processing asynchronously.

Delivery attempts are logged and visible in the editor under each webhook's event history (last 500 events per webhook).

## Record Schema

Webhooks are stored as `place.wisp.v2.wh` records in your PDS:

```json
{
  "$type": "place.wisp.v2.wh",
  "scope": {
    "aturi": "at://did:plc:abc123/app.bsky.feed.post",
    "backlinks": false
  },
  "url": "https://example.com/webhook",
  "events": ["create", "update"],
  "secret": "your-hmac-secret",
  "enabled": true,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

## REST API

Webhooks can also be managed via the main app API. All routes require the signed `did` cookie.

### `GET /api/webhook`

Lists all webhook records for the authenticated user.

### `POST /api/webhook`

Creates a new webhook. Body matches the `place.wisp.v2.wh` record shape.

### `DELETE /api/webhook/:rkey`

Deletes a webhook by its record key.

### `GET /api/webhook/events`

Returns the last 100 delivery events for the authenticated user.

```json
[
  {
    "id": "...",
    "rkey": "abc123",
    "url": "https://example.com/webhook",
    "event_kind": "create",
    "event_did": "did:plc:...",
    "event_collection": "app.bsky.feed.post",
    "event_rkey": "3kl2jd9s8f7g",
    "status": "ok",
    "delivered_at": "2024-01-15T10:30:00.000Z"
  }
]
```

## Self-Hosting

The webhook service is a separate Bun process in `apps/webhook-service`.

```bash
DATABASE_URL="postgres://user:password@localhost:5432/wisp"
JETSTREAM_URL="wss://jetstream2.us-east.bsky.network/subscribe"
HEALTH_PORT=3003
DELIVERY_TIMEOUT_MS=10000
DELIVERY_MAX_RETRIES=3
REDIS_URL="redis://localhost:6379"
WEBHOOK_EVENTS_CHANNEL="webhook:events"
```
