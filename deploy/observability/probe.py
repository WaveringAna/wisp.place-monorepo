#!/usr/bin/env python3
"""Read private operational signals; send only boolean results to Gatus."""

import datetime
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))


def request(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with HTTP.open(req, timeout=10) as response:
        if response.status != 200:
            raise ValueError("unexpected response")
        return response.read(2_000_000).decode()


def push(destination, success):
    url = destination["url"]
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc != "status.wisp.place"
            or not parsed.path.startswith("/api/v1/endpoints/")
            or not parsed.path.endswith("/external") or parsed.query or parsed.fragment):
        raise ValueError("invalid status destination")
    request(url + "?success=" + str(success).lower(), data=b"",
            headers={"Authorization": "Bearer " + destination["token"]})


def command(args, input=None, combined=False):
    return subprocess.check_output(args, input=input, timeout=15,
                                   stderr=subprocess.STDOUT if combined else subprocess.DEVNULL).decode(errors="replace")


def inspect(name):
    container = json.loads(command(["docker", "inspect", name]))[0]
    if not container["State"]["Running"]:
        raise ValueError("container stopped")
    return container


def health(container, port, path, network):
    address = container["NetworkSettings"]["Networks"][network]["IPAddress"]
    if not address:
        raise ValueError("container disconnected")
    return json.loads(request(f"http://{address}:{port}{path}"))


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("missing numeric signal")
    return value


def replica_ok(body, now):
    replica = body["database"]["readEndpoint"]
    checked = datetime.datetime.fromisoformat(replica["lastCheckedAt"].replace("Z", "+00:00")).timestamp()
    return (replica["configured"] is True and replica["mode"] == "healthy"
            and replica["usingPrimaryFallback"] is False and -30 <= now - checked < 300)


def ingestion_ok(body):
    # Standby silence is expected. Only the current leader updates the shared check.
    if body["leadership"]["state"] != "acquired":
        return None
    firehose = body["firehose"]
    return (body["leadership"]["state"] == "acquired" and body["ready"] is True
            and firehose["connected"] is True
            and number(firehose["timeSinceLastEvent"]) < 300_000
            and number(firehose["consecutiveFailures"]) < 5)


def exporter_ok(containers):
    for container in containers:
        env = dict(entry.split("=", 1) for entry in container["Config"]["Env"])
        if not env.get("GRAFANA_LOKI_URL") or env.get("GRAFANA_LOKI_PATH") != "/insert/loki/api/v1/push":
            return False
        logs = command(["docker", "logs", "--since", "5m", "--tail", "2000", container["Name"]], combined=True)
        if logs.count("[LokiExporter] Failed to send logs to Loki") >= 3:
            return False
    return True


QUEUE_SCRIPT = """
local groups = redis.call('XINFO', 'GROUPS', KEYS[1])
local group = nil
for _, item in ipairs(groups) do
  local fields = {}
  for i = 1, #item, 2 do fields[item[i]] = item[i + 1] end
  if fields.name == ARGV[1] then group = fields end
end
if not group then return redis.error_reply('missing consumer group') end
local pending = redis.call('XPENDING', KEYS[1], ARGV[1])
local dlq = '0-0'
if redis.call('EXISTS', KEYS[2]) == 1 then
  local info = redis.call('XINFO', 'STREAM', KEYS[2])
  for i = 1, #info, 2 do if info[i] == 'last-generated-id' then dlq = info[i + 1] end end
end
return cjson.encode({pending=pending[1], oldest=pending[2], lag=group.lag, dlq=dlq})
"""


