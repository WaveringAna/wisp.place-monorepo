---
title: Self-Hosting
description: Deploy your own Wisp.place instance
---

Wisp.place consists of three services: the **main backend** handles OAuth, uploads, and domain management; the **firehose service** watches the AT Protocol firehose and populates the cache; the **hosting service** serves cached sites. See [Architecture](/architecture) for how they fit together.

```
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│  Main Backend (:8000)    │  │ Firehose Service         │  │ Hosting Service (:3001)  │
│  - OAuth authentication  │  │ - Watches AT firehose    │  │ - Tiered cache (mem/     │
│  - Site upload/manage    │  │ - Downloads blobs        │  │   disk/S3)               │
│  - Domain registration   │  │ - Writes to S3/disk      │  │ - Content serving        │
│  - Admin panel           │  │ - Publishes invalidation │  │ - Redirect handling      │
└──────────────────────────┘  └──────────────────────────┘  └──────────────────────────┘
         │                        │               │                     │
         │                        │  S3/Disk      │ Redis pub/sub       │
         └────────┬───────────────┘               └─────────────────────┘
                  ▼
┌─────────────────────────────────────────┐
│  PostgreSQL                             │
│  - OAuth sessions + keys                │
│  - Domain mappings                      │
│  - Site metadata                        │
└─────────────────────────────────────────┘
```

**You'll need:** PostgreSQL 14+, Bun (main backend + firehose), Node.js 18+ (hosting service), and a domain. Production firehose deployments require shared S3-compatible storage (Cloudflare R2, MinIO, etc.) and Redis; local disk storage is only an explicit development/test mode.

## Database

```bash
createdb wisp
```

The schema is created automatically on first run. Main-app schema bootstrap and migrations use a database-wide advisory lock, so all main-app instances must connect to the same primary database with a role that can run DDL. The durable `schema_migrations` ledger records each completed immutable step; do not truncate or edit it independently of the schema. An interrupted step rolls back and retries at the next startup. Only an explicit `NODE_ENV=development` or `NODE_ENV=test` can use the local default database URL. Missing, staging, or unknown environments must set `DATABASE_URL` and pass the production-safe transport checks.

### Optional regional presentation-read endpoint

`DATABASE_READ_URL` is only for explicitly eventual presentation queries. Authentication, authorization, writes, ownership checks, private-site state, secrets, tokens, and cache-projection waits always use `DATABASE_URL`.

Create a separate login role for the read URL. Run this as the database/schema owner and choose a managed password outside this document. Grant only the presentation tables; never grant this role access to OAuth, identity, webhook, or private-site tables.

```sql
CREATE ROLE wisp_read LOGIN PASSWORD '<managed-password>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE wisp TO wisp_read;
GRANT USAGE ON SCHEMA public TO wisp_read;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM wisp_read;
GRANT SELECT ON TABLE public.domains, public.custom_domains, public.site_cache,
    public.supporter TO wisp_read;
ALTER ROLE wisp_read SET default_transaction_read_only = on;
```

After the first main-app startup creates `public.wisp_replica_receiver_status()`, run this as the cluster administrator. Grant stats visibility to the trusted role used by `DATABASE_URL` that owns the migration-created function (replace `wisp_main_migrator` below). This lets the probe read only a streaming boolean and last-receipt timestamp, without giving `wisp_read` broad `pg_read_all_stats` access to server activity.

```sql
GRANT pg_read_all_stats TO wisp_main_migrator;
GRANT EXECUTE ON FUNCTION public.wisp_replica_receiver_status() TO wisp_read;
```

The migration role must inherit that membership (the PostgreSQL default). Do not grant `pg_read_all_stats` to `wisp_read`; if receiver visibility is not configured yet, the app safely uses primary reads instead.

Do **not** use a blanket `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES` for this role: new tables can contain secrets or private state. When a new intentionally public presentation table is added, grant `SELECT` for that exact table in the same deployment review.

Use this role in `DATABASE_READ_URL`, including when the endpoint is a local primary. On startup the app performs a bounded probe of `transaction_read_only`, all non-allowlisted public-table `SELECT` grants (including column grants), write grants, `pg_is_in_recovery()`, and replay lag. For a standby, it treats equal receive/replay WAL positions as zero lag, but also requires a fresh `pg_stat_wal_receiver` `streaming` heartbeat; an idle caught-up replica is healthy, while a disconnected caught-up replica is not. Outside explicit development/test, a writable or over-privileged read session aborts startup. An unavailable, stale, or lagging replica opens a circuit and presentation reads fall back to primary; `/api/health` reports the sanitized state and never a connection URL.

