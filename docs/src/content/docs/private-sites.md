---
title: Private Sites
description: Owner-only and share-link sites that never touch the PDS, and how they migrate to permissioned data
---

Private sites are sites that only their owner, and anyone holding a share link, can open.
They are stored entirely by wisp and are **never written to your PDS**.

## Why they are not on the PDS

The AT Protocol repository is a public broadcast medium:

- `com.atproto.sync.getBlob` is unauthenticated, so uploading site files as blobs makes
  them publicly fetchable no matter what the app does
- `com.atproto.sync.getRepo` returns a public CAR of the repository
- `com.atproto.sync.subscribeRepos` broadcasts every commit, so writing a `place.wisp.fs`
  record would publish the site's existence, name, and structure to every relay

Hiding a URL is not access control. So until AT Protocol ships permissioned data, private
sites live only in wisp's own storage, and `firehose-service` is not involved at all.

## Creating a private site

```bash
wisp private deploy --path ./my-site --name "draft"
```

Options:

| Flag | Meaning |
|---|---|
| `--path <dir>` | Directory to upload (default `.`) |
| `--name <name>` | Display name. Not an identifier |
| `--expiry <minutes>` | Minutes until expiry. **Omit** for the default (7 days), **`0`** for never |

Private sites are served from a dedicated host, `priv.wisp.place`, which never serves
public user content.

## Expiry

The same rule applies to sites and to share links:

- **omitted** — the configured default is applied (`DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES`, 7 days)
- **`0`** — never expires
- **`n`** — expires `n` minutes from now

A share link is additionally clamped to its site's expiry, so a link can never outlive the
content it points at.

An expired site stays visible **to its owner**, so it can be inspected or deleted. It is
closed to everyone else.

## Share links

```bash
wisp private share <siteId> --label "for review"
wisp private shares <siteId>
wisp private revoke <siteId> <shareId>
```

The share URL carries its credential in a query parameter:

```
https://priv.wisp.place/<siteId>/?k=wss_...
```

Treat that URL as a secret:

- the token is generated from 32 random bytes and stored **only as a sha256 hash**
- it is displayed exactly once, at creation, and cannot be retrieved afterwards
- `wisp private shares` shows only a short non-secret prefix
- revocation is immediate and permanent

Private responses are sent with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`
(so the token cannot leak through an outbound link), and `X-Robots-Tag: noindex`.

## Access rules

| Requester | Result |
|---|---|
| The owner, signed in | allowed |
| A different signed-in account | denied |
| Anonymous, no link | denied |
| A valid share link | allowed |
| An expired or revoked link | denied |
| Any requester after the site expired | denied (except the owner) |

Every denial returns an identical `404`, so probing cannot distinguish an existing private
site from one that never existed, nor a revoked link from an expired one.

## Migration path to permissioned data (v2)

[Proposal 0016](https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data)
specifies **permissioned data** for AT Protocol: records with an access perimeter, held in a
permissioned repo per `(user, space)` and gated by a space credential. It is a merged
proposal with a work-in-progress implementation, not shipped protocol, so v1 does not depend
on it.

v1 was shaped so the migration is additive rather than a rewrite:

**Identifiers.** A private site id is TID-shaped and record-key valid, because 0016
specifies a space key (`skey`) as "analogous to a record key". The existing `siteId` can
become the `skey` unchanged.

**Ownership.** `owner_did` is immutable and is the subject of every access decision, which
matches 0016 keeping record authority on the user DID.

**One decision point.** All authorization runs through `evaluateAccess` in
`@wispplace/private-sites`. It is a pure function over `(site, shares, principal, now)`.
Under 0016, a space may set `policy: managing-app`, in which case the space authority calls
the managing app's `com.atproto.simplespace.checkUserAccess` at credential-mint time to
decide whether to authorize a user. **wisp.place becomes that managing app**, and the body
of `evaluateAccess` becomes the body of `checkUserAccess`.

**Principals, not transports.** `AccessPrincipal` is an abstract union — `owner`,
`shareToken`, `anonymous` — deliberately not "a cookie" or "a query parameter". Adding a
`spaceCredential` principal in v2 is a new variant, not a refactor.

**Grants as rows.** Share links are first-class records with stable ids, expiry, and
revocation, so they map onto either a simplespace member list or dynamic
`checkUserAccess` policy input.

**Content metadata.** Every file retains its path, size, MIME type, and sha256, so files can
be re-uploaded as permissioned blobs and reconciled by digest.

### What migration will involve

1. Create a space per private site, with wisp.place as the `managingApp`.
2. Re-upload each stored file as a permissioned blob, matching on the retained sha256.
3. Write file records into the owner's permissioned repo, keyed by the existing `siteId`.
4. Reimplement `evaluateAccess` behind `checkUserAccess`.
5. Serve reads through space credentials, keeping share links working as a wisp-level
   grant that `checkUserAccess` honours.

### What will not change

Permissioned data provides **access control, not confidentiality** — the proposal is
explicit that it is not end-to-end encrypted and that servers can read the data they handle.
That is also true of v1. Private sites are private from other *users*, not from the wisp
operator. Anything needing protection from the operator requires application-layer
encryption, which is out of scope for both v1 and 0016.
