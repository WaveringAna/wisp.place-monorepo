---
title: Preview Deploys for Pull Requests
description: Deploy every pull request to its own preview URL from a Tangled spindle workflow, and clean the previews up again
---

A preview deploy publishes a pull request's build as a site in **your own PDS**, under its own origin, so reviewers can open it before you merge. Nothing is shared with anyone else's account: the site record lives in the repo of the person who runs the workflow.

## How it fits together

- Each pull request round deploys a site named `pr-<sha7>`, where `<sha7>` is the first seven characters of the pull request's head commit.
- The hosting service serves it at `https://pr-<sha7>-<claim>.<preview host>/`. `<claim>` is a wisp subdomain you already claimed (the `alice` in `alice.wisp.place`). Without the claim, nothing in the host would say whose site it is, and anyone could write the same site name into their own repo and answer for someone else's commit.
- The preview host is a separate registrable domain from the one that serves production sites, so a preview's JavaScript cannot read the cookies or storage of any production site. Operators enable it by setting `PREVIEW_HOST` on the hosting service. It has no default, and unset means previews are off.
- Every preview carries `X-Robots-Tag: noindex`, set through the site's settings record.

Because each round is a new commit, each round gets its own URL. Earlier rounds stay up, so you can compare them, until they are pruned.

## One-time setup

1. Claim a wisp subdomain for the account that will own the previews.
2. Create an app password for that account. Use a dedicated one and never your main login.
3. In the repository's settings on Tangled, add it as a secret named `WISP_APP_PASSWORD`.

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
  PREVIEW_HOST: "your-preview-host.example"

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
      npm install --global wispctl
      sha7="${TANGLED_COMMIT_SHA:0:7}"
      wispctl deploy "$WISP_HANDLE" \
        --password "$WISP_APP_PASSWORD" \
        --path ./dist \
        --site "pr-$sha7" \
        --header "X-Robots-Tag: noindex" \
        --preview-host "$PREVIEW_HOST" \
        --yes

      # Notify preview-bot to verify and post/update the PR comment
      pipeline_id="${TANGLED_PIPELINE_ID##*/}"
      claim="${PREVIEW_CLAIM:-${WISP_HANDLE%%.*}}"
      curl -s -f -X POST "${PREVIEW_BOT_URL:-https://preview-bot.wisp.place}/v1/preview" \
        -H "Content-Type: application/json" \
        -d "{\"owner\":\"$TANGLED_REPO_DID\",\"repo\":\"$TANGLED_REPO_NAME\",\"pipeline\":\"$pipeline_id\",\"claim\":\"$claim\"}"
```

`--preview-host` makes `wispctl` check that the site is named `pr-<sha7>` before it uploads anything, then print the preview URL once the deploy succeeds. If you have claimed more than one wisp subdomain, add `--preview-claim <label>` to choose one.

Replace the build commands and `./dist` with your own.

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
      npm install --global wispctl
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