The default maximum replay lag is 2 seconds and receiver heartbeat freshness is 30 seconds. Operators can tune the bounded values below when needed:

```env
DATABASE_POOL_MAX=10
DATABASE_READ_POOL_MAX=4
DATABASE_CONNECTION_TIMEOUT_SECONDS=5
DATABASE_IDLE_TIMEOUT_SECONDS=30
DATABASE_READ_PROBE_TIMEOUT_MS=1500
DATABASE_READ_QUERY_TIMEOUT_MS=3000
DATABASE_READ_MAX_REPLAY_LAG_MS=2000
DATABASE_READ_RECEIVER_FRESHNESS_MS=30000
DATABASE_READ_PROBE_INTERVAL_MS=5000
DATABASE_READ_CIRCUIT_COOLDOWN_MS=5000
```

Production-safe non-loopback PostgreSQL URLs (every environment except explicit development/test) must set `sslmode=require`, `sslmode=verify-ca`, or preferably `sslmode=verify-full`. For a private HAProxy or Tailscale-only path with equivalent transport protection, set `DATABASE_ALLOW_INSECURE_PRIVATE_NETWORK=true` deliberately and keep the endpoint unreachable from public networks. Do not use that exception for an Internet-reachable database.

#### HAProxy Redis connections

Redis pub/sub and lazy command clients can be idle for longer than a normal HTTP-style TCP timeout. If Redis is behind HAProxy, do not let a short global `timeout client` or `timeout server` close those healthy sessions every minute. Scope a tunnel timeout to the Redis backend instead of changing the global defaults:

```haproxy
backend redis_primary
    timeout tunnel 1h
    # server entries and health checks...
```

Keep Redis TCP keepalive enabled for dead-peer detection. If hourly reconnects are also undesirable, use a longer bounded tunnel timeout such as `24h`, or send a Redis `PING` more frequently than the timeout. Durable stream replay repairs pub/sub gaps, but it is a recovery path rather than a substitute for stable connections. Validate the complete configuration with `haproxy -c` before any reload.

#### HAProxy / Patroni replica checks

If `DATABASE_READ_URL` points at an HAProxy replica pool, do **not** use Patroni's generic `/health` endpoint for its backend check: it can report a running primary or a stale process as healthy. Check Patroni's replica endpoint with a byte-lag bound instead, for example:

```haproxy
backend wisp_presentation_replicas
    option httpchk GET /replica?lag=1048576
    http-check expect status 200
    server replica-a 10.0.0.11:5432 check port 8008
    server replica-b 10.0.0.12:5432 check port 8008
```

Patroni `/replica?lag=...` keeps primary nodes out of the replica pool and enforces its lag threshold. The app still verifies a recent PostgreSQL WAL-receiver streaming heartbeat before it issues eventual reads, so keep both checks enabled.

## Main Backend

```bash
# Required
DATABASE_URL="postgres://user:password@localhost:5432/wisp"
BASE_DOMAIN="wisp.place"
DOMAIN="https://wisp.place"
CLIENT_NAME="Wisp.place"

# Optional
# Presentation-only reads use this local/replica endpoint when it differs from
# DATABASE_URL. Authentication, writes, ownership checks, secrets, and cache
# projection waits always stay on DATABASE_URL.
DATABASE_READ_URL="postgres://wisp_read:password@replica.example:5432/wisp?sslmode=verify-full"
# Private sites use <site-id>.priv.wisp.place. Set a host[:port] for local development.
PRIVATE_HOST="priv.wisp.place"
NODE_ENV="production"
PORT="8000"

# Retained multipart bodies are denied above this strict byte budget before
# Elysia parses them. The default is 32 MiB for low-memory edge nodes. Route
# all buffered multipart endpoints to high-memory nodes and set 768 MiB there.
PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES="805306368"

# Required before creating or rotating server-managed webhook signing secrets.
# Use exactly 32 random bytes encoded as canonical base64 (shown), base64url
# without padding, or 64 hexadecimal characters. Keep this value in a secret manager.
WEBHOOK_SECRET_ENCRYPTION_KEY="$(openssl rand -base64 32)"
# Optional decrypt-only comma-separated old keys during a key rotation.
WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS=""
```

### Server-managed webhook secret encryption

`place.wisp.v2.secret.*` tokens are stored as AES-256-GCM encrypted envelopes in
`webhook_secrets.token`. The key ID in an envelope is a non-secret fingerprint; the
key itself must never be put in source control, logs, or a database backup.

