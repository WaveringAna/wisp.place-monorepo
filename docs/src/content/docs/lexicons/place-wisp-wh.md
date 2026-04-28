---
title: place.wisp.v2.wh
description: Webhook record lexicon for receiving HTTP callbacks on AT Protocol events
---

Webhooks let you receive HTTP POST notifications when AT Protocol records are created, updated, or deleted. They're scoped to an AT-URI — you can watch a specific record, an entire collection, or everything from a DID.

Webhooks are stored as `place.wisp.v2.wh` records in your AT Protocol repository. The webhook service watches the firehose for `place.wisp.v2.wh` record changes, reads the full record back from your PDS (read-after-write), then begins delivering matching events to your URL.

## Creating a Webhook

Create a webhook by writing a `place.wisp.v2.wh` record to your PDS, or by using the **Webhooks** tab in the editor. The record schema is [below](#record-schema).

**Scope** controls what you're watching:

| Scope AT-URI | Watches |
|---|---|
| `at://did:plc:abc` | All record changes from that DID |
| `at://did:plc:abc/app.bsky.feed.post` | All posts from that DID |
| `at://did:plc:abc/app.bsky.feed.post/rkey` | One specific record |

Enable **backlinks** to also fire when records in *any* repo reference your DID or collection — useful for watching Bluesky likes, Tangled pull requests, etc directed at you.

**Events** can be filtered to `create`, `update`, `delete`, or any combination. Omit the filter to receive all three.

**Signing** — attach a signing secret to get an `X-Webhook-Signature` header on every delivery. Two options:

- `secret` — embed a plaintext value directly in your PDS record. Simple, but the secret is stored in your public repo.
- `secretId` — reference a server-managed secret by name (created via `place.wisp.v2.secret.create`). The token is never stored in your PDS record and can be rotated without updating the webhook. **Prefer this.**

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

If a signing secret is set (via `secret` or `secretId`), every delivery includes an `X-Webhook-Signature: sha256=<hex>` header. Verify it using HMAC-SHA256 over the **raw request body**:

```typescript
import { createHmac, timingSafeEqual } from 'crypto'

function verifySignature(body: string, secret: string, header: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected))
}
```

Always use a timing-safe comparison. Compute the HMAC before parsing the body.

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
  "secretId": "my-secret",
  "enabled": true,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `scope.aturi` | string | AT-URI to watch |
| `scope.backlinks` | boolean | Also fire when other repos reference this scope |
| `url` | string | HTTPS endpoint to deliver to |
| `events` | string[] | `create`, `update`, `delete` — omit for all three |
| `secretId` | string | Name of a server-managed signing secret (preferred) |
| `secret` | string | Inline HMAC secret (stored plaintext in PDS) |
| `enabled` | boolean | Set to `false` to pause delivery |

## API Convenience Routes

The main app exposes API routes that wrap PDS record operations. All routes require the signed `did` cookie.

### `GET /api/webhook`

Lists all webhook records for the authenticated user.

### `POST /api/webhook`

Creates a new webhook record. Body:

```json
{
  "scopeAturi": "at://did:plc:abc123/app.bsky.feed.post",
  "url": "https://example.com/webhook",
  "backlinks": false,
  "events": ["create"],
  "secretId": "my-secret",
  "enabled": true
}
```

### `DELETE /api/webhook/:rkey`

Deletes a webhook record by its record key.

### `GET /api/webhook/events`

Returns the last 100 delivery events for the authenticated user.

## Signing Secrets API

Server-managed secrets are never stored in your PDS — the token is returned once at creation time and then only stored as a hash. Manage them via:

### `GET /api/secret`

Lists all secrets (names and metadata only — tokens are never returned after creation).

### `POST /api/secret`

Creates a new secret. Body: `{ "name": "my-secret" }`.

Response includes `token` — **copy it now**, it will not be shown again.

```json
{ "success": true, "name": "my-secret", "token": "wsk_...", "createdAt": "..." }
```

### `POST /api/secret/:name/rotate`

Generates a new token for an existing secret. The old token stops working immediately. Returns the new `token` once.

### `DELETE /api/secret/:name`

Deletes a secret. Any webhooks referencing this `secretId` will stop being signed.

These routes are also available as XRPC procedures under `place.wisp.v2.secret.*` for programmatic access with a service JWT.

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