def queue_snapshot(container, redis_container):
    env = dict(entry.split("=", 1) for entry in container["Config"]["Env"])
    url = urllib.parse.urlsplit(env["REDIS_URL"])
    if url.scheme not in ("redis", "rediss") or not url.hostname:
        raise ValueError("unsupported redis address")
    password = urllib.parse.unquote(url.password or "")
    if "\n" in password or "\r" in password:
        raise ValueError("unsupported credential encoding")
    # Existing redis-cli does the protocol. The password crosses stdin, never argv.
    args = ["docker", "exec", "-i", redis_container, "sh", "-c",
            'IFS= read -r REDISCLI_AUTH; export REDISCLI_AUTH; exec redis-cli "$@"', "probe",
            "--json", "-h", url.hostname, "-p", str(url.port or 6379),
            "--user", urllib.parse.unquote(url.username or "default"), "-n", url.path.lstrip("/") or "0"]
    if url.scheme == "rediss":
        args.append("--tls")
    args += ["EVAL_RO", QUEUE_SCRIPT, "2", env.get("WISP_REVALIDATE_STREAM", "wisp:revalidate"),
             env.get("WISP_REVALIDATE_DLQ_STREAM", "wisp:revalidate:dlq"),
             env.get("WISP_REVALIDATE_GROUP", "firehose-service")]
    return json.loads(json.loads(command(args, (password + "\n").encode())))


def queue_ok(sample, state, now):
    pending, lag = number(sample["pending"]), number(sample["lag"])
    oldest = sample["oldest"]
    age = 0 if pending == 0 else now - int(oldest.split("-", 1)[0]) / 1000
    high = pending + lag >= 100
    if high:
        state.setdefault("backlogSince", now)
    else:
        state.pop("backlogSince", None)
    # last-generated-id still advances when bounded DLQ trimming hides XLEN growth.
    dlq = tuple(map(int, sample["dlq"].split("-")))
    previous = tuple(state.get("dlq", dlq))
    if dlq > previous:
        state["growthAt"] = now
    state["dlq"] = dlq
    return (age < 1800 and (not high or now - state["backlogSince"] < 900)
            and now - state.get("growthAt", -1e12) >= 600)


def logs_ok(url):
    query = '_time:30m job:in("main-app", "hosting-service", "firehose-service") | stats count() as rows'
    rows = request(url + "/select/logsql/query?" + urllib.parse.urlencode({"query": query}))
    return sum(number(float(json.loads(line)["rows"])) for line in rows.splitlines() if line) > 0


def confirmed(name, healthy, state, now, delay=180):
    pending = state.setdefault("badSince", {})
    if healthy is None or healthy:
        pending.pop(name, None)
        return healthy
    pending.setdefault(name, now)
    return now - pending[name] < delay


def collect(config, state, now):
    results = {}

    def check(name, operation):
        try:
            results[name] = operation()
        except Exception as error:
            results[name] = None if name == "ingestion" else False
            # Health bodies, Docker output, endpoints and credentials stay private.
            print(f"{name}: unavailable ({type(error).__name__})", flush=True)

    if "logs_url" in config:
        check("logs", lambda: logs_ok(config["logs_url"]))
    if "apps" in config:
        apps = config["apps"]
        network = config.get("network", "proxy_network")
        check("database", lambda: replica_ok(health(inspect(apps["main"]), 8000, "/api/health", network), now))
        check("exporter", lambda: exporter_ok([inspect(name) for name in apps.values()]))
        check("ingestion", lambda: ingestion_ok(health(inspect(apps["firehose"]), 3002, "/health", network)))
        if "redis_container" in config:
            check("queue", lambda: queue_ok(queue_snapshot(inspect(apps["firehose"]), config["redis_container"]),
                                            state.setdefault("queue", {}), now))
    return results


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    state_path = Path(config.get("state_path", "/var/lib/wisp-operations/state.json"))
    now = time.time()
    try:
        state = json.loads(state_path.read_text())
        if not 0 <= now - state["observedAt"] <= 300:
            state = {}
    except (OSError, ValueError, KeyError):
        state = {}
    results = collect(config, state, now)
    statuses = {name: confirmed(name, healthy, state, now) for name, healthy in results.items()}
    # Persist debounce/baseline before sending. A broken state disk must miss beats,
    # not reset a failing predicate to an indefinitely healthy grace period.
    state["observedAt"] = now
    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state))
    os.replace(temporary, state_path)
    failed = False
    for name, success in statuses.items():
        if success is None:
            continue
        try:
            push(config["destinations"][name], success)
            print(f"{name}: {'healthy' if results[name] else 'pending' if success else 'unhealthy'}; status accepted", flush=True)
        except Exception as error:
            print(f"{name}: status withheld ({type(error).__name__})", flush=True)
            failed = True
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
