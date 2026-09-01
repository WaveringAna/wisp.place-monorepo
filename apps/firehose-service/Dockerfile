# Build from monorepo root: docker build -f apps/firehose-service/Dockerfile .

# Stage 1: Install dependencies and compile binary
FROM oven/bun:1.3.14-alpine AS builder

WORKDIR /app

# Copy workspace configuration files
COPY package.json bun.lock tsconfig.json ./
COPY patches ./patches

# Copy all workspace packages (needed for workspace: dependencies)
COPY packages ./packages
COPY apps/firehose-service ./apps/firehose-service
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json
COPY apps/webhook-service/package.json ./apps/webhook-service/package.json
COPY cli/package.json ./cli/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Compile to a single binary
RUN NODE_ENV=production bun build --compile --minify apps/firehose-service/src/index.ts --outfile /app/firehose
RUN NODE_ENV=production bun build --compile --minify apps/firehose-service/src/supervisor.ts --outfile /app/firehose-supervisor
RUN NODE_ENV=production bun build --compile --minify apps/firehose-service/src/watchdog.ts --outfile /app/firehose-watchdog

# Stage 2: Minimal runtime
FROM alpine:3.22

# The runtime must enable Docker's built-in init (`--init` / Compose
# `init: true`) so the supervised worker is not namespace PID 1. Startup
# refuses the unsafe PID-1 layout.
RUN apk add --no-cache libstdc++ libgcc

COPY --from=builder /app/firehose /usr/local/bin/firehose
COPY --from=builder /app/firehose-supervisor /usr/local/bin/firehose-supervisor
COPY --from=builder /app/firehose-watchdog /usr/local/bin/firehose-watchdog

ENV NODE_ENV=production
ENV HEALTH_PORT=3001

CMD ["firehose"]
