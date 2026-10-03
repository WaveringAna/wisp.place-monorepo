# Content-addressed site storage (CAS)

Status: implemented; the migration and deploy have not been run. Decisions from Ana: global scope, additive `file_objects` column (no change to
`file_cids`), refcount GC with a grace period, and a hard cutover: no legacy reads in the new code. Existing
S3 data is migrated by a one-shot script before the deploy (see Migration).

## Why

Site files are stored at `{did}/{rkey}/{path}`. A new `(did, rkey)` has an empty ledger, so the
cache-writer downloads every blob from the PDS and writes every file to S3 again, even when the same
blob is already stored under another rkey. Preview deploys (one rkey per PR round) make that the
common case. Content addressing stores each distinct body once and lets the writer skip the PDS fetch.

## What the stored object is a function of

The stored body is not a function of the blob CID alone. `normalizeBlobContent` / `measureBlobContent`
in `firehose-service/src/lib/cache-writer.ts` derive it from the blob bytes plus the manifest's
`base64`, `encoding` and `mimeType` (base64-decoded or not, gzip kept or decompressed, by mime class).
Object metadata carries `mimeType`, `encoding`, `base64`, `uncompressedSize`, `sourceCid`, `sourceDid`.
So the key is derived from `(sourceCid, variant)` where `variant` = hash of the three manifest flags.

## Key

    cas/{sourceCid}.{variant}{.ext}

- `variant`: first 8 hex of sha256 over the canonical string `mimeType\0encoding\0base64` (version-prefixed).
- `.ext`: the lowercased extension of the manifest path, kept only so the tiered-storage placement rules
  (`**/*.{css,js}`, media extensions) keep matching. `index.html` is name-based, so hosting has a
  `cas/*.{html,htm}` rule that gives HTML bodies the placement `index.html` always had.
- Same bytes at two paths with different extensions are different objects. That is acceptable.
- Bodies are immutable: the key contains the CID, which the writer verified when it downloaded the blob
  (`blob-integrity.ts`). A site update never needs to evict a CAS body.

## Data model

