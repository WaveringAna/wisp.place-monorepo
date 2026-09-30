# sjo1 Bun 1.4.2 canary

Scope: only the three application containers in Komodo stack `sjo1-wisp-apps`.
Postgres, Redis, HAProxy, Caddy, Netdata, and the other regions are unchanged.
Source branch: `canary/bun-1.4.2-sjo1`; Git tag: `canary-bun-1.4.2-sjo1-20260930`.
Image tag: `1.1.12-bun1.4.2-sjo1-20260930`, under the existing `atcr.io/nekomimi.pet/wisp-*` image names.
Rollback tag: `1.1.12`. Do not remove those images during the observation window.

## Changes and evidence

- Server and e2e build images, plus root development Bun binaries, use Bun 1.4.2.
  Production executables embed the build-time runtime; swapping a host Bun install
  alone does not upgrade them. Runtime dependencies and cache settings are unchanged.
- HTML prewarm bookkeeping retains at most 1,000 completed sites. Identity fences
  replace the unbounded generation map and prevent stale work completing after reset.
- At most two background site prewarms can run, with no retained waiting queue.
  Resetting bookkeeping does not release a still-running task's admission slot.
  A skipped prewarm is only an optimization: normal file serving still works.

On 2026-09-30 before intervention, sjo1 had 848 MiB RAM, about 66 MiB available,
1.35 GiB swap used, memory full PSI around 40%, and load around 12 on one CPU.
Hosting alone had about 580 MiB RSS+swap. Restarting only hosting at 06:18 UTC
reduced zram physical usage from about 369 to 88 MiB and restored RAM headroom.
That restart is a confounder: initial low memory after the canary is not proof of
improvement. The bounded bookkeeping is a real code issue, but not evidence that
it explains all the original memory growth. Compare warm operation over 24 hours.

## Build and deploy safeguards

Use an isolated clean checkout based on deployed `v1.1.12`; do not ship unrelated
local observability edits. Build the three images on valefar, not the 1 GiB node,
using the existing builder and registry authentication. Use only `linux/amd64`
for this canary. Labels record the source commit and Bun version.

The ordinary `v*` tag workflow invokes a fleet-wide release. This tag deliberately
has no `v` prefix; **do not invoke `wisp-release`**. Do not overwrite stable or latest
image tags, change the shared Komodo build definitions, or deploy the other stacks.

Pull the three tagged images on sjo1, then update only `WISP_TAG` in the existing
`sjo1-wisp-apps` stack environment and deploy that stack. Keep its existing compose
files and secret env sources. Verify image IDs, container health, main
`/api/health`, hosting `/health`, and Patroni streaming state. Probe private
container IPs rather than the mesh hostname through Caddy (host-header/TLS routing
is different). Keep the existing Docker init layout on firehose.

## Observation

Run `scripts/monitoring/bun-canary.py` on sjo1 every five minutes for 24 hours.
It reads exactly the three containers via Docker's private Unix socket and pushes
small samples to private VictoriaMetrics. It does not print environment values,
logs, or credentials. Process RSS/swap describes namespace PID 1; for firehose's
supervised workers use the aggregate cgroup memory/swap metrics instead.

Useful PromQL:

- `bun_canary_cgroup_memory_current_bytes{host="sjo1"} / 1048576`
- `bun_canary_cgroup_swap_current_bytes{host="sjo1"} / 1048576`
- `bun_canary_restarts_total{host="sjo1"}`
- `bun_canary_healthy{host="sjo1"}`

Use the existing fleet Netdata series for available RAM, swap I/O, memory/I/O PSI,
and load. Missing samples are not healthy zeros. Investigate repeated unhealthy
containers, increasing restarts, sustained memory full PSI >20%, or RAM headroom
below 64 MiB. No automatic fleet promotion or rollback is performed by the collector.
A day-end check must stop the sampling timer and review memory trend, restarts,
service errors and database/Redis health before deciding on any wider rollout.

## Rollback

Restore only the stack's `WISP_TAG=1.1.12`, preserving every other environment key,
and redeploy `sjo1-wisp-apps`. Recheck direct app health and replication. Stop the
canary sampling timer if abandoning the experiment. This returns the old runtime
and prewarm behavior, so host memory pressure may recur; it does not solve node capacity.
