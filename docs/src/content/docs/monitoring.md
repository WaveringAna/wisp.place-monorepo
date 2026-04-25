---
title: Monitoring & Metrics
description: Grafana integration for logs and metrics
---

Wisp ships with built-in support for shipping logs and metrics to Grafana (Cloud or self-hosted). Point it at your Loki and Prometheus endpoints and it handles the rest — no custom exporters to write.

Set these environment variables and restart your services. Metrics and logs will flow to Grafana automatically.

```bash
# Grafana Cloud
GRAFANA_LOKI_URL=https://logs-prod-xxx.grafana.net
GRAFANA_LOKI_TOKEN=glc_xxx

GRAFANA_PROMETHEUS_URL=https://prometheus-prod-xxx.grafana.net/api/prom
GRAFANA_PROMETHEUS_TOKEN=glc_xxx

# Self-hosted (basic auth instead of bearer token)
GRAFANA_LOKI_USERNAME=your-username
GRAFANA_LOKI_PASSWORD=your-password
```

See [Grafana Setup](/guides/grafana-setup) for a step-by-step walkthrough.

## Metrics

- `http_requests_total` — request count by path, method, and status
- `http_request_duration_ms` — duration histogram (P50/P95/P99 available)
- `errors_total` — error count by service

## Log Labels

Logs are tagged by service so you can filter them in Loki:

```
{job="main-app"}         # OAuth, uploads, domain management
{job="hosting-service"}  # Firehose, caching, content serving
```

## All Options

```bash
GRAFANA_LOKI_URL            # Loki push endpoint
GRAFANA_PROMETHEUS_URL      # Prometheus remote write endpoint

GRAFANA_LOKI_TOKEN          # Bearer token (Grafana Cloud)
GRAFANA_LOKI_USERNAME       # Basic auth (self-hosted)
GRAFANA_LOKI_PASSWORD

GRAFANA_BATCH_SIZE=100      # Entries per flush
GRAFANA_FLUSH_INTERVAL=5000 # Flush interval in ms
```

## Dashboard Queries

```promql
# Average response time by endpoint
avg by (path) (
  rate(http_request_duration_ms_sum[5m]) /
  rate(http_request_duration_ms_count[5m])
)

# Request rate by service
sum(rate(http_requests_total[1m])) by (service)

# Error rate
sum(rate(errors_total[5m])) by (service) /
sum(rate(http_requests_total[5m])) by (service)
```

```logql
{job="main-app"} |= "error" | json
{job="hosting-service"} |~ "duration.*[1-9][0-9]{3,}"
```

## Without Grafana

The old in-memory observability endpoints were removed. Without Grafana, use service logs and the remaining health endpoints for operational checks.

## Programmatic Setup

```typescript
import { initializeGrafanaExporters } from '@wisp/observability'

initializeGrafanaExporters({
  lokiUrl: 'https://logs.grafana.net',
  lokiAuth: { bearerToken: 'token' },
  prometheusUrl: 'https://prometheus.grafana.net/api/prom',
  prometheusAuth: { bearerToken: 'token' },
  serviceName: 'my-service',
  batchSize: 100,
  flushIntervalMs: 5000
})
```
