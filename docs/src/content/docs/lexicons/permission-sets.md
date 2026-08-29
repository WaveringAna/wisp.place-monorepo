---
title: OAuth Permission Sets
description: The place.wisp.auth* permission sets wisp.place clients request during OAuth
---

AT Protocol replaced the old coarse `transition:*` OAuth scopes with granular
`repo:` / `rpc:` / `blob:` scopes. Granular scopes are precise but unreadable —
a full wisp.place login needs more than twenty of them, which makes for a
terrible consent screen.

**Permission sets** solve that. A permission set is a Lexicon document of type
`permission-set` that bundles granular permissions behind one human-readable
title. A client asks for the bundle with `include:<nsid>`, and the
authorization server resolves the NSID, shows the set's title and detail on the
consent screen, and expands it into the underlying granular scopes before
minting the token.

## The sets

wisp.place publishes four, all under the `place.wisp` authority:

| NSID | Consent screen title | Grants |
| --- | --- | --- |
| `place.wisp.authSites` | Manage your wisp.place sites | write access to `place.wisp.fs`, `place.wisp.subfs`, `place.wisp.settings`, `place.wisp.domain` |
| `place.wisp.authWebhooks` | Manage your wisp.place webhooks | write access to `place.wisp.v2.wh` |
| `place.wisp.authHosting` | Use wisp.place hosting features | the `place.wisp.v2.{site,domain,privateSite}.*` XRPC methods |
| `place.wisp.authFullAccess` | Full wisp.place access | everything above, plus `place.wisp.v2.secret.*` |

Third-party clients are welcome to request them. A read-only viewer wants none
of these; a deploy tool wants `place.wisp.authSites`.

## What each client asks for

The web editor talks to your PDS directly, so it only needs record writes:

```
atproto blob:*/* include:place.wisp.authSites include:place.wisp.authWebhooks
```

`wispctl` writes records itself but reaches domain and private-site management
through proxied XRPC calls to the hosting service:

```
atproto blob:*/* include:place.wisp.authSites include:place.wisp.authHosting
```

`atproto` and `blob:*/*` are always requested directly — neither can live
inside a permission set.

## How resolution works

An authorization server resolves `include:place.wisp.authSites` like this:

1. The NSID's authority is `wisp.place` (the NSID reversed, minus the name).
2. DNS `TXT _lexicon.wisp.place` &rarr; `did=did:plc:7puq73yz2hkvbcpdhnsze2qw`.
3. `com.atproto.repo.getRecord` on that repo, collection
   `com.atproto.lexicon.schema`, rkey `place.wisp.authSites`.

If any set in a request fails to resolve, the whole authorization request is
rejected with `invalid_scope` — the server never guesses.

Two rules constrain what a set may contain:

- It may only reference NSIDs under its own authority. `place.wisp.authSites`
  can grant `repo:place.wisp.fs`, but never `repo:app.bsky.feed.post`.
- `rpc` permissions may not pin a concrete audience. wisp.place sets use
  `aud: "*"` so that `wispctl --service did:web:my-instance.example` keeps
  working against a self-hosted hosting service without re-authorizing.

## Fallback for older servers

Two things can go wrong on an authorization server that has not caught up:

- It rejects the pushed authorization request outright. The client retries with
  the granular expansion of the same sets.
- It accepts the request and *silently drops* the `include:` values it does not
  understand, handing back a session that can not write anything. The client
  catches this after the callback by comparing the granted scope against what
  it actually needs, then re-authorizes with the granular scopes.

An authorization server rejects any requested scope value the client did not
declare up front, so the two strategies have to be declared somewhere. The web
editor declares the union in its hosted client metadata, which costs nothing.
`wispctl` is a loopback client, whose `client_id` *contains* its declared
scopes — declaring both there would make every authorization URL the user sees
several times longer, so it builds a separate client per strategy and records
on the account which one minted the session. Restoring has to rebuild the same
client identity or the token refresh is rejected.

Note that the granted scope on a token is always the *expanded* granular form,
never the `include:` value that was requested. Anything checking "did I get
what I asked for" has to compare meaning, not scope strings.

## Publishing

The sets live in `packages/@wispplace/constants/src/oauth-scopes.ts` so the
clients and the published records cannot drift. To regenerate
`lexicons/permissions/*.json` and publish the records:

```bash
bun run publish:permission-sets --write   # regenerate the JSON only
WISP_PUBLISH_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx bun run publish:permission-sets
```

The app password must belong to the account that `_lexicon.wisp.place` points
at. Publishing is idempotent — unchanged sets are skipped.
