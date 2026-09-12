# verified exact-site repair

`bun run scripts/repair-site.ts --did DID --rkey RKEY` is read-only by default.
It verifies the canonical `place.wisp.fs` record, expands SubFS records with their
source owners, and checks the declared size and CID of every raw blob. Empty
blobs are verified too. It never removes or rewrites PDS records or blobs.

## before running

- deploy this version to **all** firehose/revalidation workers. stop old workers;
  a mixed rollout is not safe. the command requires the versioned, expiring
  verified-repair capability from the sole recently active consumer.
- use the firehose service's environment and explicit `REDIS_URL`,
  `WISP_REVALIDATE_STREAM`, `WISP_REVALIDATE_GROUP`, and `DATABASE_URL`.
  database access is read-only quota admission. normal firehose storage config
  is required when loading its validation code. do not point at a guessed queue.
- keep DLQ records and the operator's terminal output. this command does not
  delete DLQ evidence, originals, rewritten objects, cache metadata, or site rows.
- confirm that the PDS now serves correct bytes. do not bypass a failed preflight.
  missing blobs must be restored by the repository owner, or its manifest must
  be corrected through the normal upload flow.

## inspect, then apply

```sh
# provide the explicit environment above through your normal secret manager.
bun run scripts/repair-site.ts --did did:plc:EXACT_DID --rkey EXACT_RKEY

# only after the dry-run verifies every source blob:
bun run scripts/repair-site.ts --did did:plc:EXACT_DID --rkey EXACT_RKEY --apply --confirm-worker-rollout
```

`--apply` requires `--confirm-worker-rollout`: an explicit operator acknowledgement
that every possible worker, including standby workers, has been upgraded. This flag
is not a distributed rollout guarantee.

Both identifiers are mandatory. Handles, lists, prefixes, wildcards, duplicate
flags, and unknown flags are rejected. A bad cached site does not need to be
quarantined: the same verified full repair also supports an absent fence.

Each preflight pass has a ten-minute deadline, a 1 GiB aggregate transfer cap,
and the existing record, SubFS, blob, file-count and site-size limits. Fetches
carry cancellation and enforce byte bounds before accepting streamed data.
The command checks the complete source again before enqueue and after the
completion proof. These repeat reads can transfer a large site three times.
`SIGINT`/`SIGTERM` cancel further work. They do not roll back a committed enqueue.

The apply transition is one Redis Lua script. It compares the observed exact
site's quarantine value **and presence**, site revision and quarantine generation.
A generation changes on every new DLQ quarantine, including same-value fences.
The script also checks the live group, capability, consumer activity, capacity,
and existing storage-miss work. It first enqueues full storage-miss work, then
releases only the observed fence. It never fabricates a newer `sourceVersion`.
An existing live storage-miss request causes refusal, not misleading deduped success.

The worker reacquires the site's write lock, re-reads the authoritative record,
and checks the expected root CID and expanded manifest fingerprint before any
repair writes. It downloads all files even when CIDs match the cache ledger.
Existing content stays in place until the worker materializes replacements.

## understand the result

- `dry-run`: source verification finished; no Redis or storage writes occurred.
- `enqueued-unconfirmed`: the atomic transition committed. Save `streamId` and
  `token`; this line is **not success**.
- `materialized`: the matching worker proof confirms the requested manifest was
  materialized and its terminal invalidation was durably published. The command
  also reverified the source and unchanged fence/revision/generation state.
  This is not a claim that every edge consumer has already applied invalidation.

The command waits ten minutes by default. Use `--wait-ms N` for a bounded wait
from 1,000 to 1,800,000 ms. A timeout, dropped/ACKed entry, renewed quarantine,
changed source, or invalid proof exits nonzero. Queue disappearance alone is
never success. A worker completion receipt has no expiry while its job remains
pending. After successful ACK and removal of that job, the receipt expires after
24 hours. A replay with a matching receipt only completes queue bookkeeping;
it does not download or materialize the site again.

After an ambiguous connection error or timeout, inspect the recorded token,
stream entry, worker logs and DLQ before retrying. Do not run standalone `DEL`
on the quarantine key, clear the site cache, or delete originals as a shortcut.
The worker may still be running. A newer source revision or concurrent quarantine
requires a fresh dry-run; this command must not override it.

## broken-blob quarantine

Raw blob integrity failures have stable codes:

- `BLOB_MISSING`: the blob endpoint returned a confirmed missing-blob response.
- `BLOB_SIZE_MISMATCH`: received raw bytes do not match the manifest's declared size.
- `BLOB_CID_MISMATCH`: received raw bytes do not hash to the declared CID.
- `BLOB_INVALID_CID`: the declared CID cannot be parsed.
- `BLOB_UNSUPPORTED_CID`: the declared CID is not CIDv1/raw/SHA-256.

The DLQ entry keeps `blobDetails` JSON with `pds`, `recordCid`, `path`, `blobCid`,
`ownerDid`, `expectedSize`, `actualSize`, and optional `status`. The PDS identity is
sanitized; original blob bytes and credentials are not stored in the DLQ.
Network/time-out failures remain transient and follow the worker's bounded retry
policy. A confirmed integrity failure receives the writer's bounded inline retry,
then enters quarantine instead of an unlimited revalidation loop.

A zero-length response for a declared nonempty blob fails verification. An
actual zero-byte blob with size zero and its authentic empty-content CID is valid.
The command checks it rather than skipping it. After the PDS serves correct blobs,
a same-CID repair still forces every file through verified materialization. Nothing
in production automatically releases these fences; release requires the explicit,
verified operator workflow above.

## limits of the guard

PDS records and Redis cannot participate in one transaction. The command checks
source state before enqueue, the worker checks again under its site write lock,
and the command checks once more after completion. A PDS can still publish a new
record after the final read; normal firehose reconciliation owns that update.

Consumer activity and a short-lived capability are fail-closed operational
checks, not a distributed rollout lock. Stop all old worker binaries first.
Historical quarantine fences without a generation marker remain supported;
new quarantines from this worker always create a marker. Do not run an older
worker that can replace a fence without updating that marker.
