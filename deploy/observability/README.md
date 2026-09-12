# durable wisp observability

## source of truth and ownership

komodo owns application topology, compose paths and stack environments. releases
only change `WISP_TAG`. the production compose files already carry explicit
`GRAFANA_LOKI_URL` and `GRAFANA_LOKI_PATH`; a native release preserves them.
`app-logging.compose.yaml` records the main-app settings restored on us-west and
singapore. it is a recovery template, not an automatically loaded file; it leaves
hosting/firehose public HTTPS settings unchanged. do not add it to an unverified
stack or redeploy apps to apply it.

existing `scripts/monitoring/` and `docs/operations/self-hosted-monitoring.md`
belong to the earlier gatus deployment. this directory extends that deployment
without replacing its files, discord contact or original 24 checks.

| host | existing app compose files |
| --- | --- |
| us-west, eu | `/root/docker/docker-compose.yml`, `docker-compose.observability.yml` |
| us-east | `/home/regent/docker/docker-compose.yml`, `docker-compose.observability.yml`, `docker-compose.baal.yml` |
| singapore | `/home/regent/docker/docker-compose.yml` |

verify actual komodo `GetStack.config.file_paths` and env file before using these
paths. render with the stack's exact files/environment, then pipe directly into
`verify-logging.py`. never print expanded compose, container environments or
secrets. the guard accepts the existing public or private log URL and requires
`/insert/loki/api/v1/push`; it prints only failing service/key names.

```sh
docker compose --env-file komodo.env -f docker-compose.yml -f docker-compose.observability.yml config --format json | python3 verify-logging.py
```

if a host loses logging, back up its compose first. restore only the two log
settings for the existing services, or append the supplied overlay to the verified
komodo `file_paths` with a read-modify-write. preserve all existing files and stack
environment. render and compare without exposing values. applying source does not
require recreating an app; coordinate activation with its next approved rollout.

## restored monitoring stack

`compose.yaml` and `grafana/provisioning/` are snapshots of the existing valefar
stack at `/home/regent/docker/observability`. images remain pinned by their
existing digests; no new services, images or packages were introduced. named
volumes preserve the existing metrics, logs and grafana state. keep the existing
private `.env` and dashboards directory; these are not replaced by this snapshot.

on 2026-09-12, victoria-metrics and grafana had empty docker network membership
while their localhost health checks passed. only these two services were recreated
with `--no-deps --force-recreate`, restoring the existing compose network. victoria
logs was not recreated. backup:
`/home/regent/docker/observability/backup-network-restore-20260912T050458Z`.

- logs: `http://100.64.0.20:9428`, 30-day retention, maximum disk usage 80%.
- metrics: `http://100.64.0.20:8428`, 90-day retention.
- grafana: `http://100.64.0.20:3030`, existing admin auth, anonymous access off.
- public log route: `logs.Caddyfile`, merged into baal's existing
  `/home/regent/docker/Caddyfile`. do not replace the whole Caddyfile.

ports are tailscale-bound. metrics and grafana have no audited public DNS route;
do not expose them to satisfy a public health check. the public logs HTTPS route
is existing behavior, not new authentication or access control. logs can contain
private operational data; access control is a separate unresolved concern.

## focused alert rules

`probe.py` runs once per minute on each app host. stolas also runs the central
log check against valefar over tailscale. valefar uses immutable nixos systemd
configuration; no probe unit or nix rebuild was added there. the probe uses
python's standard library, docker and existing redis-cli in stolas's redis container. no application code or image is changed.

| gatus endpoint | signal and threshold |
| --- | --- |
| each region / database-replica | main `/api/health`: configured `database.readEndpoint`, mode `healthy`, no primary fallback, probe age <5 minutes; up to 30 seconds of clock skew allowed |
| each region / log-exporter | all three containers running with log URL/path, fewer than 3 exporter errors in the last 5 minutes (bounded to last 2000 docker log lines, including stderr) |
| operations / ingestion | only acquired leader reports: ready, connected, last firehose event <5 minutes, consecutive failures <5; standby withholds updates |
| operations / revalidation | oldest pending <30 minutes; pending+consumer lag >=100 must persist 15 minutes; new DLQ entry marks unhealthy for 10 minutes |
| operations / log-ingestion | any main/hosting/firehose log ingested within 30 minutes, using VictoriaLogs `/select/logsql/query` |

all failing predicates require 3 continuous minutes before pushing `success=false`.
gatus alerts through the **existing discord contact** after 1 failed push and
recovers after 2 successful pushes. missing heartbeats fail after 4 minutes,
including a stopped timer or unreachable central logging host. no body, site id,
record, redis URL, credential or log line is sent to gatus; only booleans.

