# Wisp.place - Codebase Overview

**Project URL**: https://wisp.place

A decentralized static site hosting service built on the AT Protocol (Bluesky). Users can host static websites directly in their AT Protocol accounts, keeping full control and ownership while benefiting from fast CDN distribution.

---

## 🏗️ Architecture Overview

### Multi-Part System
1. **Main Backend** (`/src`) - OAuth, site management, custom domains
2. **Hosting Service** (`/hosting-service`) - Microservice that serves cached sites
3. **CLI Tool** (`/cli`) - Rust CLI for direct site uploads to PDS
4. **Frontend** (`/public`) - React UI for onboarding, editor, admin

### Tech Stack
- **Backend**: Elysia (Bun) + TypeScript + PostgreSQL
- **Frontend**: React 19 + Tailwind CSS 4 + Radix UI
- **CLI**: Rust with Jacquard (AT Protocol library)
- **Database**: PostgreSQL for session/domain/site caching
- **AT Protocol**: OAuth 2.0 + custom lexicons for storage

---

## 📂 Directory Structure

### `/src` - Main Backend Server
**Purpose**: Core server handling OAuth, site management, custom domains, admin features

**Key Routes**:
- `/api/auth/*` - OAuth signin/callback/logout/status
- `/api/domain/*` - Custom domain management (BYOD)
- `/wisp/*` - Site upload and management
- `/api/user/*` - User info and site listing
- `/api/admin/*` - Admin console (logs, metrics, DNS verification)

**Key Files**:
- `index.ts` - Express-like Elysia app setup with middleware (CORS, CSP, security headers)
- `lib/oauth-client.ts` - OAuth client setup with session/state persistence
- `lib/db.ts` - PostgreSQL schema and queries for all tables
- `lib/wisp-auth.ts` - Cookie-based authentication middleware
- `lib/wisp-utils.ts` - File compression (gzip), manifest creation, blob handling
- `lib/sync-sites.ts` - Syncs user's place.wisp.fs records from PDS to database cache
- `lib/dns-verify.ts` - DNS verification for custom domains (TXT + CNAME)
- `lib/dns-verification-worker.ts` - Background worker that checks domain verification every 10 minutes
- `lib/admin-auth.ts` - Simple username/password admin authentication
- `lib/observability.ts` - Logging, error tracking, metrics collection
- `routes/auth.ts` - OAuth flow handlers
- `routes/wisp.ts` - File upload and site creation (/wisp/upload-files)
- `routes/domain.ts` - Domain claiming/verification API
- `routes/user.ts` - User status/info/sites listing
- `routes/site.ts` - Site metadata and file retrieval
- `routes/admin.ts` - Admin dashboard API (logs, system health, manual DNS trigger)

### `/lexicons` & `src/lexicons/`
**Purpose**: AT Protocol Lexicon definitions for custom data types

**Key File**: `fs.json` - Defines `place.wisp.fs` record format
- **structure**: Virtual filesystem manifest with tree structure
- **site**: string identifier
- **root**: directory object containing entries
- **file**: blob reference + metadata (encoding, mimeType, base64 flag)
- **directory**: array of entries (recursive)
- **entry**: name + node (file or directory)

**Important**: Files are gzip-compressed and base64-encoded before upload to bypass PDS content sniffing

### `/hosting-service`
**Purpose**: Lightweight microservice that serves cached sites from disk

**Architecture**:
- Routes by domain lookup in PostgreSQL
- Caches site content locally on first access or firehose event
- Listens to AT Protocol firehose for new site records
- Automatically downloads and caches files from PDS
- SSRF-protected fetch (timeout, size limits, private IP blocking)

**Routes**:
1. Custom domains (`/*`) → lookup custom_domains table
2. Wisp subdomains (`/*.wisp.place/*`) → lookup domains table
3. DNS hash routing (`/hash.dns.wisp.place/*`) → lookup custom_domains by hash
4. Direct serving (`/s.wisp.place/:identifier/:site/*`) → fetch from PDS if not cached

**HTML Path Rewriting**: Absolute paths in HTML (`/style.css`) automatically rewritten to relative (`/:identifier/:site/style.css`)

### `/cli`
**Purpose**: Rust CLI tool for direct site uploads using app password or OAuth

**Flow**:
1. Authenticate with handle + app password or OAuth
2. Walk directory tree, compress files
3. Upload blobs to PDS via agent
4. Create place.wisp.fs record with manifest
5. Store site in database cache

**Auth Methods**:
- `--password` flag for app password auth
- OAuth loopback server for browser-based auth
- Supports both (password preferred if provided)

---

## 🔐 Key Concepts

### Custom Domains (BYOD - Bring Your Own Domain)
**Process**:
1. User claims custom domain via API
2. System generates hash (SHA256(domain + secret))
3. User adds DNS records:
   - TXT at `_wisp.example.com` = their DID
   - CNAME at `example.com` = `{hash}.dns.wisp.place`
