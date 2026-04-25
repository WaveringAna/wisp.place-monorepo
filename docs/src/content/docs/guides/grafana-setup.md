---
title: Grafana Setup Example
description: Quick setup for Grafana Cloud monitoring
---

A step-by-step walkthrough for connecting Wisp to Grafana Cloud. If you already have a Grafana instance, you can skip to step 3.

## 1. Create Grafana Cloud Account

Sign up at [grafana.com](https://grafana.com) for a free tier account.

## 2. Get Credentials

Navigate to your stack and find:

**Loki** (Connections → Loki → Details):
- Push endpoint: `https://logs-prod-XXX.grafana.net`
- Create API token with write permissions

**Prometheus** (Connections → Prometheus → Details):
- Remote Write endpoint: `https://prometheus-prod-XXX.grafana.net/api/prom`
- Create API token with write permissions

## 3. Configure Wisp.place

Add to your `.env`:

```bash
GRAFANA_LOKI_URL=https://logs-prod-XXX.grafana.net
GRAFANA_LOKI_TOKEN=glc_eyJ...

GRAFANA_PROMETHEUS_URL=https://prometheus-prod-XXX.grafana.net/api/prom
GRAFANA_PROMETHEUS_TOKEN=glc_eyJ...
```

## 4. Create Dashboard

Import this dashboard JSON or build your own:

```json
{
  "panels": [
    {
      "title": "Request Rate",
      "targets": [{
        "expr": "sum(rate(http_requests_total[1m])) by (service)"
      }]
    },
    {
      "title": "P95 Latency",
      "targets": [{
        "expr": "histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m]))"
      }]
    },
    {
      "title": "Error Rate",
      "targets": [{
        "expr": "sum(rate(errors_total[5m])) / sum(rate(http_requests_total[5m]))"
      }]
    }
  ]
}
```

## 5. Set Alerts

Example alert for high error rate:

```yaml
alert: HighErrorRate
expr: |
  sum(rate(errors_total[5m])) by (service) /
  sum(rate(http_requests_total[5m])) by (service) > 0.05
for: 5m
annotations:
  summary: "High error rate in {{ $labels.service }}"
```

## Verify Data Flow

Check Grafana Explore:
- Loki: `{job="main-app"} | json`
- Prometheus: `http_requests_total`

Data should appear within 30 seconds of service startup.