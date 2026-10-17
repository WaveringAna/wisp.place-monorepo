# Moderation service

`apps/labeler` is wisp.place's moderation service at `moderation.wisp.place`: the
atproto labeler (signed label log, `subscribeLabels`, `queryLabels`) plus the queue
and interface a moderator works in. It replaces the `wisp-patrol` scratch page.

## What it does

1. **Tracks every published site.** Every 30 s it reads `site_cache` rows updated
   since its last pass (the firehose service writes a row once a site version is
   cached, so the site is servable by then) and upserts a subject per site, with its
   wisp subdomains and verified custom domains. No jetstream connection and no
   per-request scanning: opening the page reads only moderation tables.
2. **First pass by a local model.** A worker takes subjects in state `pending`,
   fetches the page once (512 KiB cap) for its title, outbound hosts and first
   3000 characters of text, and asks bonsai (llama.cpp OpenAI API on valefar,
   `TRIAGE_URL`, over the wisp mesh) for `{flag, category, reason, confidence}`.
   Result: `flagged` or `clear`. Pages that do not answer 200 are retried a few
   times, then marked `clear` with the status as the reason. The model never labels.
3. **A moderator decides.** Verdicts (fine / empty / mass-created / spam) are
   private notes on a site or a whole account. Takedowns and hides are labels
   (`!takedown`, `!hide`, negated to restore), signed into the label log and obeyed
   by hosting within ~10 s.
4. **Everything is logged** in `moderation_events`: seen, triaged, verdict, label,
   with the actor (moderator DID, `model:<name>`, `system`).

## Data (postgres, schema in @wispplace/database)

- `moderation_sites`: one row per site record (`uri` = at://did/place.wisp.fs/rkey),
  with handle, url, domains, title, excerpt, outbound, files, first_seen, updated
  (site version), deleted, state, triage (jsonb), triage_attempts.
- `moderation_verdicts`: one row per subject (site URI or account DID): verdict,
  note, by, at. A site's effective verdict is its own, else its account's.
- `moderation_events`: append-only audit log.
- `moderation_cursor`: the `site_cache.updated_at` high-water mark.
- `moderation_oauth_states`, `moderation_oauth_sessions`, `moderation_logins`:
  sign-in state.

## Interface and API

React app served by the same Bun server at `/`. Sign-in is atproto OAuth (public
client, scope `atproto`, used only to learn the DID; tokens are revoked at once);
`MODERATOR_DIDS` lists who may enter. The login is a 7-day HttpOnly, Secure,
SameSite=Lax cookie. Writes must be JSON.

| route | |
| --- | --- |
| `GET /api/me` | `Me`, or 401 |
| `GET /api/queue?view=flagged\|pending\|recent\|reviewed&cursor=&limit=` | `QueueResponse` |
| `GET /api/account/:did` | `AccountView`: verdict, labels, all sites, recent events |
| `GET /api/search?q=` | `{ items: SiteSummary[] }` by handle, domain, DID or title |
| `GET /api/events?cursor=` | `{ items: ModerationEvent[], cursor }` |
| `POST /api/verdict` | `VerdictRequest` -> `{ site: SiteSummary \| null }` |
| `POST /api/label` | `LabelRequest` -> `{ labels: ActiveLabel[] }` (moderators only) |

Types are in `src/moderation/types.ts`. A bearer token (`MODERATION_API_TOKEN`)
may read and record verdicts, for the daily briefing; it can never label.

Queue views: `flagged` is flagged, unreviewed and not taken down; `pending` is not
yet triaged; `recent` is everything by publish time; `reviewed` has a verdict.
