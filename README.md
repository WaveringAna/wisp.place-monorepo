# Wisp.place

Decentralized static site hosting on the AT Protocol. [https://wisp.place](https://wisp.place)

## What is this?

Host static sites in your AT Protocol repo, served with CDN distribution. Your PDS holds the cryptographically signed manifest and files - the source of truth. Hosting services index and serve them fast.

## Quick Start

```bash
# Using the web interface
Visit https://wisp.place and sign in

# Or use the CLI
npm install -g wispctl
# or
npm create wisp
```

Your site appears at `https://sites.wisp.place/{your-did}/{site-name}` or your custom domain.

## Architecture

- **`/apps/main-app`** - Main backend (OAuth, site management, custom domains)
- **`/apps/hosting-service`** - Microservice that serves cached sites from disk
- **`/cli`** - CLI for direct PDS uploads as well as serving with firehose updates
- **`/apps/main-app/public`** - React frontend
- **`/packages`** - Shared packages

### How it works

1. Sites stored as `place.wisp.fs` records in your AT Protocol repo
2. Files compressed (gzip) and base64-encoded as blobs
3. Hosting service watches firehose, caches sites locally
4. Sites served via custom domains or `*.wisp.place` subdomains

## Development

```bash
# Backend
# bun install will install packages across the monorepo
bun install
bun run dev
```
.env file for local dev

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/wisp

NODE_ENV=development
DOMAIN=https://wisp.place
CLIENT_NAME=Wisp.Place
LOCAL_DEV=true
```

### Local Domain XRPC (ServiceAuth via PDS Proxy)

`apps/main-app` exposes domain claim/status XRPC endpoints:

- `place.wisp.v2.domain.claimSubdomain` (procedure / POST, wisp handles)
- `place.wisp.v2.domain.claim` (procedure / POST)
- `place.wisp.v2.domain.delete` (procedure / POST)
- `place.wisp.v2.domain.getList` (query / GET)
- `place.wisp.v2.domain.getStatus` (query / GET)

The server validates **serviceAuth JWTs** on `/xrpc/*`.

Set these env vars in your active `.env`:

```env
SERVICE_DID=did:web:domain
SERVICE_IDS="#wisp_xrpc"
SERVICE_ENDPOINT=https://domain
```

Notes:

- `/.well-known/atproto-did` returns `SERVICE_DID`.
- `/.well-known/did.json` publishes the DID doc, including `service` entries from `SERVICE_IDS`.
- `SERVICE_IDS` must be quoted when it starts with `#` (otherwise dotenv treats it as a comment).
- Service identity keys are stored in `service_identity_keys` in Postgres.  
  If `SERVICE_PUBLIC_KEY_MULTIBASE` and `SERVICE_PRIVATE_KEY_MULTIBASE` are not set, a keypair is generated once and persisted.

```bash
# Hosting service
bun run hosting:dev

# CLI
cd cli
bun install
bun run index.ts
bun build
node dist/index.js
```

## Features

### File Filtering and `.wispignore`

Wisp automatically excludes common files that shouldn't be uploaded to your site (like `.git`, `node_modules`, `.env` files, etc.). You can customize this behavior by creating a `.wispignore` file in your site root.

The `.wispignore` file uses the same syntax as `.gitignore`:
```
# Custom ignore patterns
*.log
temp/
build/
.secret
```

Default patterns include: `.git`, `.github`, `.gitlab`, `.DS_Store`, `node_modules`, `.env`, cache directories, Python virtual environments, editor swap files, `.tangled`, and more.

See [File Filtering Documentation](./docs/src/content/docs/file-filtering.md) for details.

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
