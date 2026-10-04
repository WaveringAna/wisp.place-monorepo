# Preview bot on vine

Deployed on 2026-10-03. Public TLS and rejection responses verified; status
page remained HTTPS 200. See fleet evidence
`records/2026-10-03-preview-bot-vine/`.
Approved application source: `efda41e9f048abad4fc3ea46b3c5a37e5c3f4264`.
The checked-in `preview-bot.container` pins the deployed manifest digest.
Startup authenticated `wisp.place` as `did:plc:7puq73yz2hkvbcpdhnsze2qw`.
Initial peak service memory was 43,839,488 bytes; OOM false, zero restarts.
104 focused tests passed (zero failures). An ephemeral read-only PostgreSQL
probe using the same private environment and container network verified a
replica connection, transaction_read_only=on, SELECT privilege, and 752 domains.
Live claim-owner rejection remains unverified: it needs a genuine PR pipeline
fixture. Startup alone opens the database pool lazily.
Build the existing `apps/preview-bot/Dockerfile` from a clean archive of that
commit, not a dirty checkout or the Effect migration branch. Vine is Fedora 44
amd64, using rootful Podman quadlets, independently of Komodo releases.

## Ownership and dependencies

The bot posts AT Protocol comments using the `wisp.place` account. It reads
`domains.domain` and `domains.did` in PostgreSQL; prefer a role granted only
SELECT on those columns, via a mesh HAProxy endpoint. It does not migrate or
write the database. Upstream PDS identity/login must succeed before it listens.
Requests also depend on repo-owner PDS records, Spindle pipelines, pull records,
and the preview hosting endpoint. `BASE_HOST=wisp.place` controls claim lookups;
`PREVIEW_HOST=preview.wisp.place` controls preview URLs, not the bot's public hostname.

Secrets belong only in `/opt/preview-bot/secrets.env`, root-owned mode 0600,
inside a 0700 directory. Populate from a private operator-provided path, never
chat, git, command arguments, or captured environment output. See the example
for required variable names. No persistent bot volume is required: comments
are stored in the PDS, session and rate limits are in memory (reset on restart).

## Install gates

1. Verify vine identity, mesh, free memory/disk, and status.wisp.place HTTPS 200.
   Preserve `/opt/wisp-status` and existing Caddy routes. Its daily local backup
   includes status sqlite/config and Caddy, not bot secrets or an off-host backup.
2. Build linux/amd64 away from vine, push a commit-specific tag to the mesh
   registry, record the resulting manifest digest and image ID. Explicitly pull
   on vine with `podman pull --tls-verify=false IMAGE@sha256:DIGEST` (the registry
   intentionally uses HTTP over WireGuard). If the build host Docker daemon
   cannot push HTTP, stream `docker save` through SSH to `podman load` on vine,
   then `podman push --tls-verify=false` to the registry; do not change global
   daemon security settings for this one deployment. The quadlet uses the exact digest
   and `Pull=never`, so no host-wide registry configuration is required.
3. Install the populated quadlet as
   `/etc/containers/systemd/preview-bot.container`; `systemctl daemon-reload`,
   then `systemctl start preview-bot`. Quadlet's `[Install]` handles boot startup;
   do not enable the generated service. This bounds bot RAM to 256 MiB and binds
   only loopback port 3004. Confirm mesh DB connectivity from the container;
   Podman's default subnet is 10.223.0.0/24 (pool 10.223.0.0/16), avoiding mesh overlap.
4. Verify loopback behavior below before exposing a route. Copy Caddyfile with
   metadata to a timestamped rollback file outside the daily rotating backup.
   Append `Caddyfile.fragment` to `/opt/caddy/Caddyfile`, preserving its inode:
   Caddy bind-mounts this individual file, so atomic replacement can leave the
   container seeing the previous inode. Validate using
   `podman exec caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`.
   Only on success, reload with the same command replacing `validate` with
   `reload`. Do not restart Caddy or gatus. DNS must point at vine before normal
   ACME issuance/public verification; DNS is managed separately.
5. Verify public TLS, rejection responses, and status.wisp.place still 200.
   Record digest, container/service state, response bodies, and memory use.

## Verification and security contract

There is **no health endpoint** at this revision. `GET /health` returns
404 `{"error":"not-found"}`. `GET /v1/preview` returns
405 `{"error":"method-not-allowed"}` and proves the handler is listening, not
DB readiness. Do not describe either as a 200 health check.

There is **no inbound bearer-token authentication** for webhook delivery either. POST `/v1/hook` accepts the webhook service's JSON envelope, but trusts no event facts: it validates the DID, collection, event, and pull rkey, then resolves the owner's repo record and matching pull-request pipeline from the configured authorities before running the same preview verification and comment path. Ordinary site rkeys and deletes return 200 `{"status":"ignored"}` so they are not retried. A pipeline that has not appeared yet, or a preview not serving yet, returns 409 for webhook retry; upstream failures return 502 and permanent validation/ownership failures return 422.

There is **no inbound bearer-token authentication**. POST `/v1/preview` accepts
JSON identifiers only, independently verifies repo/pipeline/pull/claim ownership,
and only then checks preview serving and writes a comment. Bad JSON/identifier
shape returns 400, wrong media type 415, and a foreign/missing claim returns
422 `claim-not-owned` after the earlier checks pass. Bot PDS login failure is a
startup failure, not an HTTP 401. A fake bearer token must not be interpreted
as authorizing anything. Rate limits are bounded to 10,000 keys per limiter.

Run `bun test --isolate apps/preview-bot` on the pinned source. The focused
suite covers wrong claim owner, forged/fork pipelines, malformed requests,
upstream failures, rate limits, and comment writes. A live ownership rejection
requires a genuine repo/pull/pipeline fixture reaching that check; malformed
requests alone do not prove it. Avoid successful production comment writes
without an approved disposable pull request.

## Rollback

Restore the timestamped Caddyfile contents **in place**, validate, then reload
Caddy. Confirm status HTTPS 200. Stop `preview-bot.service`, remove only the new
quadlet, and `systemctl daemon-reload`. Keep the digest and private env for a
retry, or remove secrets explicitly when decommissioning. No DB restore is
needed. If a route was never activated, skip Caddy changes entirely.
