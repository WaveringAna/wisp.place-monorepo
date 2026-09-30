#!/usr/bin/env python3
"""Report private app health without exposing ports or sending health payloads."""

import concurrent.futures
import json
import subprocess
import sys
import urllib.parse
import urllib.request


def healthy(app, body):
    expected = "healthy" if app in ("firehose-service", "webhook-service") else "ok"
    return isinstance(body, dict) and body.get("status") == expected


def active_leader(body):
    return (
        healthy("firehose-service", body)
        and body.get("ready") is True
        and body.get("leadership", {}).get("state") == "acquired"
    )


def ping(url):
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "uptime.betterstack.com"
        or not parsed.path.startswith("/api/v1/heartbeat/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid heartbeat destination")
    with urllib.request.urlopen(url, timeout=10) as response:
        if response.status != 200:
            raise ValueError("heartbeat rejected")


def probe(check, leader_url):
    app = check["app"]
    try:
        container = json.loads(subprocess.check_output(
            ["docker", "inspect", check["container"]],
            timeout=5, stderr=subprocess.DEVNULL,
        ))[0]
        if not container["State"]["Running"]:
            raise ValueError("container stopped")
        network = check.get("network", "proxy_network")
        address = container["NetworkSettings"]["Networks"][network]["IPAddress"]
        if not address:
            raise ValueError("missing container address")
        # Resolve the address each time: container replacement must not stale the probe.
        url = f'http://{address}:{check["port"]}{check["path"]}'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=10) as response:
            if response.status != 200 or response.url != url:
                raise ValueError("invalid health response")
            body = json.load(response)
        if not healthy(app, body):
            raise ValueError("degraded app")
        ping(check["heartbeat_url"])
        if app == "firehose-service" and active_leader(body):
            ping(leader_url)
        print(f"{app}: healthy; heartbeat accepted", flush=True)
        return True
    except Exception as error:
        # Exceptions may contain secret heartbeat URLs; log only their class.
        print(f"{app}: probe failed ({type(error).__name__}); heartbeat withheld", flush=True)
        return False


def main():
    with open(sys.argv[1]) as source:
        config = json.load(source)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(
            lambda check: probe(check, config.get("leader_heartbeat_url")), config["checks"],
        ))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
