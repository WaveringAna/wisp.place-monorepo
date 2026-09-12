#!/usr/bin/env python3
"""Validate rendered logging settings without printing Compose credentials."""

import json
import sys

APPS = ("wisp-place", "wisp-hosting-service", "wisp-firehose-service")
URLS = ("http://100.64.0.20:9428", "https://logs.nekomimi.pet")


def verify(config):
    problems = []
    for name in APPS:
        environment = config.get("services", {}).get(name, {}).get("environment", {})
        if environment.get("GRAFANA_LOKI_URL") not in URLS:
            problems.append(f"{name}: missing or unexpected GRAFANA_LOKI_URL")
        if environment.get("GRAFANA_LOKI_PATH") != "/insert/loki/api/v1/push":
            problems.append(f"{name}: missing or unexpected GRAFANA_LOKI_PATH")
    return problems


if __name__ == "__main__":
    problems = verify(json.load(sys.stdin))
    print("\n".join(problems) if problems else "all production apps retain log ingestion settings")
    sys.exit(bool(problems))
