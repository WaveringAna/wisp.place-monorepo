# Wisp.place

Decentralized static site hosting on the AT Protocol. [https://wisp.place](https://wisp.place)

## What is this?

Host static sites in your AT Protocol repo, served with CDN distribution. Your PDS holds the cryptographically signed manifest and files - the source of truth. Hosting services index and serve them fast.

## Quick Start

```bash
# Using the web interface
Visit https://wisp.place and sign in

# Or use the CLI
cd cli
cargo build --release
./target/release/wisp-cli your-handle.bsky.social --path ./my-site --site my-site
```

Your site appears at `https://sites.wisp.place/{your-did}/{site-name}` or your custom domain.

## Architecture

- **`/src`** - Main backend (OAuth, site management, custom domains)
- **`/hosting-service`** - Microservice that serves cached sites from disk
- **`/cli`** - Rust CLI for direct PDS uploads
- **`/public`** - React frontend

### How it works

1. Sites stored as `place.wisp.fs` records in your AT Protocol repo
2. Files compressed (gzip) and base64-encoded as blobs
3. Hosting service watches firehose, caches sites locally
4. Sites served via custom domains or `*.wisp.place` subdomains

## Development

```bash
# Backend
bun install
bun run src/index.ts

# Hosting service
cd hosting-service
npm run start

# CLI
cd cli
cargo build
```

## Features

### URL Redirects and Rewrites

The hosting service supports Netlify-style `_redirects` files for managing URLs. Place a `_redirects` file in your site root to enable:

- **301/302 Redirects**: Permanent and temporary URL redirects
- **200 Rewrites**: Serve different content without changing the URL
- **404 Custom Pages**: Custom error pages for specific paths
- **Splats & Placeholders**: Dynamic path matching (`/blog/:year/:month/:day`, `/news/*`)
- **Query Parameter Matching**: Redirect based on URL parameters
- **Conditional Redirects**: Route by country, language, or cookie presence
- **Force Redirects**: Override existing files with redirects

Example `_redirects`:
```
# Single-page app routing (React, Vue, etc.)
/*                 /index.html           200

# Simple redirects
/home              /
/old-blog/*        /blog/:splat

# API proxy
/api/*             https://api.example.com/:splat     200

# Country-based routing
/                  /us/                  302  Country=us
/                  /uk/                  302  Country=gb
```

## Limits

- Max file size: 100MB (PDS limit)
- Max files: 2000

## Tech Stack

- Backend: Bun + Elysia + PostgreSQL
- Frontend: React 19 + Tailwind 4 + Radix UI
- Hosting: Node microservice using Hono
- CLI: Rust + Jacquard (AT Protocol library)
- Protocol: AT Protocol OAuth + custom lexicons

## License

MIT

## Links

- [AT Protocol](https://atproto.com)
- [Jacquard Library](https://tangled.org/@nonbinary.computer/jacquard)