- `site_cache.file_objects jsonb NULL`: `path -> casKey`. Additive. `NULL` means nothing is mapped yet (a
  tombstone, or a site the migration has not reached). `file_cids` is unchanged and stays the source of truth
  for the manifest CID per path (revalidation, audits, hosting's source-CID checks).
- `cas_objects(key text primary key, refs integer not null, size bigint, created_at, unreferenced_at)`:
  one row per stored body. `refs` counts the sites that reference it (once per site); `unreferenced_at` is
  set whenever `refs` is 0, including at registration.
- `.rewritten/{path}` HTML stays per site at `{did}/{rkey}/.rewritten/{path}` (it embeds the path
  prefix). It is not in `cas_objects`; site deletion and the existing prefix delete remove it.

## Write path (firehose-service)

1. Each file's key is `casKey(cid, path, mimeType, encoding, base64)`, from the manifest alone.
2. Each file is probed once at its key (S3 HEAD). A body with trustworthy accounting metadata is reused,
   whoever stored it. Anything else is fetched from the PDS. Forced updates (verified repair, cold tier not
   synced) refetch everything.
3. Reused bodies nothing references yet are touched (their GC clock restarts) and the writer is told which
   still have a row. A key whose row is gone was collected after the probe; that file is fetched again.
4. A reused HTML body still needs this site's `.rewritten/` copy (it embeds the path prefix). It is rebuilt
   from the stored body, with no PDS call; if the body cannot be read, the file falls back to a download.
5. A fetched body is **registered first, then written**. The row exists, with a fresh clock, before the
   object does, so the collector cannot delete it between the write and the site's commit.
6. In one transaction with `upsertSiteCache`: set `file_objects`, and apply the refcount diff between the
   previous mapping and the new one (+1 added, -1 removed).
7. Only per-site `.rewritten/` keys of removed paths are deleted. Shared bodies are never deleted here.
8. Site delete removes the site's prefix and writes the tombstone, which releases the references.
9. Quota accounting (`SiteLogicalSizeBudget`) stays per site on logical sizes from metadata, so shared
   storage does not change what a site is charged.

Two paths in one upload with identical content are each fetched; the second write is idempotent.

## Read path (hosting-service)

- A path's body is read from `file_objects[path]`. A manifest path with no mapping has no stored body:
  that is a miss (503 and a revalidate request), never a read of `{did}/{rkey}/{path}`.
- `.rewritten/{path}` HTML is the one exception and stays at `{did}/{rkey}/.rewritten/{path}`.
- A `file_objects` value that is not a well-formed CAS key voids the whole mapping, so a read can never
  be steered at an arbitrary storage key.
- Source-CID verification keeps working (`sourceCid` metadata is still recorded); for CAS keys it is true
  by construction, so the mismatch/eviction machinery is simply never triggered.
- Cache invalidation by `{did}/{rkey}/` prefix still evicts rewritten entries. CAS bodies are immutable and
  are never evicted on site updates.
- Directory listings come from manifest paths only; there is no stored-key listing fallback.

## GC

Leader-only, started and stopped with the revalidation worker (`src/lib/cas-gc-job.ts`). Safe if two
collectors ever overlap: they only contend on row locks.

**Collection** (hourly, bounded passes): an object is collectable when `refs = 0` and it has been
unreferenced longer than the grace period. For each candidate, in a transaction: lock the row with
`FOR UPDATE SKIP LOCKED` re-checking `refs` and the clock, delete the object from storage, delete the row.
A failed storage delete rolls the row back and a later pass retries. A row a writer holds is skipped. Passes
repeat only while each deletes a full batch, so skipped or failing rows cannot spin the job.

Why this is safe against a site update in flight: writers register before writing and touch what they reuse,
so any row an update depends on has a fresh clock and the collector's re-check under lock skips it. If the
collector already holds the row, the update waits, then sees the row gone (`touchCasObjects` answers with the
keys that still exist) and fetches the body again.

**Reconcile** (daily, bounded passes): recompute each key's count from `site_cache.file_objects` in one
repeatable-read snapshot, and repair mismatches (a count too high or low, a missing row, an unreferenced row
that still counts). A repair applies only if the count is still what the snapshot saw, so it never undoes a
concurrent update. Cost is one pass over every site's mapping, so it runs rarely.

Configuration (all bounded; an invalid value falls back to the default):

| variable | default | bounds |
|---|---|---|
| `CAS_GC_GRACE_SECONDS` | 86400 | 3600 to 30 days |
| `CAS_GC_INTERVAL_MS` | 3600000 | 1 minute to 1 day |
| `CAS_GC_RECONCILE_INTERVAL_MS` | 86400000 | 1 hour to 7 days |
| `CAS_GC_BATCH` | 500 | 10 to 5000 |

The grace period must outlast the longest site update; the one-hour floor is there so a typo cannot make
collection race live updates. Objects in storage that have no row are not deleted automatically; the S3
audit reports content-addressed objects whose recorded identity disagrees with their key.

Hosting needs no eviction when an object is collected: nothing references it, so nothing asks for it.

## Migration

No legacy reads and no feature flag in the new code. Existing data is converted first, while the old code
keeps serving, and the old objects are deleted last. The tool is `firehose-service/scripts/migrate-to-cas.ts`
(logic in `src/lib/cas-migration.ts`); delete both once every site is converted.

1. **`--mode dry-run`**: classify every file and report what would happen. Changes nothing. Run this first
   and read the skip counts.
2. **`--mode migrate --yes`**: for each live site, copy each legacy object to its CAS key inside S3 (S3
   `CopyObject`, fenced on the source ETag, metadata replaced because it embeds the object's own key),
   register the object, then store the site's mapping and references in one transaction. Old code ignores
   `file_objects`, so nothing changes for users. A site updated during the run is reported `stale`; run it a
   second time with the firehose briefly paused (it replays from its cursor). The commit refuses a site
   whose file CIDs changed since the scan, and never overwrites a mapping the cache writer produced.
3. **Deploy** firehose and hosting together. Old objects are still present, so rolling back to the old code
   works.
4. **`--mode delete-legacy --yes`**: after verifying, remove `{did}/{rkey}/{path}` objects of sites whose
   mapping is complete and whose CAS objects all exist (never `.rewritten/`, never `cas/`).

### What the migrator will and will not convert

The new writer derives a body's key from the manifest's `mimeType`, `encoding` and `base64`. Legacy objects
only record what was stored, so the manifest's encoding is recovered from that, only where unambiguous:

- stored gzip: the type stays compressed (the writer stores gzip for nothing else) and the manifest said
  gzip. A manifest that left the encoding out of gzip bytes would store the same object under a key without
  it; that costs one repull on the site's next update, never wrong content.
- stored identity under a type that stays compressed: the manifest had no encoding.
- stored identity under any other type (images, fonts, `_redirects`): the manifest had no encoding, or said
  gzip and the writer decompressed it. These differ in their bytes, so the stored bytes are hashed; the file
  is converted only if they are the blob itself.

Everything else is skipped and repulled from the PDS, which is the source of truth: objects with no
`sourceCid` (written before source CIDs were recorded), a `sourceCid` that is not the manifest's, missing or
malformed accounting metadata, and files the writer decompressed. Skipped paths are left unmapped: hosting
answers 503 and requests repair for exactly those paths.

`cache-writer.cas.test.ts` pins the classifier to the real writer: for each kind of file the writer
produces, inverting its metadata lands on the writer's own key or declines.

Hosting's warm and hot caches are keyed by the old paths, so they start cold after the deploy.

## Security and policy

- Global dedupe means one body is shared across accounts. Integrity holds (key = verified CID).
- `sourceDid` is no longer a per-object binding. `audit-s3-source-cids` and `audit-warm-source-cids`
  check CAS objects against their own key (the recorded `sourceCid` must be the key's CID), with no PDS read.
- A manifest can name a CID that another account uploaded. A compliant PDS only lets a record
  reference its own repo's blobs; a hostile PDS gets only public bytes it could have served anyway.
- Takedown by CID becomes one object delete; add it to moderation tooling later.
- Private sites use a separate bucket and are out of scope.

## Tests that pin the design

1. Two rkeys, one did, same files: the second update performs zero PDS blob fetches and zero body writes
   (`cache-writer.cas.test.ts`). The same holds across accounts.
2. Same blob CID, two manifests with different mime/base64/encoding: two objects, each served with its own
   Content-Type and body.
3. GC keeps an object any site references, one younger than the grace period, one re-referenced after
   selection, one a writer touched or re-registered after selection, and one another transaction holds
   (`cas-gc.pg.test.ts`, real Postgres). Reconcile never overwrites a count that changed after its snapshot.
4. A reused body collected between the probe and the commit is fetched again; a new body is registered
   before it is written.
5. A mapping that points outside CAS, or does not parse, is never read (`file-serving.cas.test.ts`).
6. The migrator's classifier lands on the writer's own key for every kind of file the writer produces, or
   declines (`cache-writer.cas.test.ts`); the S3 copy is exercised against a real backend
   (`cas-migration.s3.test.ts`).

Tests that need infrastructure are gated and skip without it: `WISP_TEST_DATABASE_URL` for the Postgres
suites and `WISP_TEST_S3_BUCKET` (+ endpoint and credentials) for the S3 one.

## Slices

1. Shared key/variant module + tests (pure). Done.
2. DB schema (`file_objects`, `cas_objects`), refcount logic, hosting CAS-only reads. Done.
3. Cache-writer CAS writes + refcounts (no flag, no legacy write path). Done.
4. One-shot S3/DB migrator. Done (`scripts/migrate-to-cas.ts`).
5. GC sweeper + reconcile. Done.
6. Audit scripts, placement rules, docs. Done.
