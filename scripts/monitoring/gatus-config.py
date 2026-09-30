#!/usr/bin/env python3
"""Render secret-free Gatus configuration (JSON is also valid YAML)."""

import json

REGIONS = ("us-west", "eu", "us-east", "singapore")
APPS = ("main-app", "hosting-service", "firehose-service")


def token_name(group, name):
    return f"{group}_{name}_TOKEN".upper().replace("-", "_")


def configuration():
    def public(group, name, url, health=True):
        return {
            "group": group, "name": name, "url": url, "interval": "60s",
            "client": {"timeout": "15s", "ignore-redirect": True},
            "conditions": ["[STATUS] == 200"] + (["[BODY].status == ok"] if health else []),
            "alerts": [{"type": "discord"}],
        }

    endpoints = [
        public("global", "website", "https://wisp.place", False),
        public("global", "hosting", "https://sites.wisp.place/health"),
    ]
    for region in REGIONS:
        endpoints += [
            public(region, "dashboard", f"https://{region}.wisp.place/api/health"),
            public(region, "hosting", f"https://{region}.sites.wisp.place/health"),
        ]
    external = [(region, app) for region in REGIONS for app in APPS]
    external += [("global", "site-publishing"), ("global", "webhooks")]
    return {
        "ui": {
            "title": "wisp.place status", "header": "wisp.place",
            "dashboard-heading": "service status",
            "dashboard-subheading": "live health across the wisp.place fleet, monitored from an independent server.",
            "link": "https://wisp.place",
        },
        "storage": {
            "type": "sqlite", "path": "/data/gatus.db",
            "maximum-number-of-results": 1440, "maximum-number-of-events": 200,
        },
        "alerting": {"discord": {
            "webhook-url": "${DISCORD_WEBHOOK_URL}", "title": "wisp.place status",
            "default-alert": {
                "failure-threshold": 2, "success-threshold": 2, "send-on-resolved": True,
            },
        }},
        "endpoints": endpoints,
        "external-endpoints": [
            {
                "group": group, "name": name, "token": "${" + token_name(group, name) + "}",
                "heartbeat": {"interval": "3m"},
                "alerts": [{"type": "discord", "failure-threshold": 1}],
            }
            for group, name in external
        ],
    }


if __name__ == "__main__":
    print(json.dumps(configuration(), indent=2))
