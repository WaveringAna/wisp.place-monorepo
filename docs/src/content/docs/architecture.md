---
title: Architecture Guide
description: How the hosting service, firehose service, and tiered storage work together
---

Wisp.place's serving infrastructure is split into two microservices: the **firehose service** (write path) and the **hosting service** (read path). They communicate through S3-compatible storage and Redis pub/sub.

## Service Overview

### Firehose Service

The firehose service watches the AT Protocol firehose (Jetstream WebSocket) for `place.wisp.fs` and `place.wisp.settings` record changes. When a site is created, updated, or deleted, it:

1. Downloads all blobs from the user's PDS
2. Decompresses gzipped content
3. Rewrites HTML for subdirectory serving (absolute paths become relative)
4. Writes the processed files to S3 (or disk)
5. Publishes a cache invalidation event to Redis

The firehose service is **write-only** — it never serves requests to end users.

**Key configuration:**

```bash
# Firehose connection
FIREHOSE_URL="wss://jetstream2.us-east.bsky.network/subscribe"

# S3 storage (recommended for production)
S3_BUCKET="wisp-sites"
S3_REGION="auto"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."

# Redis for cache invalidation
REDIS_URL="redis://localhost:6379"

# Concurrency control
FIREHOSE_CONCURRENCY=5      # Max parallel event processing
```

**Backfill mode:** Start with `--backfill` to do a one-time bulk sync of all existing sites from the database into the cache.

### Hosting Service

The hosting service is a **read-only** CDN built with Node.js and Hono. It serves static files from a three-tier cache and handles routing for custom domains, wisp subdomains, and direct URLs.

On each request, the hosting service:

1. Resolves the site from the request hostname/path
2. Looks up the file in tiered storage (hot → warm → cold)
3. On a cache miss, fetches from the PDS on-demand and populates the cache
4. Applies HTML path rewriting if serving from a subdirectory
5. Processes `_redirects` rules
6. Serves the file with appropriate headers

The hosting service subscribes to Redis pub/sub for cache invalidation messages from the firehose service. When it receives an invalidation, it evicts the affected entries from its hot and warm tiers so the next request fetches fresh content.

## Tiered Storage

The `@wispplace/tiered-storage` package implements a three-tier cascading cache. Data flows **down** on writes and is looked up **upward** on reads.

```
Read path:  Hot (memory) → Warm (disk) → Cold (S3/disk)
Write path: Hot ← Warm ← Cold (writes cascade down through all tiers)
```

### Hot Tier (Memory)

- **Implementation:** In-memory LRU cache
- **Eviction:** Size-based (bytes) and count-based (max items)
- **Use case:** Frequently accessed files (index.html, CSS, JS)
- **Lost on restart** — repopulated from warm/cold tiers on access

```bash
HOT_CACHE_SIZE=104857600     # 100 MB (default)
HOT_CACHE_COUNT=500          # Max items
```

### Warm Tier (Disk)

- **Implementation:** Filesystem with human-readable paths
- **Eviction:** Configurable — `lru` (default), `fifo`, or `size`
- **Structure:** `cache/sites/{did}/{sitename}/path/to/file`
- **Survives restarts** — provides fast local reads without network calls

```bash
WARM_CACHE_SIZE=10737418240  # 10 GB (default)
WARM_EVICTION_POLICY=lru     # lru, fifo, or size
CACHE_DIR=./cache/sites
```

The warm tier is optional when S3 is configured. Without S3, disk acts as the cold (source of truth) tier.

### Cold Tier (S3 or Disk)

- **With S3:** The firehose service writes here; the hosting service reads (read-only wrapper)
- **Without S3:** A disk-based tier serves as both warm and cold
- **Compatible with:** Cloudflare R2, MinIO, AWS S3, or any S3-compatible endpoint

```bash
S3_BUCKET="wisp-sites"
S3_REGION="auto"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."
S3_METADATA_BUCKET="wisp-metadata"  # Optional, recommended for production
```

### Tier Placement Rules

Not all files are placed on every tier. The hosting service uses placement rules to keep the hot tier efficient:

| File Pattern | Tiers | Rationale |
|---|---|---|
| `index.html`, `*.css`, `*.js` | Hot, Warm, Cold | Critical for page loads |
| Rewritten HTML (`.rewritten/`) | Hot, Warm, Cold | Pre-processed for fast serving |
| Images, fonts, media (`*.jpg`, `*.woff2`, etc.) | Warm, Cold | Already compressed, large — skip memory |
| Everything else | Warm, Cold | Default placement |

### Promotion and Bootstrap

When a file is found in a lower tier but not a higher one, it's **eagerly promoted** upward. For example, a cache miss on hot that hits warm will copy the file into hot for future requests.

On startup, the hosting service can **bootstrap** tiers:
- Hot bootstraps from warm by loading the most-accessed items
- Warm bootstraps from cold by loading recently written items

## Cache Invalidation

The firehose service and hosting service communicate through Redis pub/sub:

```
Firehose Service                    Hosting Service
     │                                    │
     │  ── Redis pub/sub ──────────────→  │
     │     (wisp:revalidate)              │
     │                                    │
     │  Site updated/deleted:             │  Receives invalidation:
     │  1. Write new files to S3          │  1. Evict from hot tier
     │  2. Publish invalidation           │  2. Evict from warm tier
     │                                    │  3. Next request fetches fresh
```

If Redis is not configured, the hosting service still works — it just won't receive real-time invalidation and will rely on TTL-based expiry (default 14 days) and on-demand fetching.

## On-Demand Cache Population

When the hosting service receives a request for a site that isn't in any cache tier, it fetches directly from the user's PDS:

1. Resolves the user's DID to their PDS endpoint
2. Downloads the `place.wisp.fs` record
3. Fetches the requested blob
4. Decompresses and processes the file
5. Stores it in the appropriate tiers based on placement rules
6. Serves the response

This means the hosting service works even without the firehose service running — it just won't have pre-populated caches.

## Deployment Scenarios

### Minimal (Disk Only)

No S3 or Redis required. The hosting service uses disk as both warm and cold tier. Best for small deployments or development.

```bash
# Hosting service only
CACHE_DIR=./cache/sites
HOT_CACHE_SIZE=104857600
```

### Production (S3 + Redis)

The firehose service pre-populates S3 and notifies the hosting service of changes via Redis. Multiple hosting service instances can share the same S3 backend.

```bash
# Both services
S3_BUCKET=wisp-sites
S3_ENDPOINT=https://account.r2.cloudflarestorage.com
REDIS_URL=redis://localhost:6379

# Hosting service
HOT_CACHE_SIZE=104857600
WARM_CACHE_SIZE=10737418240
```

### Scaled (Multiple Hosting Instances)

Run multiple hosting service instances behind a load balancer. Each has its own hot and warm tiers, but they share the S3 cold tier and receive the same Redis invalidation events.

```
                    Load Balancer
                   /      |       \
          Hosting-1   Hosting-2   Hosting-3
          (hot+warm)  (hot+warm)  (hot+warm)
                   \      |       /
                    S3 (cold tier)
                         |
                   Firehose Service
```

## Observability

Both services expose internal observability endpoints:

- `/__internal__/observability/logs` — Recent log entries
- `/__internal__/observability/errors` — Error log entries
- `/__internal__/observability/metrics` — Prometheus-format metrics
- `/__internal__/observability/cache` — Cache tier statistics (hosting service only)

See [Monitoring & Metrics](/monitoring) for Grafana integration details.
