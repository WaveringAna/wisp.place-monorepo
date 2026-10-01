# Hosting response streaming

Large files now use `TieredStorage.getStream` rather than a whole-object storage
snapshot. Trusted source-CID metadata retains the established serving boundary;
legacy objects are hashed incrementally and replayed from disk only after the
manifest CID matches. A failed validation never exposes a partial response.
Concurrent mismatch recovery shares only a status, not a response stream, and
retains the existing negative TTL and upper-tier invalidation fences. Hosting's
cold S3 tier remains read-only.

Memory-tier chunks are borrowed only in this non-mutating response/hash path.
Other callers retain mutation-isolated chunks. Buffered HTML rewriting still
needs a materialized body, but its response uses bounded views instead of Bun's
full-body `Response(Buffer)` copy. The owned Node-to-Web adapter avoids Bun
1.4.2's Buffer-copying `Readable.toWeb` implementation and handles cancellation
while a pull is pending.

Range/If-Range, HEAD, representation ETags, and gzip negotiation use the existing
response rules. Legacy gzip and identity decoding are validated before headers
and retain the existing decompressed-output limit and gzip processing budget.
Trusted gzip with a validated size hint keeps its existing passthrough path.
No new file-size cap, cache-size setting, or request admission limit is added.

## Replay files

Replay files live in `.streams` beside `CACHE_DIR`, not in `/tmp` (which can be
memory-backed). The current fleet binds the parent `/cache` directory, with
`CACHE_DIR=/cache/sites`; `/cache/.streams` therefore stays on the disk bind.
Deployments mounting only `CACHE_DIR` must also provide a writable disk-backed
parent. Files/directories are private and removed after EOF, cancellation, or
preflight failure. Replays are transient, not part of the warm cache's byte
accounting; concurrent legacy reads trade memory retention for disk I/O and disk
space. Monitor free space on that volume.

A hard process/container kill can leave orphaned replay directories. If cleanup
is needed, stop hosting first and remove only `/cache/.streams/file-*`; do not
remove replay files while requests are active or touch the warm cache/source.
There is no schema migration or new persisted source format.

## Verify

Use the deployed runtime, Bun 1.4.2, and test isolation:

```text
NODE_ENV=test WEBHOOK_ALLOW_INSECURE_DEV=1 bun test --isolate
bun run check
bun x biome check <changed files>
```

`scripts/monitoring/hosting-streaming-profile.ts` generates the 98,691,200-byte
fixture incrementally, exercises the actual memory/disk tiers and response
adapter over local HTTP, verifies each body CID, and checks stream/replay cleanup.
Run it on a spare host or isolated test container, never as a large-file load test
against the constrained production node. Its measurements cover transport/storage,
not production middleware, deployment traffic, or a production capacity ceiling.
Use a regular-disk `PROFILE_CACHE` and constrained Linux runs before releasing.

The release follows [the tag pipeline](README.md). Push the commit to the GitHub
build mirror before the Tangled main branch and release tag. Verify image tags,
service uptime/health, cache-invalidation health, and a small served file afterward.
Rollback is the prior `WISP_TAG` via the same Komodo stack deployment; keep the
previous images. No cache deletion or database rollback is required.
