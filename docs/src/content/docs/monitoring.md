---
title: Monitoring & Metrics
description: Track performance and debug issues with Grafana integration
---

Wisp.place includes built-in observability with automatic Grafana integration for logs and metrics. Monitor request performance, track errors, and analyze usage patterns across both the main backend and hosting service.

## Quick Start

Set environment variables to enable Grafana export:

```bash
# Grafana Cloud
GRAFANA_LOKI_URL=https://logs-prod-xxx.grafana.net
GRAFANA_LOKI_TOKEN=glc_xxx

GRAFANA_PROMETHEUS_URL=https://prometheus-prod-xxx.grafana.net/api/prom
GRAFANA_PROMETHEUS_TOKEN=glc_xxx

# Self-hosted Grafana
GRAFANA_LOKI_USERNAME=your-username
GRAFANA_LOKI_PASSWORD=your-password
```

Restart services. Metrics and logs now flow to Grafana automatically.

## Metrics Collected

### HTTP Requests
- `http_requests_total` - Total request count by path, method, status
- `http_request_duration_ms` - Request duration histogram
- `errors_total` - Error count by service

### Performance Stats
- P50, P95, P99 response times
- Requests per minute
- Error rates
- Average duration by endpoint

## Log Aggregation

Logs are sent to Loki with automatic categorization:

```
{job="main-app"} |= "error"        # OAuth and upload errors
{job="hosting-service"} |= "cache"  # Cache operations
{service="hosting-service", level="warn"}  # Warnings only
```

## Service Identification

Each service is tagged separately:
- `main-app` - OAuth, uploads, domain management
- `hosting-service` - Firehose, caching, content serving

## Configuration Options

### Environment Variables

```bash
# Required
GRAFANA_LOKI_URL          # Loki endpoint
GRAFANA_PROMETHEUS_URL    # Prometheus endpoint (add /api/prom for OTLP)

# Authentication (use one)
GRAFANA_LOKI_TOKEN        # Bearer token (Grafana Cloud)
GRAFANA_LOKI_USERNAME     # Basic auth (self-hosted)
GRAFANA_LOKI_PASSWORD

# Optional
GRAFANA_BATCH_SIZE=100    # Batch size before flush
GRAFANA_FLUSH_INTERVAL=5000  # Flush interval in ms
```

### Programmatic Setup

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

## Grafana Dashboard Queries

### Request Performance
```promql
# Average response time by endpoint
avg by (path) (
  rate(http_request_duration_ms_sum[5m]) /
  rate(http_request_duration_ms_count[5m])
)

# Request rate
sum(rate(http_requests_total[1m])) by (service)

# Error rate
sum(rate(errors_total[5m])) by (service) /
sum(rate(http_requests_total[5m])) by (service)
```

### Log Analysis
```logql
# Recent errors
{job="main-app"} |= "error" | json

# Slow requests (>1s)
{job="hosting-service"} |~ "duration.*[1-9][0-9]{3,}"

# Failed OAuth attempts
{job="main-app"} |= "OAuth" |= "failed"
```

## Troubleshooting

### Logs not appearing
- Check `GRAFANA_LOKI_URL` is correct (no trailing `/loki/api/v1/push`)
- Verify authentication token/credentials
- Look for connection errors in service logs

### Metrics missing
- Ensure `GRAFANA_PROMETHEUS_URL` includes `/api/prom` suffix
- Check firewall rules allow outbound HTTPS
- Verify OpenTelemetry export errors in logs

### High memory usage
- Reduce `GRAFANA_BATCH_SIZE` (default: 100)
- Lower `GRAFANA_FLUSH_INTERVAL` to flush more frequently

## Local Development

Metrics and logs are stored in-memory when Grafana isn't configured. Access them via:

- `http://localhost:8000/api/observability/logs`
- `http://localhost:8000/api/observability/metrics`
- `http://localhost:8000/api/observability/errors`

## Testing Integration

Run integration tests to verify setup:

```bash
cd packages/@wisp/observability
bun test src/integration-test.test.ts

# Test with live Grafana
GRAFANA_LOKI_URL=... GRAFANA_LOKI_USERNAME=... GRAFANA_LOKI_PASSWORD=... \
bun test src/integration-test.test.ts
```