Set the same active key and previous-key ring on **both the main backend and webhook
delivery service** before enabling or rotating server-managed signing secrets. If the
active key is absent or malformed, creation and rotation fail closed. Existing legacy
plaintext rows are not served; startup reports degraded health until a valid key lets
the idempotent batched migration encrypt them.

To rotate a key, deploy a new active key together with the former key in
`WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS` to every service, then restart them. New
and user-rotated secrets use the active key; old envelopes still need their former key
to deliver. Keep prior keys until all affected secrets have been rotated or otherwise
removed. Test restoration using the full active-plus-previous key ring before retiring
any old key.

Encryption at rest does **not** retroactively protect database backups, replicas,
exports, or snapshots that already contain plaintext tokens. Retain and protect those
copies under the incident and backup policy, and take a new encrypted backup after the
migration completes.

```bash
bun install
bun run start       # production
bun run dev         # dev with hot reload
bun run build       # compile to a binary
```

On first run you'll be prompted to create an admin account. You can also run it manually:

```bash
bun run scripts/create-admin.ts
```

Admin panel is at `https://yourdomain.com/admin`.

## Firehose Service

The firehose service watches the AT Protocol Jetstream for site changes. When a record is created or updated, it downloads blobs from the PDS, processes them, writes to shared S3 storage, and publishes a cache invalidation event so the hosting service picks up the changes.

```bash
# Required
DATABASE_URL="postgres://user:password@localhost:5432/wisp"

# Required shared S3 storage. Use HTTPS for non-local endpoints.
S3_BUCKET="wisp-sites"
S3_REGION="us-east-1"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_FORCE_PATH_STYLE="false"   # set true for MinIO and most non-AWS endpoints
S3_PREFIX="sites/"
# Omit both when an IAM workload role or another AWS default credential provider is used.
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."

# Required for leader election, durable revalidation, and cache invalidation.
REDIS_URL="rediss://redis.example:6379"

FIREHOSE_SERVICE="wss://bsky.network"
FIREHOSE_MAX_CONCURRENCY=5
# Defaults to true in production; every replica must use leader election.
LEADER_ELECTION=true
# Keep the authority supervisor enabled in every production replica. The
# firehose image contains this compiled child executable.
LEADERSHIP_SUPERVISOR_ENABLED=true
FIREHOSE_SUPERVISOR_PATH="/usr/local/bin/firehose-supervisor"
FIREHOSE_WATCHDOG_PATH="/usr/local/bin/firehose-watchdog"
SUPERVISOR_COMMAND_TIMEOUT_MS=2000

HEALTH_PORT=3002

# Local disk fallback is development/test only. It is rejected in production.
# NODE_ENV=development
# FIREHOSE_ALLOW_DISK_STORAGE=true
# CACHE_DIR="./cache/sites"
```

When Docker launches the firehose service, enable its built-in init process with
`docker run --init` or Compose `init: true`. The leadership watchdog must be able
to terminate the worker, and Linux does not allow an in-container process to
`SIGKILL` namespace PID 1. Production startup refuses that unsafe layout.

```bash
cd firehose-service
bun install
bun run start
bun run start -- --backfill   # one-time bulk sync of all existing sites
```

## Hosting Service

The hosting service is a read-only CDN built with Hono. It resolves sites from the request hostname and serves files from tiered storage. A missing manifest or file returns a bounded 503 while durable firehose revalidation repairs storage; the request path never fetches from the user's PDS.

```bash
# Required
DATABASE_URL="postgres://user:password@localhost:5432/wisp"
BASE_HOST="wisp.place"
PORT=3001

# Tiered storage
CACHE_DIR="./cache/sites"
HOT_CACHE_SIZE=104857600       # 100 MB, in-memory LRU
HOT_CACHE_COUNT=500
HOT_CACHE_TTL=60               # seconds
WARM_CACHE_SIZE=10737418240    # 10 GB, disk; this is not a RAM allowance
WARM_EVICTION_POLICY="lru"    # lru, fifo, or size

# Bootstrap hot tier from warm on startup
BOOTSTRAP_HOT_ON_STARTUP=false
BOOTSTRAP_HOT_LIMIT=100

# Required in every production-like or multi-node deployment: S3 is the
# shared source of truth and Redis carries invalidations/revalidation. Endpoints
# must use HTTPS outside explicit development/test mode.
S3_BUCKET="wisp-sites"
S3_REGION="us-east-1"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_FORCE_PATH_STYLE="false"
S3_PREFIX="sites/"              # canonical namespace; one trailing slash is normalized
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."
REDIS_URL="rediss://redis.example:6379"

# Single-node disk source only. Do not combine with S3_BUCKET (or PRIVATE_S3_BUCKET).
# Disk source is implicit only when NODE_ENV is exactly development or test; this
# opt-in is required for every other environment.
# HOSTING_ALLOW_DISK_SOURCE=true

# Optional
# Disable hosting analytics database writes. Site serving is read-only either way.
CACHE_ONLY=true
# Missing manifests/files enqueue firehose revalidation; they never trigger PDS reads here.
TRACE_REQUESTS=false
```

