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

**You'll need:** PostgreSQL 14+, Bun (main backend + firehose), Node.js 18+ (hosting service), and a domain. S3-compatible storage (Cloudflare R2, MinIO, etc.) and Redis are optional but recommended for production.

## Database

```bash
createdb wisp
```

The schema is created automatically on first run.

## Main Backend

```bash
# Required
DATABASE_URL="postgres://user:password@localhost:5432/wisp"
BASE_DOMAIN="wisp.place"
DOMAIN="https://wisp.place"
CLIENT_NAME="Wisp.place"

# Optional
NODE_ENV="production"
PORT="8000"
```

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

```bash
# Required
DATABASE_URL="postgres://user:password@localhost:5432/wisp"

# S3 storage (recommended)
S3_BUCKET="wisp-sites"
S3_REGION="us-east-1"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_FORCE_PATH_STYLE="false"   # set true for MinIO and most non-AWS endpoints
S3_PREFIX="sites/"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."

# Redis (for notifying the hosting service of changes)
REDIS_URL="redis://localhost:6379"

FIREHOSE_SERVICE="wss://bsky.network"
FIREHOSE_MAX_CONCURRENCY=5

HEALTH_PORT=3001

# Fallback disk path if S3 is not configured
CACHE_DIR="./cache/sites"
```

```bash
cd firehose-service
bun install
bun run start
bun run start -- --backfill   # one-time bulk sync of all existing sites
```

## Hosting Service

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
WARM_CACHE_SIZE=10737418240    # 10 GB, disk
WARM_EVICTION_POLICY="lru"    # lru, fifo, or size

# Bootstrap hot tier from warm on startup
BOOTSTRAP_HOT_ON_STARTUP=false
BOOTSTRAP_HOT_LIMIT=100

# S3 cold tier (same bucket as firehose, read-only)
S3_BUCKET="wisp-sites"
S3_REGION="us-east-1"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_FORCE_PATH_STYLE="false"
S3_PREFIX="sites/"
AWS_ACCESS_KEY_ID="..."
AWS_SECRET_ACCESS_KEY="..."

REDIS_URL="redis://localhost:6379"

# Optional
CACHE_ONLY=false               # serve from cache only, no PDS fallback
TRACE_REQUESTS=false
```

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

https:// {
    tls {
        on_demand
    }
    reverse_proxy localhost:3001
}
```

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