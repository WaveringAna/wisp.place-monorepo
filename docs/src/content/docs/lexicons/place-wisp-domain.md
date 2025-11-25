---
title: place.wisp.domain
description: Reference for the place.wisp.domain lexicon
---

**Lexicon Version:** 1

## Overview

The `place.wisp.domain` lexicon defines **metadata records for wisp.place subdomains**,  
such as `alice.wisp.place` or `miku-fan.wisp.place`.

- **What lives in the PDS:** a small record that says “this DID claimed this domain at this time”.
- **What is authoritative:** the PostgreSQL `domains` table on the wisp.place backend  
  (routing and availability checks use the DB, not this record).

Use this page as a schema reference; routing and TLS details are covered elsewhere.

---

## Record: `main`

<a name="main"></a>

### `main` (record)

**Type:** `record`

**Description:** Metadata record for a claimed wisp.place subdomain.

**Properties:**

| Name        | Type     | Req'd | Description                                   | Constraints        |
| ----------- | -------- | ----- | --------------------------------------------- | ------------------ |
| `domain`    | `string` | ✅    | Full domain name, e.g. `alice.wisp.place`     |                    |
| `createdAt` | `string` | ✅    | When the domain was claimed                   | Format: `datetime` |

---

## Claim Flow & `rkey`

### Subdomain claiming (high‑level)

When a user claims `handle.wisp.place`:

1. **User authenticates** via OAuth (proves DID control).
2. **Handle is validated**:
   - 3–63 characters
   - `a-z`, `0-9`, `-` only
   - Does not start/end with `-`
   - Not in the reserved set (`www`, `api`, `admin`, `static`, `public`, `preview`, …)
3. **Domain limit enforced:** max 3 wisp.place subdomains per DID.
4. **Database row created** in `domains`:

```sql
INSERT INTO domains (domain, did, rkey)
VALUES ('handle.wisp.place', did, NULL);
```

5. **PDS record written** in `place.wisp.domain` as metadata.

### Record key (`rkey`)

The **record key is the normalized handle** (the subdomain label):

```text
at://did:plc:abc123/place.wisp.domain/wisp
```

If a DID claims multiple subdomains, it will have multiple records:

- `at://did:plc:abc123/place.wisp.domain/wisp`
- `at://did:plc:abc123/place.wisp.domain/miku-fan`

---

## Examples

### Basic domain record

```json
{
  "$type": "place.wisp.domain",
  "domain": "alice.wisp.place",
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

### URI structure

Complete AT-URI for a domain record:

```text
at://did:plc:7puq73yz2hkvbcpdhnsze2qw/place.wisp.domain/wisp
```

Breakdown:

- **`did:plc:7puq73yz2hkvbcpdhnsze2qw`** – User DID  
- **`place.wisp.domain`** – Collection ID  
- **`wisp`** – Record key (subdomain handle)

---

## Domain rules (summary)

- **Length:** 3–64 characters  
- **Characters:** `a-z`, `0-9`, and `-`  
- **Shape:** must start and end with alphanumeric  
- **Case:** stored/compared in lowercase  
- **Limit:** up to **3** wisp.place subdomains per DID  
- **Uniqueness:** each `*.wisp.place` can only be owned by one DID at a time.

Valid examples:

- `alice` → `alice.wisp.place`
- `my-site` → `my-site.wisp.place`
- `dev2024` → `dev2024.wisp.place`

Invalid examples:

- `ab` (too short)  
- `-alice` / `alice-` (leading or trailing hyphen)  
- `alice.bob` (dot)  
- `alice_bob` (underscore)

---

## Database & routing

The **lexicon record is not used for routing**. All real decisions use the DB:

```sql
CREATE TABLE domains (
    domain     TEXT PRIMARY KEY,  -- "alice.wisp.place"
    did        TEXT NOT NULL,     -- User DID
    rkey       TEXT,              -- Site rkey (place.wisp.fs)
    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
);

CREATE INDEX domains_did_rkey ON domains (did, rkey);
```

The `domains` table powers:

- **Availability checks** (`/api/domain/check`)  
- **Mapping** from hostname → `(did, rkey)` for the hosting service  
- **Safety:** you must explicitly change/delete routing in the DB, avoiding accidental takeovers.

The `place.wisp.domain` PDS record is there for:

- **Audit trail** – who claimed what, when  
- **User-visible history** in their repo  
- **Optional cross‑checking** against the DB if you care to.

---

## Related

- [place.wisp.fs](/lexicons/place-wisp-fs) – Site manifest lexicon  
- Custom domains / DNS verification – covered in separate routing/hosting docs  
- [AT Protocol Lexicons](https://atproto.com/specs/lexicon)

## Additional commentary

For a detailed write‑up of the full domain system (subdomains, custom domains, DNS TXT/CNAME flow, Caddy on‑demand TLS, and hosting routing), see  
**[How wisp.place maps domains to DIDs](https://nekomimi.leaflet.pub/3m5fy2jkurk2a)**.


