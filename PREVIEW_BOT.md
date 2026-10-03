# Preview Bot (`apps/preview-bot`)

A small HTTP service that receives preview notification requests from CI workflows and posts authoritative preview links as comments on Tangled pull requests using the `@wisp.place` brand account.

## Motivation & Threat Model

Anyone running CI can deploy a static site to their own PDS with an arbitrary rkey (like `pr-<sha7>`).
However, we cannot allow an attacker to:
1. Trick our official bot into commenting phishing or malicious links onto a pull request.
2. Claim an arbitrary pull request and post previews for it.
3. Waste bot resources or spam ATProto repositories.

To solve this, `preview-bot` verifies every link against independent authorities before writing any comment.

## Verification Chain

When a request arrives at `POST /v1/preview` with `{ owner, repo, pipeline, claim }`:

1. **Owner's Repo Record** (`owner`'s PDS):
   - Reads `sh.tangled.repo` records for `owner`.
   - Finds the record where `name == repo`.
   - Confirms the record has an assigned `repoDid` and a configured `spindle` host.
2. **Spindle CI Pipeline** (`spindle` host):
   - Queries `sh.tangled.ci.getPipeline?pipeline=<pipeline>`.
   - Confirms the pipeline was triggered by a pull request (`sh.tangled.ci.trigger#pullRequest`).
   - Ensures the pipeline ran against the exact repository (`pipeline.repo == repo.repoDid`).
   - Rejects fork-based runs (`sourceRepo != repo`).
   - Extracts the authoritative pull record URI and the 40-character `sourceSha`.
3. **Pull Record** (Author's PDS):
   - Fetches the `sh.tangled.repo.pull` record by AT-URI.
   - Confirms the pull's target repository matches (`pull.target.repo == repo.repoDid`).
   - Extracts the latest round index.
4. **Wisp Subdomain Claim** (Postgres DB):
   - Checks that `claim.<baseHost>` is owned by the repository maintainer (`owner`).
5. **Live Preview Probing**:
   - Constructs `https://pr-<sha7>-<claim>.<previewHost>/`.
   - Makes an HTTP request to verify the preview actually serves `200 OK`.

Only if **all** five links hold does the bot post or update a comment.

## Comment Management

- The bot maintains a single comment per pull request (`sh.tangled.feed.comment`).
- If an existing bot comment is found for the pull request URI, it updates (`putRecord`) the existing comment, placing the newest commit preview at the top of the Markdown table.
- Up to 10 historical preview rounds are retained in the table.
- Requests with the same commit SHA return `200 OK` (`status: unchanged`) idempotently.
