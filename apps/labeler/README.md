# labeler

See DESIGN.md for the moderation queue and interface.

The wisp.place moderation labeler, `moderation.wisp.place`. It signs
[atproto labels](https://atproto.com/specs/label) into an append-only log in the
wisp postgres database (`labeler_labels`) and publishes them:

- `com.atproto.label.subscribeLabels`: the signed label stream, replayable from any sequence number.
- `com.atproto.label.queryLabels`: the newest label per subject and value, negations included.
- `POST /admin/labels` (bearer `LABELER_ADMIN_TOKEN`): emit a label,
  `{ uri, val, neg?, cid?, exp?, note? }`. `note` is the moderator's reason and is stored, never published.

Subjects are account DIDs or site records (`at://<did>/place.wisp.fs/<site>`). The values it may emit are
`LABELER_VALUES`, by default `!takedown`, `!hide`, `spam` and `mass-created`. A label is reversed by emitting
the same one with `neg: true`.

The hosting service reloads the active `!takedown` labels from the same table every 10 seconds and answers
451 for a taken-down site, or for every site of a taken-down account (`apps/hosting-service/src/lib/moderation.ts`).

## Configuration

| variable | |
| --- | --- |
| `LABELER_DID` | the labeler account's DID |
| `LABELER_SIGNING_KEY` | hex secp256k1 private key; its `did:key` is the DID document's `#atproto_label` key |
| `LABELER_ADMIN_TOKEN` | bearer token for `POST /admin/labels`, at least 32 characters |
| `DATABASE_URL` | the wisp postgres primary |
| `LABELER_HOST`, `LABELER_PORT` | listen address, default `127.0.0.1:3010` |
| `LABELER_VALUES` | comma-separated label values it may emit |
| `MODERATION_PUBLIC_URL` | https origin of the moderation interface; unset turns the queue and interface off |
| `MODERATOR_DIDS` | comma-separated DIDs allowed to sign in |
| `MODERATION_API_TOKEN` | optional bearer token (≥ 32 characters) that may read the queue and record verdicts, never label |
| `TRIAGE_URL`, `TRIAGE_MODEL` | OpenAI-compatible llama.cpp server for the first pass, and its model (default `bonsai-2-27b`) |
| `MODERATION_SYNC_INTERVAL_MS` | how often site_cache is read for new sites (default 30000) |

Keep the log: consumers resume from sequence numbers, so it must never be truncated or renumbered.
