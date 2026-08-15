---
title: XRPC API
description: AT Protocol XRPC endpoints served by the main app
---

The main app serves AT Protocol XRPC endpoints at `/xrpc/{nsid}`. All authenticated endpoints require a service JWT in the `Authorization: Bearer <token>` header, scoped to the called NSID (`lxm` claim).

Each endpoint also accepts kebab-case and lowercase NSID aliases (e.g. `place.wisp.v2.domain.add-site`, `place.wisp.v2.domain.addsite`).

---

## Domain

### `place.wisp.v2.domain.getStatus` — query

Returns the registration status of any domain. Auth is optional — if authenticated, also returns ownership info for domains you own.

**Params:**

| Field | Type | Required |
|---|---|---|
| `domain` | `string` | ✅ |

**Response:**

| Field | Type |
|---|---|
| `domain` | `string` |
| `status` | `"unclaimed" \| "pendingVerification" \| "verified" \| "alreadyClaimed"` |
| `kind` | `"wisp" \| "custom"` |
| `verified` | `boolean` |
| `siteRkey` | `string` |
| `lastCheckedAt` | `string` (datetime) |
| `lastError` | `string` |

---

### `place.wisp.v2.domain.getList` — query 🔒

Returns all domains (wisp subdomains and custom domains) owned by the authenticated DID.

**Response:**

```json
{
  "domains": [
    {
      "domain": "alice.wisp.place",
      "kind": "wisp",
      "status": "verified",
      "verified": true,
      "siteRkey": "my-site"
    },
    {
      "domain": "example.com",
      "kind": "custom",
      "status": "pendingVerification",
      "verified": false,
      "lastCheckedAt": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

**Errors:** `AuthenticationRequired`

---

### `place.wisp.v2.domain.claimSubdomain` — procedure 🔒

Claims a `*.wisp.place` subdomain for the authenticated DID. Max 3 wisp subdomains per DID.

**Input:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `handle` | `string` | ✅ | Subdomain label only, e.g. `alice` (3–63 chars, `a-z0-9-`) |
| `siteRkey` | `string` | | Map a site immediately after claim |

**Response:**

| Field | Type |
|---|---|
| `domain` | `string` |
| `kind` | `"wisp"` |
| `status` | `"verified" \| "alreadyClaimed"` |
| `siteRkey` | `string` |

**Errors:** `AuthenticationRequired`, `InvalidDomain`, `AlreadyClaimed`, `DomainLimitReached`, `RateLimitExceeded`

---

### `place.wisp.v2.domain.claim` — procedure 🔒

Claims a custom domain for the authenticated DID. Returns DNS challenge details for ownership verification.

**Input:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `domain` | `string` | ✅ | Custom FQDN (3–253 chars) |
| `siteRkey` | `string` | | Map a site immediately after claim |

**Response:**

| Field | Type | Notes |
|---|---|---|
| `domain` | `string` | |
| `kind` | `"custom"` | |
| `status` | `"alreadyClaimed" \| "pendingVerification" \| "verified"` | |
| `challengeId` | `string` | Used to derive DNS targets |
| `txtName` | `string` | TXT record hostname for ownership proof |
| `txtValue` | `string` | TXT record value (your DID) |
| `cnameTarget` | `string` | Advisory CNAME target |
| `siteRkey` | `string` | |

**Errors:** `AuthenticationRequired`, `InvalidDomain`, `AlreadyClaimed`, `DomainLimitReached`, `RateLimitExceeded`

---

### `place.wisp.v2.domain.addSite` — procedure 🔒

Maps a site to a domain you own.

**Input:**

| Field | Type | Required |
|---|---|---|
| `domain` | `string` | ✅ |
| `siteRkey` | `string` | ✅ |

**Response:**

| Field | Type |
|---|---|
| `domain` | `string` |
| `kind` | `"wisp" \| "custom"` |
| `status` | `"pendingVerification" \| "verified"` |
| `siteRkey` | `string` |
| `mapped` | `true` |

**Errors:** `AuthenticationRequired`, `InvalidDomain`, `InvalidRequest`, `NotFound`

---

### `place.wisp.v2.domain.delete` — procedure 🔒

Deletes a domain (wisp subdomain or custom domain) owned by the authenticated DID.

**Params:**

| Field | Type | Required |
|---|---|---|
| `domain` | `string` | ✅ |

**Response:**

```json
{ "domain": "alice.wisp.place", "deleted": true }
```

**Errors:** `AuthenticationRequired`, `InvalidDomain`, `NotFound`

---

## Site

### `place.wisp.v2.site.getList` — query 🔒

Returns all sites owned by the authenticated DID, with their mapped domains.

**Response:**

```json
{
  "sites": [
    {
      "siteRkey": "my-site",
      "displayName": "My Site",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "updatedAt": "2024-01-15T10:30:00.000Z",
      "domains": [
        { "domain": "alice.wisp.place", "kind": "wisp", "status": "verified", "verified": true }
      ]
    }
  ]
}
```

**Errors:** `AuthenticationRequired`

---

### `place.wisp.v2.site.getDomains` — query

Returns all domains mapped to a specific site. Public — no auth required.

**Params:**

| Field | Type | Required |
|---|---|---|
| `did` | `string` | ✅ |
| `rkey` | `string` | ✅ |

**Response:**

```json
{
  "domains": [
    { "domain": "alice.wisp.place", "kind": "wisp", "status": "verified", "verified": true }
  ]
}
```

---

### `place.wisp.v2.site.delete` — procedure 🔒

Deletes a site and detaches all mapped domains.

**Input:**

| Field | Type | Required |
|---|---|---|
| `siteRkey` | `string` | ✅ |

**Response:**

```json
{
  "siteRkey": "my-site",
  "deleted": true,
  "unmappedDomains": [
    { "domain": "alice.wisp.place", "kind": "wisp", "status": "verified" }
  ]
}
```

**Errors:** `AuthenticationRequired`, `InvalidRequest`, `NotFound`

---

## Private Sites

Private-site methods are authenticated and only operate on sites owned by the calling DID.
Private-site files are stored by wisp.place and are not written to the caller's PDS. See
[Private Sites](/private-sites) for the feature's access and expiry rules.

### `place.wisp.v2.privateSite.create` — procedure 🔒

Creates a private site from a `multipart/form-data` upload.

**Input:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` | ✅ | Display name, up to 128 characters |
| `files` | `file` | ✅ | Repeat for each file; the filename is used as its path |
| `expiryMinutes` | `integer` | | Omit for seven days, `0` for no expiry, maximum 525600 |