Keep `HOT_CACHE_SIZE` consistent across regions. It is the byte cap for resident file data; `WARM_CACHE_SIZE` only caps the disk tier. The process also needs memory for Bun/Node, metadata, request buffers, and shared caches, so the container RSS can exceed `HOT_CACHE_SIZE`. After measuring a fixed-image canary under representative traffic, configure a container memory limit above the observed peak plus operating headroom. Do not run production hosting containers without a memory limit indefinitely.

```bash
cd hosting-service
npm install
npm run start
```

## Reverse Proxy

Caddy is the recommended reverse proxy — it handles TLS and on-demand certificates for custom domains automatically.

```
{
    on_demand_tls {
        ask http://localhost:8000/api/domain/registered
    }
}

*.dns.wisp.place *.wisp.place {
    reverse_proxy localhost:3001
}

wisp.place {
    reverse_proxy localhost:8000
}

# This also serves <site-id>.priv.wisp.place. Their certificates are issued
# on demand only after the ask endpoint confirms a live private site.
https:// {
    tls {
        on_demand
    }
    reverse_proxy localhost:3001
}
```

`*.wisp.place` only matches one label. Private sites have an extra label, so point both
`priv.wisp.place` and `*.priv.wisp.place` at Caddy. Do not add a static wildcard TLS site
for `*.priv.wisp.place` unless you have configured DNS-01 wildcard certificates; the generic
on-demand HTTPS block above obtains a certificate for an individual live private-site hostname
only after its ask check succeeds.

Nginx works too, but custom domain TLS requires dynamic certificate provisioning that you'll need to manage separately.

```nginx
server {
    listen 443 ssl http2;
    server_name wisp.place;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    location / {
        proxy_pass http://localhost:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}

server {
    listen 443 ssl http2;
    server_name *.wisp.place sites.wisp.place;
    ssl_certificate /path/to/wildcard-cert.pem;
    ssl_certificate_key /path/to/wildcard-key.pem;
    location / {
        proxy_pass http://localhost:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## DNS

```
wisp.place          A      YOUR_SERVER_IP
*.wisp.place        A      YOUR_SERVER_IP
*.dns.wisp.place    A      YOUR_SERVER_IP
sites.wisp.place    A      YOUR_SERVER_IP
priv.wisp.place     A      YOUR_SERVER_IP
*.priv.wisp.place   A      YOUR_SERVER_IP
```

## OAuth

Your instance needs to be publicly accessible for OAuth callbacks. The backend automatically serves `/.well-known/atproto-did`, `/oauth-client-metadata.json`, and `/jwks.json`.

## Custom Domain Verification

Users add custom domains by creating a DNS TXT record:

```
_wisp.example.com   TXT    did:plc:abc123xyz...
```

The verification worker checks every 10 minutes. Trigger it manually:

```bash
curl -X POST https://yourdomain.com/api/admin/verify-dns
```

## Reverse-proxy request limits

Keep request-body and rate limits at Caddy (or the proxy in front of the main app). The app rejects declared oversized bodies before Elysia parses them, but Bun is the final in-process limit for chunked requests.

- Allow multipart bodies only for `POST /wisp/upload-files` (supporter transport cap: 716 MiB) and private-site creation (101 MiB including multipart overhead).
- Limit `/api/webhook` mutation JSON to 64 KiB and other normal JSON mutation requests to 1 MiB.
- Preserve and sanitize the real client IP header at the trusted proxy. Do not pass a client-supplied `X-Forwarded-For` through unchanged. The app global weighted retained-body cap is authoritative; per-source admission is only an extra trusted-proxy fairness control.
- Apply per-IP request-rate and concurrent-upload limits at the proxy as an outer defense. Route every buffered multipart endpoint only to high-memory upload nodes with an explicit `PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES`: `POST /wisp/upload-files`, `POST /api/user/private-sites`, `POST /api/user/private-sites/`, and `POST /xrpc/place.wisp.v2.privateSite.create`. Low-memory edge nodes intentionally keep the safe 32 MiB default. Do not apply the upload multipart policy to OAuth callbacks; keep their normal small proxy limits.
