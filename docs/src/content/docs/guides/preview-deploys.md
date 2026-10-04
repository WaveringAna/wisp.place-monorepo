---
title: Preview Deploys for Pull Requests
description: Deploy every pull request to its own preview URL from a Tangled spindle workflow, and clean the previews up again
---

A preview deploy publishes a pull request's build as a site in **your own PDS**, under its own origin, so reviewers can open it before you merge. Nothing is shared with anyone else's account: the site record lives in the repo of the person who runs the workflow.

## How it fits together

- Each pull request round deploys a site named `pr-<sha7>`, where `<sha7>` is the first seven characters of the pull request's head commit.
- The hosting service serves it at `https://pr-<sha7>-<claim>.<preview host>/`. `<claim>` is a wisp subdomain you already claimed (the `alice` in `alice.wisp.place`). Without the claim, nothing in the host would say whose site it is, and anyone could write the same site name into their own repo and answer for someone else's commit.
- Preview URLs use `pr-<sha7>-<claim>.preview.wisp.place`. Operators set `PREVIEW_HOST=preview.wisp.place` on both the hosting service and main app, with DNS for `*.preview.wisp.place`. Caddy uses the existing on-demand TLS permission endpoint; valid preview names are authorized through the owner's registered wisp claim, just like ordinary wisp subdomains. The environment variable has no default; unset means previews are off. These are separate origins, not a separate registrable domain: cookies scoped to `.wisp.place` can also reach preview hosts.
- Every preview carries `X-Robots-Tag: noindex`, set through the site's settings record.

Because each round is a new commit, each round gets its own URL. Earlier rounds stay up, so you can compare them, until they are pruned.

- After each deploy, the preview bot comments the link on the pull request. It is woken by a webhook in your PDS, not by the workflow, and checks the repository, pipeline, pull request, claim and URL itself before it writes anything.

## One-time setup

1. Claim a wisp subdomain for the account that will own the previews.
2. Create an app password for that account. Use a dedicated one and never your main login.
3. In the dashboard, open **cli & ci**, pick the repository under **pull-request previews**, choose the subdomain, paste the app password and turn previews on. The first time, wisp asks you to sign in again so it may store secrets on your spindle. It stores the app password there as `WISP_APP_PASSWORD` and creates the webhook that wakes the bot. To keep the password away from wisp entirely, add the secret in the repository's settings on Tangled yourself and turn previews on without one.
4. Copy the workflow the dashboard shows into `.tangled/workflows/preview.yml`. It is the one below, filled in for your repository.

Spindle never passes secrets to pipelines that run code from a fork, so a pull request from a fork builds but does not deploy. The workflow below skips the deploy step in that case.

## The workflow

Save as `.tangled/workflows/preview.yml` in the repository that holds your site's source:

```yaml
when:
  - event: ["pull_request"]
    branch: ["main"]

engine: microvm
image: nixos

dependencies:
  - nodejs
  - pnpm

environment:
  WISP_HANDLE: "alice.example.com"
  PREVIEW_HOST: "preview.wisp.place"
  PREVIEW_CLAIM: "alice"

steps:
  - name: build
    command: |
      pnpm install --frozen-lockfile
      pnpm build

  - name: deploy preview
    command: |
      set -euo pipefail
      if [ -z "${WISP_APP_PASSWORD:-}" ]; then
        echo "no deploy secret in this pipeline (pull request from a fork); skipping"
        exit 0
      fi
      npm install --global --prefix "$HOME/.local" wispctl@2.0.2
      export PATH="$HOME/.local/bin:$PATH"
      wispctl deploy "$WISP_HANDLE" \
        --password "$WISP_APP_PASSWORD" \
        --path ./dist \
        --sha "$TANGLED_COMMIT_SHA" \
        --header "X-Robots-Tag: noindex" \
        --preview-host "$PREVIEW_HOST" \
        --preview-claim "$PREVIEW_CLAIM" \
        --yes
```

`--sha` names the site `pr-<sha7>`, and `--preview-host` makes `wispctl` check that name before it uploads anything, then print the preview URL once the deploy succeeds. Set `PREVIEW_CLAIM` to your claimed wisp subdomain label; it is required when your account has more than one claim.

Replace the build commands and `./dist` with your own. The workflow pins `wispctl@2.0.2` and installs it under `$HOME/.local`, not into the read-only Nix store.

## How the comment is triggered

Turning a repository on creates one `place.wisp.v2.wh` record in your PDS:

```json
{
  "scope": { "aturi": "at://<your did>/place.wisp.fs" },
  "events": ["create", "update"],
  "url": "https://preview-bot.wisp.place/v1/hook?repo=<repository name>&claim=<subdomain>"
}
```

Every site write fires it; the bot ignores anything not named `pr-<sha7>`. Turning the repository off deletes the record. Earlier previews and the spindle secret stay where they are.

## Cleaning up

Previews are ordinary site records, so they accumulate until you remove them. Spindle runs workflows when a pull request is opened or updated, not when it closes, so there is no "on close" workflow. Sweep them on a schedule instead. Save as `.tangled/workflows/preview-prune.yml`:

```yaml
when:
  - event: schedule
    schedule:
      - cron: "H 3 * * *"

engine: microvm
image: nixos

dependencies:
  - nodejs

environment:
  WISP_HANDLE: "alice.example.com"

steps:
  - name: prune old previews
    command: |
      set -euo pipefail
      npm install --global --prefix "$HOME/.local" wispctl@2.0.2
      export PATH="$HOME/.local/bin:$PATH"
      wispctl site prune "$WISP_HANDLE" \
        --password "$WISP_APP_PASSWORD" \
        --prefix pr- \
        --older-than 7 \
        --yes
```

`site prune` only deletes sites whose name starts with `pr-` and that were last updated more than the given number of days ago. It refuses any other prefix, and `--older-than` is required, so it can never remove your production site. Add `--dry-run` to list what would go without deleting. Removing a site also removes its manifest, settings and split-manifest records, and the hosting service drops the cached files.

You can also remove specific previews by name:

```sh
wispctl site delete alice.example.com --site pr-ab12cd3 --site pr-9e0f451 --records
```

## Storage

On the hosting side, files are stored once per distinct content, so a round that changes a few files only stores those. On your side, `wispctl` reuses blobs from the existing record with the same site name, and every round has a new name, so each round uploads its files to your PDS again.
