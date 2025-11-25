---
title: Self-Hosting Guide
description: Deploy your own Wisp.place instance
---

This guide covers deploying your own Wisp.place instance. Wisp.place consists of two services: the main backend (handles OAuth, uploads, domains) and the hosting service (serves cached sites).

## Prerequisites

- **PostgreSQL** database (14 or newer)
- **Bun** runtime for the main backend
- **Node.js** (18+) for the hosting service
- **Caddy** (optional, for custom domain TLS)
- **Domain name** for your instance

## Architecture Overview

```
┌─────────────────────────────────────────┐     ┌─────────────────────────────────────────┐
│  Main Backend (port 8000)               │     │  Hosting Service (port 3001)            │
│  - OAuth authentication                 │     │  - Firehose listener                    │
│  - Site upload/management               │     │  - Site caching                         │
│  - Domain registration                  │     │  - Content serving                      │
│  - Admin panel                          │     │  - Redirect handling                    │
└─────────────────────────────────────────┘     └─────────────────────────────────────────┘
                  │                                             │
                  └─────────────────┬───────────────────────────┘
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

## Hosting Service Setup

The hosting service is a separate microservice that serves cached sites.

### Environment Variables

```bash
# Required
DATABASE_URL="postgres://user:password@localhost:5432/wisp"
BASE_HOST="wisp.place"                # Same as main backend

# Optional
PORT="3001"                           # Default: 3001
CACHE_DIR="./cache/sites"             # Site cache directory
CACHE_ONLY_MODE="false"               # Set true to disable DB writes
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

# With backfill (downloads all sites from DB on startup)
npm run start -- --backfill
```

The hosting service will:
1. Connect to PostgreSQL
2. Start firehose listener (watches for new sites)
3. Create cache directory
4. Serve sites on port 3001

### Cache Management

Sites are cached to disk at `./cache/sites/{did}/{sitename}/`. The cache is automatically populated:
- **On first request**: Downloads from PDS and caches
- **Via firehose**: Updates when sites are deployed
- **Backfill mode**: Downloads all sites from database on startup

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
- `/client-metadata.json` - OAuth client metadata
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

- **Multiple hosting instances**: Run multiple hosting services behind a load balancer
- **Separate databases**: Split read/write with replicas
- **CDN**: Put Cloudflare or Bunny in front for global caching
- **Cache storage**: Use NFS/S3 for shared cache across instances
- **Redis**: Add Redis for session storage at scale

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
