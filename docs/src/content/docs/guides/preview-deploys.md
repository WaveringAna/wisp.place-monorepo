---
title: Preview Deploys for Pull Requests
description: Deploy every pull request to its own preview URL from a Tangled spindle workflow, and clean the previews up again
---

A preview deploy publishes a pull request's build as a site in **your own PDS**, under its own origin, so reviewers can open it before you merge. Nothing is shared with anyone else's account: the site record lives in the repo of the person who runs the workflow.

## How it fits together

- Each pull request round deploys a site named `pr-<sha7>`, where `<sha7>` is the first seven characters of the pull request's head commit.
- The hosting service serves it at `https://pr-<sha7>-<claim>.<preview host>/`. `<claim>` is a wisp subdomain you already claimed (the `alice` in `alice.wisp.place`). Without the claim, nothing in the host would say whose site it is, and anyone could write the same site name into their own repo and answer for someone else's commit.
- On wisp.place that is `pr-<sha7>-<claim>.preview.wisp.place`. These are separate origins, but not a separate registrable domain: cookies scoped to `.wisp.place` can also reach them.
- Every preview carries `X-Robots-Tag: noindex`, set through the site's settings record.

Because each round is a new commit, each round gets its own URL. Earlier rounds stay up, so you can compare them, until they are pruned.

## Setup

You need a claimed wisp subdomain (the `alice` in `alice.wisp.place`) and two things:

### 1. A webhook record in your PDS

This tells the preview bot about your deploys. Create a `place.wisp.v2.wh` record with record key `preview-<repo>`:

```json
{
  "$type": "place.wisp.v2.wh",
  "scope": { "aturi": "at://<your did>/place.wisp.fs" },
  "events": ["create", "update"],
  "url": "https://preview-bot.wisp.place/v1/hook?repo=<repo name>&claim=<subdomain>",
  "enabled": true,
  "createdAt": "2026-10-04T00:00:00.000Z"
}
```

The dashboard's **cli & ci** tab writes it when you turn previews on for a repo; any AT Protocol client can write it too (`com.atproto.repo.putRecord`). Every site write you make fires it, and the bot ignores anything not named `pr-<sha7>`. It needs no secret: the bot checks the repository, pipeline, pull request, claim and preview URL itself before it comments. Delete the record to turn previews off.

The claim has to belong to whoever deploys, and that account has to be the repo's owner or one of its collaborators on Tangled. For a repo you collaborate on, the record goes in your own PDS, the URL names the owner too (`...?repo=<repo name>&claim=<your subdomain>&owner=<owner did>`), and the record key is `preview-<repo>~<owner did>`, so it never replaces the hook for a repo of your own with the same name.

With the CLI: `wispctl preview enable <handle> --repo <repo name> --claim <subdomain>` and `wispctl preview disable <handle> --repo <repo name>`. As a collaborator, add `--owner <owner did>` to both.

### 2. The workflow on your spindle

- Add an app password for your account as the repo secret `WISP_APP_PASSWORD` in the repo's spindle settings on Tangled. Use a dedicated one, never your main login. (The dashboard can store it for you.)
- Commit the workflow below as `.tangled/workflows/preview.yml`.

That's it: open a pull request, and once the deploy finishes the bot comments the preview link. Each new round updates the same comment.

Spindle never passes secrets to pipelines that run code from a fork, so a pull request from a fork builds but does not deploy: `wispctl preview deploy` sees no `WISP_APP_PASSWORD` and skips.

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

steps:
  - name: build
    command: |
      pnpm install --frozen-lockfile
      pnpm build

  - name: deploy preview
    command: |
      npm install --global --prefix "$HOME/.local" wispctl@2.1.0
      export PATH="$HOME/.local/bin:$PATH"
      wispctl preview deploy --path ./dist
```

The workflow names no account, subdomain or host, so it is the same for every repo. `wispctl preview deploy` takes the rest from the pipeline and from your webhook record:

| | from |
| --- | --- |
| account | `TANGLED_REPO_DID`, the repo's owner, signing in with `WISP_APP_PASSWORD` |
| repo | `TANGLED_REPO_NAME` |
| site name | `pr-<sha7>` of `TANGLED_PR_SOURCE_SHA` (or `TANGLED_COMMIT_SHA`) |
| subdomain | the `claim` in the repo's `preview-<repo>` webhook record |
| preview host | `preview.wisp.place`, or `--preview-host` |

Changing the subdomain in the dashboard takes effect on the next deploy, with no change to the workflow. If the webhook record is missing, the deploy fails and says previews are not turned on for the repo. Every preview gets `X-Robots-Tag: noindex`; add `--spa` or `--header "Name: value"` for anything else the site needs.

As a collaborator, pass your own handle (`wispctl preview deploy <your handle> --path ./dist`), since the account would otherwise be the repo's owner.

Replace the build commands and `./dist` with your own. The workflow pins `wispctl@2.1.0` and installs it under `$HOME/.local`, not into the read-only Nix store.

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
      npm install --global --prefix "$HOME/.local" wispctl@2.1.0
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

