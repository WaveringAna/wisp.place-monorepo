# Wisp Hosting Service

Minimal microservice for hosting static sites from the AT Protocol. Built with Hono and Bun.

## Features

- **Custom Domain Hosting**: Serve verified custom domains
- **Wisp.place Subdomains**: Serve registered `*.wisp.place` subdomains
- **DNS Hash Routing**: Support DNS verification via `hash.dns.wisp.place`
- **Direct File Serving**: Access sites via `sites.wisp.place/:identifier/:site/*` (no DB lookup)
- **Firehose Worker**: Listens to AT Protocol firehose for new `place.wisp.fs` records
- **Automatic Caching**: Downloads and caches sites locally on first access or firehose event
- **SSRF Protection**: Hardened fetch with timeout, size limits, and private IP blocking

## Routes

1. **Custom Domains** (`/*`)
   - Serves verified custom domains (example.com)
   - DB lookup: `custom_domains` table

2. **Wisp Subdomains** (`/*.wisp.place/*`)
   - Serves registered subdomains (alice.wisp.place)
   - DB lookup: `domains` table

3. **DNS Hash Routing** (`/hash.dns.wisp.place/*`)
   - DNS verification routing for custom domains
   - DB lookup: `custom_domains` by hash

4. **Direct Serving** (`/sites.wisp.place/:identifier/:site/*`)
   - Direct access without DB lookup
   - `:identifier` can be DID or handle
   - Fetches from PDS if not cached
   - **Automatic HTML path rewriting**: Absolute paths (`/style.css`) are rewritten to relative paths (`sites.wisp.place/:identifier/:site/style.css`)

## Setup

```bash
# Install dependencies
bun install

# Copy environment file
cp .env.example .env

# Run in development
bun run dev

# Run in production
bun run start
```

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string
- `PORT` - HTTP server port (default: 3001)
- `BASE_HOST` - Base domain (default: wisp.place)

## Architecture

- **Hono**: Minimal web framework
- **Postgres**: Database for domain/site lookups
- **AT Protocol**: Decentralized storage
- **Jetstream**: Firehose consumer for real-time updates
- **Bun**: Runtime and file serving

## Cache Structure

```
cache/sites/
  did:plc:abc123/
    sitename/
      index.html
      style.css
      assets/
        logo.png
```

## Health Check

```bash
curl http://localhost:3001/health
```

Returns firehose connection status and last event time.

## HTML Path Rewriting

When serving sites via the `/s/:identifier/:site/*` route, HTML files are automatically processed to rewrite absolute paths to work correctly in the subdirectory context.

**What gets rewritten:**
- `src` attributes (images, scripts, iframes)
- `href` attributes (links, stylesheets)
- `action` attributes (forms)
- `poster`, `data` attributes (media)
- `srcset` attributes (responsive images)

**What's preserved:**
- External URLs (`https://example.com/style.css`)
- Protocol-relative URLs (`//cdn.example.com/script.js`)
- Data URIs (`data:image/png;base64,...`)
- Anchors (`/#section`)
- Already relative paths (`./style.css`, `../images/logo.png`)

**Example:**
```html
<!-- Original HTML -->
<link rel="stylesheet" href="/style.css">
<img src="/images/logo.png">

<!-- Served at /s/did:plc:abc123/mysite/ becomes -->
<link rel="stylesheet" href="sites.wisp.place/did:plc:abc123/mysite/style.css">
<img src="sites.wisp.place/did:plc:abc123/mysite/images/logo.png">
```

This ensures sites work correctly when served from subdirectories without requiring manual path adjustments.

## Security

### SSRF Protection

All external HTTP requests are protected against Server-Side Request Forgery (SSRF) attacks:

- **5-second timeout** on all requests
- **Size limits**: 1MB for JSON, 10MB default, 100MB for file blobs
- **Blocked private IP ranges**:
  - Loopback (127.0.0.0/8, ::1)
  - Private networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
  - Link-local (169.254.0.0/16, fe80::/10)
  - Cloud metadata endpoints (169.254.169.254)
- **Protocol validation**: Only HTTP/HTTPS allowed
- **Streaming with size enforcement**: Prevents memory exhaustion from large responses
