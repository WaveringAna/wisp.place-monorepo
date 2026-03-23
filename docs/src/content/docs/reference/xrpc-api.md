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
