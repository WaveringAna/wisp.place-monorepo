#!/usr/bin/env python3
"""Append operational endpoints to an existing Gatus JSON config; preserve its checks."""

import copy
import json
from pathlib import Path
import sys

REGIONS = ("us-west", "eu", "us-east", "singapore")
ENDPOINTS = [(region, name) for region in REGIONS for name in ("database-replica", "log-exporter")]
ENDPOINTS += [("operations", name) for name in ("ingestion", "revalidation", "log-ingestion")]


def token_name(group, name):
    return "OPS_" + f"{group}_{name}_TOKEN".upper().replace("-", "_")


def extend(config):
    result = copy.deepcopy(config)
    endpoints = result.setdefault("external-endpoints", [])
    existing = {(entry["group"], entry["name"]) for entry in endpoints}
    for group, name in ENDPOINTS:
        if (group, name) in existing:
            raise ValueError(f"operational endpoint already exists: {group}/{name}")
        endpoints.append({
            "group": group, "name": name, "token": "${" + token_name(group, name) + "}",
            "heartbeat": {"interval": "4m"},
            "alerts": [{"type": "discord", "failure-threshold": 1,
                        "success-threshold": 2, "send-on-resolved": True}],
        })
    return result


if __name__ == "__main__":
    print(json.dumps(extend(json.loads(Path(sys.argv[1]).read_text())), indent=2))
