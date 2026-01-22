---
title: Main App API
description: Expected responses from the main-app Elysia routes.
---

These endpoints power the main wisp.place backend (Bun + Elysia). Responses below are the shapes returned by the handlers in `apps/main-app/src/routes/*`.

Notes:
- Authenticated routes rely on the signed `did` cookie. If authentication fails, the handler throws and Elysia returns an error response.
- Admin routes rely on the signed `admin_session` cookie. Unauthorized requests return `401 { error: 'Unauthorized' }`.

## Auth (`/api/auth/*`)

### `GET /api/auth/login`
Redirects to the AT Protocol OAuth authorize URL.

- **302** → OAuth URL
- **302** → `/?error=missing_handle` if no handle/PDS provided
- **302** → `/?error=auth_failed` on failure

### `POST /api/auth/signin`
```json
{ "url": "https://..." }
```
On failure:
```json
{ "error": "Authentication failed", "details": "..." }
```

### `GET /api/auth/callback`
Redirects after OAuth completes.

- **302** → `/onboarding` (no sites or domain)
- **302** → `/editor` (existing user)
- **302** → `/?error=auth_failed` on failure

### `POST /api/auth/logout`
```json
{ "success": true }
```
On failure:
```json
{ "error": "Logout failed" }
```

### `GET /api/auth/status`
Authenticated:
```json
{ "authenticated": true, "did": "did:plc:..." }
```
Not authenticated:
```json
{ "authenticated": false }
```

## User (`/api/user/*`)

### `GET /api/user/status`
```json
{
  "did": "did:plc:...",
  "hasSites": true,
  "hasDomain": false,
  "domain": null,
  "sitesCount": 3
}
```

### `GET /api/user/info`
```json
{ "did": "did:plc:...", "handle": "user.bsky.social" }
```

### `GET /api/user/sites`
```json
{ "sites": [/* site rows */] }
```

### `GET /api/user/domains`
```json
{
  "wispDomains": [{ "domain": "name.wisp.place", "rkey": "site-rkey" }],
  "customDomains": [/* custom domain rows */]
}
```

### `POST /api/user/sync`
```json
{ "success": true, "synced": 2, "errors": [] }
```

### `GET /api/user/site/:rkey/domains`
```json
{ "rkey": "site-rkey", "domains": [/* domain rows */] }
```

## Domain (`/api/domain/*`)

### `GET /api/domain/check`
```json
{ "available": true, "domain": "name.wisp.place" }
```
Invalid handle:
```json
{ "available": false, "reason": "invalid" }
```

### `GET /api/domain/registered`
Registered:
```json
{ "registered": true, "type": "wisp", "domain": "name.wisp.place", "did": "did:plc:...", "rkey": "site-rkey" }
```
Custom domain:
```json
{ "registered": true, "type": "custom", "domain": "example.com", "did": "did:plc:...", "rkey": "site-rkey", "verified": true }
```
Unregistered:
```json
{ "registered": false }
```
Missing domain:
```json
{ "error": "Domain parameter required" }
```

### `POST /api/domain/claim`
```json
{ "success": true, "domain": "name.wisp.place" }
```

### `POST /api/domain/update`
```json
{ "success": true, "domain": "name.wisp.place" }
```

### `POST /api/domain/custom/add`
```json
{ "success": true, "id": "abcdef1234567890", "domain": "example.com", "verified": false }
```

### `POST /api/domain/custom/verify`
```json
{ "success": true, "verified": true, "error": null, "found": true }
```

### `DELETE /api/domain/custom/:id`
```json
{ "success": true }
```

### `POST /api/domain/wisp/map-site`
```json
{ "success": true }
```

### `DELETE /api/domain/wisp/:domain`
```json
{ "success": true }
```

### `POST /api/domain/custom/:id/map-site`
```json
{ "success": true }
```

## Site (`/api/site/*`)

### `DELETE /api/site/:rkey`
```json
{ "success": true, "message": "Site deleted successfully" }
```
On failure:
```json
{ "success": false, "error": "..." }
```

### `GET /api/site/:rkey/settings`
Returns the `place.wisp.settings` record when present, otherwise defaults:
```json
{ "indexFiles": ["index.html"], "cleanUrls": false, "directoryListing": false }
```
On failure:
```json
{ "success": false, "error": "..." }
```

### `POST /api/site/:rkey/settings`
```json
{ "success": true, "uri": "at://...", "cid": "bafy..." }
```
On validation failure:
```json
{ "success": false, "error": "Only one of spaMode, directoryListing, or custom404 can be enabled" }
```

## Wisp Uploads (`/wisp/*`)

### `GET /wisp/upload-progress/:jobId`
Server-sent events stream for upload progress.

- **event:** `progress` → `{ status, progress, result, error }`
- **event:** `done` → `result`
- **event:** `error` → `{ error }`

Errors:
```json
{ "error": "Job not found" }
```
```json
{ "error": "Unauthorized" }
```

### `POST /wisp/upload-files`
Empty upload (no files):
```json
{ "success": true, "uri": "at://...", "cid": "bafy...", "fileCount": 0, "siteName": "my-site" }
```
Async upload:
```json
{ "success": true, "jobId": "...", "message": "Upload started. Connect to /wisp/upload-progress/..." }
```

## Admin (`/api/admin/*`)

### `POST /api/admin/login`
```json
{ "success": true }
```
Invalid credentials (401):
```json
{ "error": "Invalid credentials" }
```

### `POST /api/admin/logout`
```json
{ "success": true }
```

### `GET /api/admin/status`
Authenticated:
```json
{ "authenticated": true, "username": "admin" }
```
Not authenticated:
```json
{ "authenticated": false }
```

### `GET /api/admin/logs`
```json
{ "logs": [/* combined logs */] }
```

### `GET /api/admin/errors`
```json
{ "errors": [/* combined errors */] }
```

### `GET /api/admin/metrics`
```json
{ "overall": {}, "mainApp": {}, "hostingService": {}, "timeWindow": 3600000 }
```

### `GET /api/admin/database`
```json
{ "stats": {}, "recentSites": [], "recentDomains": [] }
```

### `GET /api/admin/cache`
Returns the hosting service cache stats payload or:
```json
{ "error": "Failed to fetch cache stats from hosting service", "message": "Hosting service unavailable" }
```

### `GET /api/admin/sites`
```json
{ "sites": [/* sites */], "customDomains": [/* domains */] }
```

### `GET /api/admin/health`
```json
{
  "uptime": 12345,
  "memory": { "heapUsed": 123, "heapTotal": 456, "rss": 789 },
  "timestamp": "2026-01-22T00:00:00.000Z"
}
```
