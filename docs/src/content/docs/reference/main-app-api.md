---
title: Main App API
description: REST endpoints served by the main app
---

Internal REST API for the main app (Bun + Elysia). Authenticated routes require a signed `did` cookie. Admin routes require a signed `admin_session` cookie and return `401 { error: 'Unauthorized' }` otherwise.

For the AT Protocol XRPC endpoints, see [XRPC API](/reference/xrpc-api).

---

## Auth `/api/auth/*`

### `GET /api/auth/login`
Redirects to the AT Protocol OAuth authorize URL.

- **302** → OAuth URL
- **302** → `/?error=missing_handle` if no handle provided
- **302** → `/?error=auth_failed` on failure

### `POST /api/auth/signin`
```json
{ "url": "https://..." }
```
On failure: `{ "error": "Authentication failed", "details": "..." }`

### `GET /api/auth/callback`
- **302** → `/onboarding` (new user)
- **302** → `/editor` (returning user)
- **302** → `/?error=auth_failed` on failure

### `POST /api/auth/logout`
```json
{ "success": true }
```

### `GET /api/auth/status`
```json
{ "authenticated": true, "did": "did:plc:..." }
{ "authenticated": false }
```

---

## User `/api/user/*`

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
{ "sites": [ /* site rows */ ] }
```

### `GET /api/user/domains`
```json
{
  "wispDomains": [{ "domain": "name.wisp.place", "rkey": "site-rkey" }],
  "customDomains": [ /* custom domain rows */ ]
}
```

### `POST /api/user/sync`
```json
{ "success": true, "synced": 2, "errors": [] }
```

### `GET /api/user/site/:rkey/domains`
```json
{ "rkey": "site-rkey", "domains": [ /* domain rows */ ] }
```

---

## Domain `/api/domain/*`

### `GET /api/domain/check`
```json
{ "available": true, "domain": "name.wisp.place" }
{ "available": false, "reason": "invalid" }
```

### `GET /api/domain/registered`
```json
{ "registered": true, "type": "wisp", "domain": "name.wisp.place", "did": "did:plc:...", "rkey": "site-rkey" }
{ "registered": true, "type": "custom", "domain": "example.com", "did": "did:plc:...", "rkey": "site-rkey", "verified": true }
{ "registered": false }
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

---

## Site `/api/site/*`

### `DELETE /api/site/:rkey`
```json
{ "success": true, "message": "Site deleted successfully" }
```
On failure: `{ "success": false, "error": "..." }`

### `GET /api/site/:rkey/settings`
Returns the `place.wisp.settings` record or defaults:
```json
{ "indexFiles": ["index.html"], "cleanUrls": false, "directoryListing": false }
```

### `POST /api/site/:rkey/settings`
```json
{ "success": true, "uri": "at://...", "cid": "bafy..." }
```
On failure: `{ "success": false, "error": "Only one of spaMode, directoryListing, or custom404 can be enabled" }`

---

## Uploads `/wisp/*`

### `POST /wisp/upload-files`
```json
{ "success": true, "jobId": "...", "message": "Upload started. Connect to /wisp/upload-progress/..." }
```
Empty upload: `{ "success": true, "uri": "at://...", "cid": "bafy...", "fileCount": 0, "siteName": "my-site" }`

### `GET /wisp/upload-progress/:jobId`
Server-sent events stream:

- `progress` → `{ status, progress, result, error }`
- `done` → `result`
- `error` → `{ error }`

---

## Admin `/api/admin/*`

### `POST /api/admin/login`
```json
{ "success": true }
```
On failure (401): `{ "error": "Invalid credentials" }`

### `POST /api/admin/logout`
```json
{ "success": true }
```

### `GET /api/admin/status`
```json
{ "authenticated": true, "username": "admin" }
{ "authenticated": false }
```

### `GET /api/admin/logs`
```json
{ "logs": [ /* combined log entries */ ] }
```

### `GET /api/admin/errors`
```json
{ "errors": [ /* combined error entries */ ] }
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
Returns hosting service cache stats, or:
```json
{ "error": "Failed to fetch cache stats from hosting service", "message": "Hosting service unavailable" }
```

### `GET /api/admin/sites`
```json
{ "sites": [ /* sites */ ], "customDomains": [ /* domains */ ] }
```

### `GET /api/admin/health`
```json
{
  "uptime": 12345,
  "memory": { "heapUsed": 123, "heapTotal": 456, "rss": 789 },
  "timestamp": "2026-01-22T00:00:00.000Z"
}
```