4. Background worker checks verification every 10 minutes
5. Once verified, custom domain routes to their hosted sites

**Tables**: `custom_domains` (id, domain, did, rkey, verified, last_verified_at)

### Wisp Subdomains
**Process**:
1. Handle claimed on first signup (e.g., alice → alice.wisp.place)
2. Stored in `domains` table mapping domain → DID
3. Served by hosting service

### Site Storage
**Locations**:
- **Authoritative**: PDS (AT Protocol repo) as `place.wisp.fs` record
- **Cache**: PostgreSQL `sites` table (rkey, did, site_name, created_at)
- **File Cache**: Hosting service caches downloaded files on disk

**Limits**:
- MAX_SITE_SIZE: 300MB total
- MAX_FILE_SIZE: 100MB per file
- MAX_FILE_COUNT: 2000 files

### File Compression Strategy
**Why**: Bypass PDS content sniffing issues (was treating HTML as images)

**Process**:
1. All files gzip-compressed (level 9)
2. Compressed content base64-encoded
3. Uploaded as `application/octet-stream` MIME type
4. Blob metadata stores original MIME type + encoding flag
5. Hosting service decompresses on serve

---

## 🔄 Data Flow

### User Registration → Site Upload
```
1. OAuth signin → state/session stored in DB
2. Cookie set with DID
3. Sync sites from PDS to cache DB
4. If no sites/domain → redirect to onboarding
5. User creates site → POST /wisp/upload-files
6. Files compressed, uploaded as blobs
7. place.wisp.fs record created
8. Site cached in DB
9. Hosting service notified via firehose
```

### Custom Domain Setup
```
1. User claims domain (DB check + allocation)
2. System generates hash
3. User adds DNS records (_wisp.domain TXT + CNAME)
4. Background worker verifies every 10 min
5. Hosting service routes based on verification status
```

### Site Access
```
Hosting Service:
1. Request arrives at custom domain or *.wisp.place
2. Domain lookup in PostgreSQL
3. Check cache for site files
4. If not cached:
   - Fetch from PDS using DID + rkey
   - Decompress files
   - Save to disk cache
5. Serve files (with HTML path rewriting)
```

---

## 🛠️ Important Implementation Details

### OAuth Implementation
- **State & Session Storage**: PostgreSQL (with expiration)
- **Key Rotation**: Periodic rotation + expiration cleanup (hourly)
- **OAuth Flow**: Redirects to PDS, returns to /api/auth/callback
- **Session Timeout**: 30 days
- **State Timeout**: 1 hour

### Security Headers
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Strict-Transport-Security: max-age=31536000
- Content-Security-Policy (configured for Elysia + React)
- X-XSS-Protection: 1; mode=block
- Referrer-Policy: strict-origin-when-cross-origin

### Admin Authentication
- Simple username/password (hashed with bcrypt)
- Session-based cookie auth (24hr expiration)
- Separate `admin_session` cookie
- Initial setup prompted on startup

### Observability
- **Logging**: Structured logging with service tags + event types
- **Error Tracking**: Captures error context (message, stack, etc.)
- **Metrics**: Request counts, latencies, error rates
- **Log Levels**: debug, info, warn, error
- **Collection**: Centralized log collector with in-memory buffer

---

## 📝 Database Schema

### oauth_states
- key (primary key)
- data (JSON)
- created_at, expires_at (timestamps)

### oauth_sessions
- sub (primary key - subject/DID)
- data (JSON with OAuth session)
- updated_at, expires_at

### oauth_keys
- kid (primary key - key ID)
- jwk (JSON Web Key)
- created_at

