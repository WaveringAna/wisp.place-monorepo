# Tag-triggered releases

`git tag v1.2.3 && git push --tags` builds every image at version `1.2.3`,
rolls the fleet onto them, and verifies it actually moved. If anything
fails the CI pipeline goes red.

## How it flows

```
tag v1.2.3 pushed
  └─ .tangled/workflows/release.yml            (spindle, microvm)
       ├─ reject anything that is not vMAJOR.MINOR.PATCH
       ├─ reject if the commit has not reached the build mirror
       └─ POST /execute/RunAction  → Komodo
            └─ Action `wisp-release`           (deploy/komodo/wisp-release.ts)
                 ├─ find every build that clones this repo
                 ├─ pin each to 1.2.3 @ <sha>, build them one at a time
                 ├─ find every stack running one of those images
                 ├─ set WISP_TAG on each stack, deploy
                 └─ verify each service by tag, liveness and uptime
```

Spindle does not build. It gets a fresh overlay disk per run, so building
there means a cold build of everything on every tag, plus emulation for any
architecture the runner does not share. The build host already has the warm
cache and the emulation set up; CI just drives it.

## No topology in this repo, on purpose

Neither Action names a host, a directory, an env file or a service. They
ask Komodo:

- **builds** — every build whose configured source repo is `SOURCE_REPO`
- **images** — each build's registry, organization and image name
- **stacks** — every stack whose deployed services run one of those images
- **paths** — each stack's own run directory, compose files and env files

So adding a node, moving a service or renaming a stack needs no change
here. The only thing the pipeline is told is which repo it is releasing,
set once as `SOURCE_REPO` in the workflow.

The consequence worth knowing: **membership is defined by what is running.**
A stack joins the release the moment it runs one of our images, and leaves
when it stops. That is usually what you want, and it is worth a glance at
the Action's log — it prints every stack it selected — the first few times.

## Setting it up

1. **Repo secrets** on tangled (Settings → Secrets, *not* the workflow's
   `environment:` block, which is public to anyone who can read the repo):
   `KOMODO_ADDRESS`, `KOMODO_API_KEY`, `KOMODO_API_SECRET`.

   `KOMODO_ADDRESS` takes no trailing slash — the workflow appends
   `/execute/RunAction` and a double slash 404s.

2. **Create two Komodo Actions**, pasting the file contents from here:

   | Action | File |
   |---|---|
   | `wisp-release` | `deploy/komodo/wisp-release.ts` |
   | `wisp-prepare-tag` | `deploy/komodo/wisp-prepare-tag.ts` |

3. **Run `wisp-prepare-tag` once**, by hand, with
   `{"repo": "<SOURCE_REPO>"}`. It changes nothing without `apply` — it
   renders the edit beside the real compose files, diffs it, and discards
   the previews. Read that diff, then re-run with `{"apply": true}`.

   It rewrites the `image:` lines that point at our own registry so they
   read `${WISP_TAG}`, and seeds that variable at each stack's current tag
   so the first deploy is a no-op.

4. **Check the workflow timeout** on the spindle exceeds a full release.
   The stock default is 5 minutes, far too short — though the existing
   flake-check and test workflows already prove it is raised here.

5. **Cut a throwaway tag** and watch it. If nothing fires at all, the
   spindle may predate the `tag:` trigger field.

## Traps this is shaped around

**Registry tokens here are short lived and expire as 403, not 401.** Docker
only re-authenticates on a 401, so an expired token is fatal rather than
transparent. Builds run **sequentially** for this reason: parallel builds
contending for one builder stretch each login→push window past the token
lifetime. A push failure gets one retry against the now-warm cache, which
is the fix — not a config change. Builds configured to push many tags at
once (latest, commit, each semver level) spend longer in that window; fewer
tags is the cheapest way to shrink the risk.

**A successful deploy call is not evidence of a deploy.** Komodo has been
seen reporting success with only some of a stack's images actually pulled.
So the Action trusts none of its own return values and asks the containers:
right tag, running, and *recreated within the last 15 minutes*. A container
on the correct tag that was never restarted is precisely the failure mode.

