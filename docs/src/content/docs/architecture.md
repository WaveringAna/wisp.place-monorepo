---
title: Architecture
description: How the hosting service, firehose service, and tiered storage work together
---

Wisp.place splits into two microservices: the **firehose service** (write path) and the **hosting service** (read path). They communicate through S3-compatible storage and Redis pub/sub.

## Firehose Service

The firehose service watches the AT Protocol relay for `place.wisp.fs` and `place.wisp.settings` record changes. When a site is created or updated, it downloads all blobs from the user's PDS, rewrites HTML for subdirectory serving, writes processed files to shared S3 storage — keeping gzipped content as-is and serving it with the appropriate `Content-Encoding` header — then publishes a cache invalidation event to Redis. Disk storage is an explicit development/test fallback only.

It's write-only — it never serves requests to end users.

```bash
FIREHOSE_SERVICE="wss://bsky.network"
FIREHOSE_MAX_CONCURRENCY=5
S3_BUCKET="wisp-sites"
S3_REGION="us-east-1"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_FORCE_PATH_STYLE="false"
S3_PREFIX="sites/"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
REDIS_URL="redis://localhost:6379"
```

Start with `--backfill` to do a one-time bulk sync of all existing sites into cache.

## Hosting Service

The hosting service is a read-only CDN built with Hono. It resolves sites from the request hostname or path, looks up files in tiered storage (hot → warm → cold), applies HTML path rewriting and `_redirects` rules, and serves the file. A missing manifest or file returns a bounded 503 while durable firehose revalidation repairs storage; the request path never fetches from the user's PDS.

It subscribes to Redis pub/sub for invalidation events from the firehose service. On invalidation, it evicts affected entries from hot and warm tiers so the next request fetches fresh content.

## Tiered Storage

`@wispplace/tiered-storage` implements a three-tier cascading cache:

```
Read:   Hot (memory) → Warm (disk) → Cold (S3/disk)
Write:  Hot ← Warm ← Cold
```

The **hot tier** is an in-memory LRU cache. Fast, small, and lost on restart — repopulated from warm/cold on access.

```bash
HOT_CACHE_SIZE=104857600   # 100 MB
HOT_CACHE_COUNT=500
```

The **warm tier** is a disk cache at `cache/sites/{did}/{sitename}/path`. It survives restarts and requires no network.

```bash
WARM_CACHE_SIZE=10737418240   # 10 GB
WARM_EVICTION_POLICY=lru      # lru, fifo, or size
CACHE_DIR=./cache/sites
```

The **cold tier** is shared S3 in production-like and multi-node deployments. The firehose writes there and the hosting service reads it. Disk is allowed only when `NODE_ENV` is exactly `development` or `test`, or for an explicitly opted-in single node with `HOSTING_ALLOW_DISK_SOURCE=true`; an unknown environment never silently falls back to local disk.

```bash
S3_BUCKET="wisp-sites"
S3_REGION="us-east-1"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_FORCE_PATH_STYLE="false"
S3_PREFIX="sites/"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
```

Not everything goes on every tier. HTML, CSS, and JS go hot/warm/cold since they're critical for page loads. Large files like images and fonts skip hot — they'd just eat memory. When a file is found in a lower tier but not a higher one, it's promoted upward so the next request is faster.

## Cache Invalidation

```
Firehose                            Hosting
     │                                 │
     │  ── Redis pub/sub ────────────→ │
     │     (wisp:revalidate)           │
     │                                 │
     │  Site updated:                  │  Receives invalidation:
     │  1. Write new files to S3       │  1. Evict from hot tier
     │  2. Publish invalidation        │  2. Evict from warm tier
     │                                 │  3. Next request fetches fresh
```

Without Redis the hosting service still works with bounded TTL-based expiry. A cache miss still returns a bounded 503 while the durable revalidation worker repairs it.

## Cache Misses

The hosting service is read-only. If a site manifest is missing from the database, or an expected file is missing from storage, the request returns 503 and enqueues durable revalidation for the firehose service to re-sync from the PDS. It never resolves a DID, downloads blobs, or writes site data on the request path.

## Deployment Scenarios

**Disk only** — A single node can use disk as both warm and cold storage. It is for development or a deliberately opted-in small deployment, never a replica pool.

```bash
NODE_ENV=development             # or NODE_ENV=test
# For a non-development single node only, with no S3_BUCKET or PRIVATE_S3_BUCKET:
# HOSTING_ALLOW_DISK_SOURCE=true
CACHE_DIR=./cache/sites
HOT_CACHE_SIZE=104857600
```

**S3 + Redis** — The firehose pre-populates S3 and notifies the hosting service of changes. Multiple hosting instances can share the same S3 backend.

```bash
S3_BUCKET=wisp-sites
S3_ENDPOINT=https://account.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
REDIS_URL=redis://localhost:6379
HOT_CACHE_SIZE=104857600
WARM_CACHE_SIZE=10737418240
```

**Scaled** — Run multiple hosting instances behind a load balancer. Each has its own hot and warm tiers but shares S3 and Redis invalidation.

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

Operational observability is provided through service logs and configured Grafana exporters. The old in-memory internal endpoints were removed.

See [Monitoring & Metrics](/monitoring).
