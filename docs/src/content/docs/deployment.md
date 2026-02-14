---
title: Self-Hosting Guide
description: Deploy your own Wisp.place instance
---

This guide covers deploying your own Wisp.place instance. Wisp.place consists of three services: the main backend (handles OAuth, uploads, domains), the firehose service (watches the AT Protocol firehose and populates the cache), and the hosting service (serves cached sites). See the [Architecture Guide](/architecture) for a detailed breakdown of how these services work together.

## Prerequisites

- **PostgreSQL** database (14 or newer)
- **Bun** runtime for the main backend and firehose service
- **Node.js** (18+) for the hosting service
- **Caddy** (optional, for custom domain TLS)
- **Domain name** for your instance
- **S3-compatible storage** (optional, recommended for production — Cloudflare R2, MinIO, etc.)
- **Redis** (optional, for real-time cache invalidation between services)

## Architecture Overview

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
│  PostgreSQL Database                    │
│  - User sessions                        │
│  - Domain mappings                      │
│  - Site metadata                        │
└─────────────────────────────────────────┘
```

## Database Setup

Create a PostgreSQL database for Wisp.place:

```bash
createdb wisp
```

The schema is automatically created on first run. Tables include:
- `oauth_states`, `oauth_sessions`, `oauth_keys` - OAuth flow
- `domains` - Wisp subdomains (*.yourdomain.com)
- `custom_domains` - User custom domains with DNS verification
- `sites` - Site metadata cache
- `cookie_secrets` - Session signing keys

## Main Backend Setup

### Environment Variables

Create a `.env` file or set these environment variables:

```bash
# Required
DATABASE_URL="postgres://user:password@localhost:5432/wisp"
BASE_DOMAIN="wisp.place"              # Your domain (without protocol)
DOMAIN="https://wisp.place"           # Full domain with protocol
CLIENT_NAME="Wisp.place"              # OAuth client name

# Optional
NODE_ENV="production"                 # production or development
PORT="8000"                           # Default: 8000
```

### Installation

```bash
# Install dependencies
bun install

# Development mode (with hot reload)
bun run dev

# Production mode
bun run start

# Or compile to binary
bun run build
./server
```

The backend will:
1. Initialize the database schema
2. Generate OAuth keys (stored in DB)
3. Start DNS verification worker (checks custom domains every 10 minutes)
4. Listen on port 8000

### First-Time Admin Setup

On first run, you'll be prompted to create an admin account:

```
No admin users found. Create one now? (y/n):
```

Or create manually:

```bash
bun run scripts/create-admin.ts
```

Admin panel is available at `https://yourdomain.com/admin`

## Firehose Service Setup

The firehose service watches the AT Protocol firehose for site changes and pre-populates the cache. It is **write-only** — it never serves requests to users.

### Environment Variables

```bash
# Required
DATABASE_URL="postgres://user:password@localhost:5432/wisp"

# S3 storage (recommended for production)
S3_BUCKET="wisp-sites"
S3_REGION="auto"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."
S3_METADATA_BUCKET="wisp-metadata"     # Optional, recommended

# Redis (for notifying hosting service of changes)
REDIS_URL="redis://localhost:6379"

# Firehose
FIREHOSE_URL="wss://jetstream2.us-east.bsky.network/subscribe"
FIREHOSE_CONCURRENCY=5                 # Max parallel event processing

# Optional
CACHE_DIR="./cache/sites"              # Fallback if S3 not configured
```

### Installation

```bash
cd firehose-service

# Install dependencies
bun install

# Production mode
bun run start

# With backfill (one-time bulk sync of all existing sites)
bun run start -- --backfill
```

The firehose service will:
1. Connect to the AT Protocol firehose (Jetstream)
2. Filter for `place.wisp.fs` and `place.wisp.settings` events
3. Download blobs, decompress, and rewrite HTML paths
4. Write files to S3 (or disk)
5. Publish cache invalidation events to Redis

## Hosting Service Setup

The hosting service is a **read-only** CDN that serves cached sites through a three-tier storage system (memory, disk, S3).

### Environment Variables

```bash
# Required
DATABASE_URL="postgres://user:password@localhost:5432/wisp"
BASE_HOST="wisp.place"                 # Same as main backend

# Tiered storage
HOT_CACHE_SIZE=104857600               # Hot tier: 100 MB (memory, LRU)
HOT_CACHE_COUNT=500                    # Max items in hot tier

WARM_CACHE_SIZE=10737418240            # Warm tier: 10 GB (disk, LRU)
WARM_EVICTION_POLICY="lru"             # lru, fifo, or size
CACHE_DIR="./cache/sites"              # Warm tier directory

# S3 cold tier (same bucket as firehose service, read-only)
S3_BUCKET="wisp-sites"
S3_REGION="auto"
S3_ENDPOINT="https://your-account.r2.cloudflarestorage.com"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."
S3_METADATA_BUCKET="wisp-metadata"

# Redis (receive cache invalidation from firehose service)
REDIS_URL="redis://localhost:6379"

# Optional
PORT="3001"                            # Default: 3001
```

### Installation