Uploads are limited to 500 files and 100 MB in total.

**Response:**

| Field | Type | Notes |
|---|---|---|
| `siteId` | `string` (record-key) | Stable private-site identifier |
| `name` | `string` | Display name |
| `fileCount` | `integer` | |
| `totalBytes` | `integer` | |
| `expiresAt` | `string` (datetime) | Omitted when the site does not expire |
| `createdAt` | `string` (datetime) | |
| `url` | `string` | Requires an account with access or a share link |

**Errors:** `AuthenticationRequired`, `InvalidRequest`, `PayloadTooLarge`

---

### `place.wisp.v2.privateSite.list` — query 🔒

Lists private sites owned by the authenticated DID.

**Response:**

```json
{
  "sites": [
    {
      "siteId": "3mabc...",
      "name": "review",
      "fileCount": 12,
      "totalBytes": 48321,
      "expiresAt": "2026-08-22T12:00:00.000Z",
      "createdAt": "2026-08-15T12:00:00.000Z",
      "shareCount": 1,
      "expired": false
    }
  ]
}
```

`expiresAt` is omitted when the site does not expire. `shareCount` includes only active
shares.

**Errors:** `AuthenticationRequired`

---

### `place.wisp.v2.privateSite.delete` — procedure 🔒

Deletes an owned private site, its files, and all of its share links.

**Input:**

| Field | Type | Required |
|---|---|---|
| `siteId` | `string` (record-key) | ✅ |

**Response:**

```json
{ "siteId": "3mabc...", "deleted": true }
```

**Errors:** `AuthenticationRequired`, `InvalidRequest`, `NotFound`

---

### `place.wisp.v2.privateSite.createShare` — procedure 🔒

