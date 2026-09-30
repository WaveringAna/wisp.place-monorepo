#!/usr/bin/env python3
"""Push private health to the off-fleet status host; never send health payloads."""

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


def push(destination, success):
    url = destination["url"]
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc != "status.wisp.place"
            or not parsed.path.startswith("/api/v1/endpoints/")
            or not parsed.path.endswith("/external") or parsed.query or parsed.fragment):
        raise ValueError("invalid status destination")
    # Do not follow redirects with the bearer credential.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    request = urllib.request.Request(
        url + "?success=" + str(success).lower(), data=b"", method="POST",
        headers={"Authorization": "Bearer " + destination["token"]},
    )
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=10) as response:
        if response.status != 200:
            raise ValueError("status push rejected")


def probe(check, leader):
    app = check["app"]
    try:
        container = json.loads(subprocess.check_output(
            ["docker", "inspect", check["container"]], timeout=5, stderr=subprocess.DEVNULL,
        ))[0]
        if not container["State"]["Running"]:
            raise ValueError("container stopped")
        address = container["NetworkSettings"]["Networks"][check.get("network", "proxy_network")]["IPAddress"]
        if not address:
            raise ValueError("missing container address")
        url = f'http://{address}:{check["port"]}{check["path"]}'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=10) as response:
            if response.status != 200 or response.url != url:
                raise ValueError("invalid health response")
            body = json.load(response)
        if not healthy(app, body):
            raise ValueError("degraded app")
        push(check["destination"], True)
        if app == "firehose-service" and active_leader(body):
            push(leader, True)
        print(f"{app}: healthy; status accepted", flush=True)
        return True
    except Exception as error:
        # Withholding pushes debounces transient failures; Gatus marks missing beats down.
        # Never print exceptions: their messages can contain credentials or health bodies.
        print(f"{app}: probe failed ({type(error).__name__}); status withheld", flush=True)
        return False


def main():
    with open(sys.argv[1]) as source:
        config = json.load(source)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda check: probe(check, config.get("leader")), config["checks"]))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
