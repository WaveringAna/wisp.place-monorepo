# @wisp/observability

Framework-agnostic observability package with Grafana integration for logs and metrics persistence.

## Features

- **In-memory storage** for local development
- **Grafana Loki** integration for log persistence
- **Prometheus/OTLP** integration for metrics
- Framework middleware for Elysia and Hono
- Automatic batching and buffering for efficient data transmission

## Installation

```bash
bun add @wisp/observability
```

## Basic Usage

### Without Grafana (In-Memory Only)

```typescript
import { createLogger, metricsCollector } from '@wisp/observability'

const logger = createLogger('my-service')

// Log messages
logger.info('Server started')
logger.error('Failed to connect', new Error('Connection refused'))

// Record metrics
metricsCollector.recordRequest('/api/users', 'GET', 200, 45, 'my-service')
```

### With Grafana Integration

```typescript
import { initializeGrafanaExporters, createLogger } from '@wisp/observability'

// Initialize at application startup
initializeGrafanaExporters({
  lokiUrl: 'https://logs-prod.grafana.net',
  lokiAuth: {
    bearerToken: 'your-loki-api-key'
  },
  prometheusUrl: 'https://prometheus-prod.grafana.net',
  prometheusAuth: {
    bearerToken: 'your-prometheus-api-key'
  },
  serviceName: 'wisp-app',
  serviceVersion: '1.0.0',
  batchSize: 100,
  flushIntervalMs: 5000
})

// Now all logs and metrics will be sent to Grafana automatically
const logger = createLogger('my-service')
logger.info('This will be sent to Grafana Loki')
```

## Configuration

### Environment Variables

You can configure Grafana integration using environment variables:

```bash
# Loki configuration
GRAFANA_LOKI_URL=https://logs-prod.grafana.net

# Authentication Option 1: Bearer Token (Grafana Cloud)
GRAFANA_LOKI_TOKEN=your-loki-api-key

# Authentication Option 2: Username/Password (Self-hosted or some Grafana setups)
GRAFANA_LOKI_USERNAME=your-username
GRAFANA_LOKI_PASSWORD=your-password

# Prometheus configuration
GRAFANA_PROMETHEUS_URL=https://prometheus-prod.grafana.net/api/prom

# Authentication Option 1: Bearer Token (Grafana Cloud)
GRAFANA_PROMETHEUS_TOKEN=your-prometheus-api-key

# Authentication Option 2: Username/Password (Self-hosted or some Grafana setups)
GRAFANA_PROMETHEUS_USERNAME=your-username
GRAFANA_PROMETHEUS_PASSWORD=your-password
```

### Programmatic Configuration

```typescript
import { initializeGrafanaExporters } from '@wisp/observability'

initializeGrafanaExporters({
  // Loki configuration for logs
  lokiUrl: 'https://logs-prod.grafana.net',
  lokiAuth: {
    // Option 1: Bearer token (recommended for Grafana Cloud)
    bearerToken: 'your-api-key',

    // Option 2: Basic auth
    username: 'your-username',
    password: 'your-password'
  },

  // Prometheus/OTLP configuration for metrics
  prometheusUrl: 'https://prometheus-prod.grafana.net',
  prometheusAuth: {
    bearerToken: 'your-api-key'
  },

  // Service metadata
  serviceName: 'wisp-app',
  serviceVersion: '1.0.0',

  // Batching configuration
  batchSize: 100,              // Flush after this many entries
  flushIntervalMs: 5000,       // Flush every 5 seconds

  // Enable/disable exporters
  enabled: true
})
```

## Middleware Integration

### Elysia

```typescript
import { Elysia } from 'elysia'
import { observabilityMiddleware } from '@wisp/observability/middleware/elysia'
import { initializeGrafanaExporters } from '@wisp/observability'

// Initialize Grafana exporters
initializeGrafanaExporters({
  lokiUrl: process.env.GRAFANA_LOKI_URL,
  lokiAuth: { bearerToken: process.env.GRAFANA_LOKI_TOKEN }
})

const app = new Elysia()
  .use(observabilityMiddleware({ service: 'main-app' }))
  .get('/', () => 'Hello World')
  .listen(3000)
```

### Hono

```typescript
import { Hono } from 'hono'
import { observabilityMiddleware, observabilityErrorHandler } from '@wisp/observability/middleware/hono'
import { initializeGrafanaExporters } from '@wisp/observability'

// Initialize Grafana exporters
initializeGrafanaExporters({
  lokiUrl: process.env.GRAFANA_LOKI_URL,
  lokiAuth: { bearerToken: process.env.GRAFANA_LOKI_TOKEN }
})

const app = new Hono()
app.use('*', observabilityMiddleware({ service: 'hosting-service' }))
app.onError(observabilityErrorHandler({ service: 'hosting-service' }))
```

## Grafana Cloud Setup

1. **Create a Grafana Cloud account** at https://grafana.com/

2. **Get your Loki credentials:**
   - Go to your Grafana Cloud portal
   - Navigate to "Loki" → "Details"
   - Copy the Push endpoint URL and create an API key

3. **Get your Prometheus credentials:**
   - Navigate to "Prometheus" → "Details"
   - Copy the Remote Write endpoint and create an API key

4. **Configure your application:**
   ```typescript
   initializeGrafanaExporters({
     lokiUrl: 'https://logs-prod-xxx.grafana.net',
     lokiAuth: { bearerToken: 'glc_xxx' },
     prometheusUrl: 'https://prometheus-prod-xxx.grafana.net/api/prom',
     prometheusAuth: { bearerToken: 'glc_xxx' }
   })
   ```

## Data Flow

1. **Logs** → Buffered → Batched → Sent to Grafana Loki
2. **Metrics** → Aggregated → Exported via OTLP → Sent to Prometheus
3. **Errors** → Deduplicated → Sent to Loki with error tag

## Performance Considerations

- Logs and metrics are batched to reduce network overhead
- Default batch size: 100 entries
- Default flush interval: 5 seconds
- Failed exports are logged but don't block application
- In-memory buffers are capped to prevent memory leaks

## Graceful Shutdown

The exporters automatically register shutdown handlers:

```typescript
import { shutdownGrafanaExporters } from '@wisp/observability'

// Manual shutdown if needed
process.on('beforeExit', async () => {
  await shutdownGrafanaExporters()
})
```

## License

MIT