```bash
cd hosting-service

# Install dependencies
npm install

# Development mode
npm run dev

# Production mode
npm run start
```

The hosting service will:
1. Initialize tiered storage (hot → warm → cold)
2. Subscribe to Redis for cache invalidation events
3. Serve sites on port 3001

### Cache Behavior

Files are cached across three tiers with automatic promotion:

- **Hot (memory):** Fastest, limited by `HOT_CACHE_SIZE`. Evicted on restart.
- **Warm (disk):** Fast local reads at `CACHE_DIR`. Survives restarts.
- **Cold (S3):** Shared source of truth, populated by firehose service.

On a cache miss at all tiers, the hosting service fetches directly from the user's PDS and promotes the file into the appropriate tiers.

**Without S3:** Disk acts as both warm and cold tier. The hosting service still works — it just relies on on-demand fetching instead of pre-populated S3 cache.

## Reverse Proxy Setup

### Caddy Configuration

Caddy handles TLS, on-demand certificates for custom domains, and routing:

```
{
    on_demand_tls {
        ask http://localhost:8000/api/domain/registered
    }
}

# Wisp subdomains and DNS hash routing
*.dns.wisp.place *.wisp.place {
    reverse_proxy localhost:3001
}

# Main web interface and API
wisp.place {
    reverse_proxy localhost:8000
}

# Custom domains (on-demand TLS)
https:// {
    tls {
        on_demand
    }
    reverse_proxy localhost:3001
}
```

### Nginx Alternative

```nginx
# Main backend
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

# Hosting service
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

**Note:** Custom domain TLS requires dynamic certificate provisioning. Caddy's on-demand TLS is the easiest solution.

## OAuth Configuration

Wisp.place uses AT Protocol OAuth. Your instance needs to be publicly accessible for OAuth callbacks.

Required endpoints:
- `/.well-known/atproto-did` - Returns your DID for lexicon resolution
- `/oauth-client-metadata.json` - OAuth client metadata
- `/jwks.json` - OAuth signing keys

These are automatically served by the backend.

## DNS Configuration

For your main domain:

```
wisp.place          A      YOUR_SERVER_IP
*.wisp.place        A      YOUR_SERVER_IP
*.dns.wisp.place    A      YOUR_SERVER_IP
sites.wisp.place    A      YOUR_SERVER_IP
```

Or use CNAME records if you're behind a CDN:

```
wisp.place          CNAME  your-server.example.com
*.wisp.place        CNAME  your-server.example.com
```

## Custom Domain Verification

Users can add custom domains via DNS TXT records:

```
_wisp.example.com   TXT    did:plc:abc123xyz...
```

The DNS verification worker checks these every 10 minutes. Trigger manually:

```bash
curl -X POST https://yourdomain.com/api/admin/verify-dns
```

## Production Checklist

Before going live:

- [ ] PostgreSQL database configured with backups
- [ ] `DATABASE_URL` set with secure credentials
- [ ] `BASE_DOMAIN` and `DOMAIN` configured correctly
- [ ] Admin account created
- [ ] Reverse proxy (Caddy/Nginx) configured
- [ ] DNS records pointing to your server
- [ ] TLS certificates configured
- [ ] Hosting service cache directory has sufficient space
- [ ] Firewall allows ports 80/443
- [ ] Process manager (systemd, pm2) configured for auto-restart

## Monitoring

### Health Checks

Main backend:
```bash
curl https://yourdomain.com/api/health
```

Hosting service:
```bash
curl http://localhost:3001/health
```

### Logs

The services log to stdout. View with your process manager:

```bash
# systemd
journalctl -u wisp-backend -f
journalctl -u wisp-hosting -f

# pm2
pm2 logs wisp-backend
pm2 logs wisp-hosting
```

### Admin Panel

Access observability metrics at `https://yourdomain.com/admin`:
- Recent logs
- Error tracking
- Performance metrics
- Cache statistics

## Scaling Considerations

- **Multiple hosting instances**: Run multiple hosting services behind a load balancer — each has its own hot/warm tiers but shares the S3 cold tier and Redis invalidation
- **Separate databases**: Split read/write with replicas
- **CDN**: Put Cloudflare or Bunny in front for global caching
- **S3 cold tier**: Shared storage across all hosting instances (Cloudflare R2, MinIO, AWS S3)
- **Redis**: Required for real-time cache invalidation between firehose and hosting services at scale

## Security Notes

- Use strong cookie secrets (auto-generated and stored in DB)
- Keep dependencies updated: `bun update`, `npm update`
- Enable rate limiting in reverse proxy
- Set up fail2ban for brute force protection
- Regular database backups
- Monitor logs for suspicious activity

## Updates

To update your instance:

```bash
# Pull latest code
git pull

# Update dependencies
bun install
cd hosting-service && npm install && cd ..

# Restart services
# (The database schema updates automatically)
```

## Support

For issues and questions:
- Check the [documentation](https://docs.wisp.place)
- Review [Tangled issues](https://tangled.org/nekomimi.pet/wisp.place-monorepo)
- Join the [Bluesky community](https://bsky.app)

## License

Wisp.place is MIT licensed. You're free to host your own instance and modify it as needed.
