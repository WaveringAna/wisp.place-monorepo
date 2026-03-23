---
title: place.wisp.domain
description: Reference for the place.wisp.domain lexicon
---

Metadata record for a claimed wisp.place subdomain (e.g. `alice.wisp.place`). The record lives in the user's PDS as an audit trail — actual routing decisions use the PostgreSQL `domains` table, not this record.

**Lexicon version:** 1

## main (record)

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `domain` | `string` | ✅ | Full domain, e.g. `alice.wisp.place` |
| `createdAt` | `string` | ✅ | Format: `datetime` |

## Record Key

The record key is the subdomain label (the part before `.wisp.place`). A DID with multiple subdomains has multiple records:

```
at://did:plc:abc123/place.wisp.domain/alice
at://did:plc:abc123/place.wisp.domain/miku-fan
```

## Claim Flow

When a user claims `handle.wisp.place`:

1. User authenticates via OAuth (proves DID control)
2. Handle is validated (3–63 chars, `a-z0-9-`, no leading/trailing hyphen, not reserved)
3. Domain limit checked: max 3 wisp.place subdomains per DID
4. Database row inserted in `domains`
5. `place.wisp.domain` record written to PDS

Reserved handles include `www`, `api`, `admin`, `static`, `public`, `preview`, and others.

## Domain Rules

- Length: 3–63 characters
- Characters: `a-z`, `0-9`, `-`
- Must start and end with alphanumeric
- Stored and compared in lowercase
- Max 3 per DID
- Each subdomain can only be owned by one DID

Valid: `alice`, `my-site`, `dev2024`  
Invalid: `ab` (too short), `-alice` (leading hyphen), `alice.bob` (dot), `alice_bob` (underscore)

## Example

```json
{
  "$type": "place.wisp.domain",
  "domain": "alice.wisp.place",
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

## Database Schema

Routing and availability checks use the DB, not the PDS record:

```sql
CREATE TABLE domains (
    domain     TEXT PRIMARY KEY,  -- "alice.wisp.place"
    did        TEXT NOT NULL,
    rkey       TEXT,              -- site rkey (place.wisp.fs)
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
);
```

For a detailed write-up of the full domain system including custom domains, DNS verification, and Caddy on-demand TLS, see [How wisp.place maps domains to DIDs](https://nekomimi.leaflet.pub/3m5fy2jkurk2a).