### domains
- domain (primary key - e.g., alice.wisp.place)
- did (unique - user's DID)
- rkey (optional - record key)
- created_at

### custom_domains
- id (primary key - UUID)
- domain (unique - e.g., example.com)
- did (user's DID)
- rkey (optional)
- verified (boolean)
- last_verified_at (timestamp)
- created_at

### sites
- id, did, rkey, site_name
- created_at, updated_at
- Indexes on (did), (did, rkey), (rkey)

### admin_users
- username (primary key)
- password_hash (bcrypt)
- created_at

---

## 🚀 Key Workflows

### Sign In Flow
1. POST /api/auth/signin with handle
2. System generates state token
3. Redirects to PDS OAuth endpoint
4. PDS redirects back to /api/auth/callback?code=X&state=Y
5. Validate state (CSRF protection)
6. Exchange code for session
7. Store session in DB, set DID cookie
8. Sync sites from PDS
9. Redirect to /editor or /onboarding

### File Upload Flow
1. POST /wisp/upload-files with siteName + files
2. Validate site name (rkey format rules)
3. For each file:
   - Check size limits
   - Read as ArrayBuffer
   - Gzip compress
   - Base64 encode
4. Upload all blobs in parallel via agent.com.atproto.repo.uploadBlob()
5. Create manifest with all blob refs
6. putRecord() for place.wisp.fs with manifest
7. Upsert to sites table
8. Return URI + CID

### Domain Verification Flow
1. POST /api/custom-domains/claim
2. Generate hash = SHA256(domain + secret)
3. Store in custom_domains with verified=false
4. Return hash for user to configure DNS
5. Background worker periodically:
   - Query custom_domains where verified=false
   - Verify TXT record at _wisp.domain
   - Verify CNAME points to hash.dns.wisp.place
   - Update verified flag + last_verified_at
6. Hosting service routes when verified=true

---

## 🎨 Frontend Structure

### `/public`
- **index.tsx** - Landing page with sign-in form
- **editor/editor.tsx** - Site editor/management UI
- **admin/admin.tsx** - Admin dashboard
- **components/ui/** - Reusable components (Button, Card, Dialog, etc.)
- **styles/global.css** - Tailwind + custom styles

### Page Flow
1. `/` - Landing page (sign in / get started)
2. `/editor` - Main app (requires auth)
3. `/admin` - Admin console (requires admin auth)
4. `/onboarding` - First-time user setup

---

## 🔍 Notable Implementation Patterns

### File Handling
- Files stored as base64-encoded gzip in PDS blobs
- Metadata preserves original MIME type
- Hosting service decompresses on serve
- Workaround for PDS image pipeline issues with HTML

### Error Handling
- Comprehensive logging with context
- Graceful degradation (e.g., site sync failure doesn't break auth)
- Structured error responses with details

### Performance
- Site sync: Batch fetch up to 100 records per request
- Blob upload: Parallel promises for all files
- DNS verification: Batched background worker (10 min intervals)
- Caching: Two-tier (DB + disk in hosting service)

### Validation
- Lexicon validation on manifest creation
- Record type checking
- Domain format validation
- Site name format validation (AT Protocol rkey rules)
- File size limits enforced before upload

---

## 🐛 Known Quirks & Workarounds

1. **PDS Content Sniffing**: Files must be uploaded as `application/octet-stream` (even HTML) and base64-encoded to prevent PDS from misinterpreting content

2. **Max URL Query Size**: DNS verification worker queries in batch; may need pagination for users with many custom domains

3. **File Count Limits**: Max 500 entries per directory (Lexicon constraint); large sites split across multiple directories

4. **Blob Size Limits**: Individual blobs limited to 100MB by Lexicon; large files handled differently if needed

5. **HTML Path Rewriting**: Only in hosting service for `/s.wisp.place/:identifier/:site/*` routes; custom domains handled differently

---

## 📋 Environment Variables

- `DOMAIN` - Base domain with protocol (default: `https://wisp.place`)
- `CLIENT_NAME` - OAuth client name (default: `PDS-View`)
- `DATABASE_URL` - PostgreSQL connection (default: `postgres://postgres:postgres@localhost:5432/wisp`)
- `NODE_ENV` - production/development
- `HOSTING_PORT` - Hosting service port (default: 3001)
- `BASE_DOMAIN` - Domain for URLs (default: wisp.place)

---

## 🧑‍💻 Development Notes

### Adding New Features
1. **New routes**: Add to `/src/routes/*.ts`, import in index.ts
2. **DB changes**: Add migration in db.ts
3. **New lexicons**: Update `/lexicons/*.json`, regenerate types
4. **Admin features**: Add to /api/admin endpoints

### Testing
- Run with `bun test`
- CSRF tests in lib/csrf.test.ts
- Utility tests in lib/wisp-utils.test.ts

### Debugging
- Check logs via `/api/admin/logs` (requires admin auth)
- DNS verification manual trigger: POST /api/admin/verify-dns
- Health check: GET /api/health (includes DNS verifier status)

---

## 🚀 Deployment Considerations

1. **Secrets**: Admin password, OAuth keys, database credentials
2. **HTTPS**: Required (HSTS header enforces it)
3. **CDN**: Custom domains require DNS configuration
4. **Scaling**: 
   - Main server: Horizontal scaling with session DB
   - Hosting service: Independent scaling, disk cache per instance
5. **Backups**: PostgreSQL database critical; firehose provides recovery

---

## 📚 Related Technologies

- **AT Protocol**: Decentralized identity, OAuth 2.0
- **Jacquard**: Rust library for AT Protocol interactions
- **Elysia**: Bun web framework (similar to Express/Hono)
- **Lexicon**: AT Protocol's schema definition language
- **Firehose**: Real-time event stream of repo changes
- **PDS**: Personal Data Server (where users' data stored)

---

## 🎯 Project Goals

✅ Decentralized site hosting (data owned by users)
✅ Custom domain support with DNS verification
✅ Fast CDN distribution via hosting service
✅ Developer tools (CLI + API)
✅ Admin dashboard for monitoring
✅ Zero user data retention (sites in PDS, sessions in DB only)

---

**Last Updated**: November 2025
**Status**: Active development