Creates a share link for an owned private site. The returned URL contains the credential
and is only returned once.

**Input:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `siteId` | `string` (record-key) | ✅ | |
| `label` | `string` | | Human label, up to 128 characters |
| `expiryMinutes` | `integer` | | Omit for seven days; `0` for no independent expiry |
| `audienceDid` | `string` (DID) | | Restricts the link to this account; omit for an unrestricted link |

A share's expiry is clamped to the site's expiry.

**Response:**

| Field | Type | Notes |
|---|---|---|
| `shareId` | `string` | |
| `siteId` | `string` (record-key) | |
| `url` | `string` | Short share URL; returned once |
| `directUrl` | `string` (URI) | Equivalent URL on the private-site origin |
| `expiresAt` | `string` (datetime) | Omitted when the share does not expire |
| `createdAt` | `string` (datetime) | |
| `audienceDid` | `string` (DID) | Present for account-restricted links |

**Errors:** `AuthenticationRequired`, `InvalidRequest`, `NotFound`

---

### `place.wisp.v2.privateSite.listShares` — query 🔒

Lists share links for an owned private site. Share credentials are never returned.

**Params:**

| Field | Type | Required |
|---|---|---|
| `siteId` | `string` (record-key) | ✅ |

**Response:**

```json
{
  "shares": [
    {
      "shareId": "3mdef...",
      "tokenPrefix": "wss_abcd",
      "label": "review",
      "audienceDid": "did:plc:...",
      "expiresAt": "2026-08-22T12:00:00.000Z",
      "createdAt": "2026-08-15T12:00:00.000Z",
      "lastUsedAt": "2026-08-16T09:00:00.000Z",
      "status": "active"
    }
  ]
}
```

`status` is `active`, `expired`, or `revoked`. `tokenPrefix` is for identification only
and does not grant access.

**Errors:** `AuthenticationRequired`, `NotFound`

---

### `place.wisp.v2.privateSite.revokeShare` — procedure 🔒

Permanently revokes a share link.

**Input:**

| Field | Type | Required |
|---|---|---|
| `siteId` | `string` (record-key) | ✅ |
| `shareId` | `string` | ✅ |

**Response:**

```json
{ "shareId": "3mdef...", "revoked": true }
```

**Errors:** `AuthenticationRequired`, `InvalidRequest`, `NotFound`

---

## Signing Secrets

Server-managed HMAC signing secrets for webhooks. The token is returned **once** at creation time and never stored in plaintext — it cannot be retrieved again, only rotated.

All four endpoints require authentication (`AuthenticationRequired` on failure).

### `place.wisp.v2.secret.create` — procedure 🔒

Creates a new signing secret scoped to the authenticated DID.

**Input:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | `string` (record-key) | ✅ | Unique per DID, `a-z0-9-` |

**Response:**

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | |
| `token` | `string` | `wsk_` prefixed — store this now, never shown again |
| `createdAt` | `string` (datetime) | |

**Errors:** `AuthenticationRequired`, `InvalidRequest`, `AlreadyExists`

---

### `place.wisp.v2.secret.list` — query 🔒

Lists all secrets for the authenticated DID. Token values are never returned.

**Response:**

```json
{
  "secrets": [
    {
      "name": "my-secret",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "lastRotatedAt": "2024-02-01T09:00:00.000Z"
    }
  ]
}
```

**Errors:** `AuthenticationRequired`

---

### `place.wisp.v2.secret.rotate` — procedure 🔒

Generates a new token for an existing secret. The old token is invalidated immediately.

**Input:**

| Field | Type | Required |
|---|---|---|
| `name` | `string` | ✅ |

**Response:**

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | |
| `token` | `string` | New token — store this now, never shown again |
| `rotatedAt` | `string` (datetime) | |

**Errors:** `AuthenticationRequired`, `NotFound`

---

### `place.wisp.v2.secret.delete` — procedure 🔒

Deletes a signing secret. Any webhooks referencing this `secretId` will stop being signed.

**Input:**

| Field | Type | Required |
|---|---|---|
| `name` | `string` | ✅ |

**Response:** `{}`

**Errors:** `AuthenticationRequired`, `NotFound`