replication lag and receiver safety use the app's existing assessment; quiet,
caught-up replicas do not fail because their last replayed transaction is old.
main logs are sparse (DNS verification can take 10 minutes); no per-instance
silence alert is installed. the global 30-minute log check cannot detect one
silent app while another app logs. exporter failures cover some, not all, of
that gap. metrics are not invented for revalidation: redis `EVAL_RO` reads
`XINFO GROUPS`, `XPENDING`, and DLQ `XINFO STREAM`. source stream, group, database
and credentials come from the current firehose container environment. sampling
runs once on stolas, even while its local firehose is standby.

historical DLQ entries establish a baseline, not an incident. new
`last-generated-id` advancement detects growth even when stream trimming keeps
length flat. this is **new quarantine activity**, not an exact count of quarantine
fence keys. state older than 5 minutes establishes a fresh baseline after downtime;
entries added during that unobserved interval do not page retroactively. pending
age means message age, not idle time. production claim idle is configured to
1 hour, so the 30-minute threshold is an early operator stall warning, not proof
of a worker defect. it never replays, claims, acknowledges or deletes work.
standby nodes never publish false shared ingestion checks on probe errors.

## install and recover

1. back up gatus config/secrets and existing probe files with root-only permissions.
2. run `gatus-overlay.py` against the actual existing JSON-format gatus config.
   it appends exactly 11 endpoints, preserves the old checks/contact, and refuses
   duplicate operational names. generate one independent token per endpoint;
   only operations/ingestion is shared across app hosts.
3. add `OPS_*_TOKEN` variables to the existing private gatus `secrets.env`. distribute
   only scoped destinations to each host's `/etc/wisp-operations/config.json`
   (directory 0700, file 0600). never write secrets into this repository.
4. install `probe.py` to `/usr/local/lib/wisp-operations/probe.py` and the two units
   under `/etc/systemd/system`. create `/var/lib/wisp-operations` mode 0700.
5. validate private samples before enabling alerts. recreate only gatus, start
   probes and verify all 35 checks. leave existing wisp-status units unchanged.

fleet config shape (replace scoped tokens privately):

```json
{
  "apps": {"main": "wisp-place", "hosting": "wisp-hosting-service", "firehose": "wisp-firehose-service"},
  "destinations": {
    "database": {"url": "https://status.wisp.place/api/v1/endpoints/us-west_database-replica/external", "token": "REPLACE"},
    "exporter": {"url": "https://status.wisp.place/api/v1/endpoints/us-west_log-exporter/external", "token": "REPLACE"},
    "ingestion": {"url": "https://status.wisp.place/api/v1/endpoints/operations_ingestion/external", "token": "REPLACE"}
  }
}
```

stolas additionally sets `redis_container: "wisp-redis-replica"` and a `queue`
destination for `operations_revalidation`. stolas also sets
`logs_url: "http://100.64.0.20:9428"` and a `logs` destination for
`operations_log-ingestion`. default network is `proxy_network`.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now wisp-operations.timer
sudo systemctl start wisp-operations.service
sudo journalctl -u wisp-operations.service -n 20 --no-pager
```

rollback: remove only the 11 operational endpoints from gatus and recreate it,
then disable the new timers. preserve the original 24 endpoints and wisp-status
units. keep state/config backups. stopping a timer without removing its heartbeat
correctly alerts. the existing status host remains a single failure domain; its
own outage cannot deliver discord notifications.

## activation evidence (2026-09-12)

- gatus config/secrets/compose backup:
  `/opt/wisp-status/backup-operations-20260912T051258Z`.
- host probe backups: `/var/backups/wisp-operations/20260912T051258Z`
  (singapore ends `051259Z`; stolas central log config backup ends `051324Z`).
- all four installed units exited 0. all 35 gatus endpoints reported healthy,
  including the original 24. runtime sampling found singapore as acquired leader;
  the other three nodes correctly withheld the shared ingestion heartbeat.
- one explicitly labeled direct discord delivery test returned HTTP 204. this
  verifies the existing webhook transport, not an induced production outage.
  no production endpoint was deliberately marked failed.
- public logs HTTPS health and remote tailscale metrics/grafana health returned
  HTTP 200 from baal. both authenticated grafana datasource health checks returned
  HTTP 200 / OK. no public metrics/grafana route was found or added.
- each existing host Compose render passed `verify-logging.py`. no app container,
  image, compose environment or komodo stack setting changed in this task.

## offline checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/observability -p 'test_*.py' -v
bun check
```

biome does not process these python/yaml/markdown files under the current repo
configuration; the targeted biome invocation reports no files processed.

mock tests cover alert windows, historical/new DLQ behavior, active/standby policy,
replica fallback, missing data, credential transport, stderr exporter failures,
logging drift and preservation of existing gatus checks. read-only live sampling
must precede activation; one isolated, explicitly labeled discord delivery test
may be used without marking a production endpoint down.