**Image ids and digests are never compared across hosts.** A mixed-arch
fleet resolves the same multi-arch tag to a different per-arch manifest on
each host, so digest equality would fail on a perfectly healthy fleet.

**Releases never rewrite compose.** Compose files are hand-maintained and
carry per-host detail the release knows nothing about — including which
credential a given service reads through. The release moves one variable,
through the stack environment Komodo already owns. `wisp-prepare-tag` is
the only thing that ever edits compose, it runs once, and it gates on a
render diff.

**That render diff never prints values.** A rendered compose file contains
credentials. Comparing the render is what catches a service being wired to
the wrong one; printing it is what leaks one. Differences outside `image:`
lines are reported by key only, and abort.

**Komodo's execute calls do not wait, and their `success` field lies.** An
execute returns the Update in its initial state — `success: true,
status: InProgress` — before the work has begun. Gating on it makes a whole
release "succeed" in ten seconds having built and deployed nothing. Inside
an Action use the client's own `execute_and_poll`; from CI, capture the
update id and poll `read/GetUpdate` until `status: Complete`, which is what
the workflow does.

**The Action pulls before it deploys.** Compose would now do this itself
— the `pull_policy: never` lines that made it skip the fetch and then die
on a bare "No such image" were removed on 2026-09-02. The explicit pull
stays because it is the better failure mode: a registry or credential
problem surfaces as a registry error, on the host that has it, before
anything is torn down.

**Komodo's reported service image is rendered, not observed.** When it
renders without the stack's env file the tag interpolates to nothing and
comes back as `:0`, so a healthy service reads as a failed deploy.
Verification asks the container (`InspectStackContainer`) instead.

**Giving up on waiting is not cancelling.** If the poll loop hits its
deadline the release continues server-side. Treat it as *unknown* and read
the Update before re-running, because a blind retry redeploys.

**`TANGLED_SHA` on a tag push is the ref's sha, not the commit's.** For an
annotated tag (`git tag -a`) the ref is a tag object, so pinning a build to
it finds nothing and the mirror check 422s. The workflow resolves
`HEAD^{commit}` from the clone instead, which is right for annotated and
lightweight tags alike.

**Tag pushes do not run `test.yml`** — it triggers on `branch: [main]`, and
a tag push has no branch. Spindle has no cross-workflow `needs:`, so a tag
is assumed to point at a commit that already went green on main.

## Rollback

Not a new tag. Set `WISP_TAG` back on the affected stacks and redeploy —
the Action is idempotent, so re-running a previous version is safe. Every
compose file `wisp-prepare-tag` touches is backed up alongside it as
`<name>.bak-wisptag-<UTC stamp>`.

## Type-checking the Actions

`./deploy/typecheck.sh` checks both Actions against Komodo's real client
types. An Action is not a module — Komodo pastes its contents inside
`async function main()` and supplies the globals — so the script wraps each
file the same way before checking it, and `komodo-globals.d.ts` declares
what Komodo injects. Subtract 2 from a reported line to map it back.

The types under `komodo/vendor/` are fetched from a running Komodo and
committed so the check works offline:

```sh
for f in types lib responses terminal; do
  curl -sL "$KOMODO_ADDRESS/client/$f.d.ts" -o deploy/komodo/vendor/$f.d.ts
done
```

Re-fetch them after a Komodo upgrade. This is worth keeping honest: typing
these against the real client is what surfaced `execute_and_poll` (which
replaced a hand-rolled poller), an Update id read as `.id` when it is
`_id.$oid` (so every failure message printed `undefined`), and several
optional fields being read as if they were guaranteed.

## Open

- Sync the Actions via ResourceSync TOML so changes to these files land as
  PRs instead of a UI paste.
- Verification has no error-log gate. A bad release that starts cleanly and
  only then floods the logs still passes; a post-deploy scan belongs at the
  end of `wisp-release`.
