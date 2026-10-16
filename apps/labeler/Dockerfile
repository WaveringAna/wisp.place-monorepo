# Build from monorepo root: docker build -f apps/labeler/Dockerfile .

# Stage 1: Install dependencies and compile binary
FROM oven/bun:1.4.2-alpine AS builder

WORKDIR /app

# Copy workspace configuration files
COPY package.json bun.lock tsconfig.json ./
COPY patches ./patches

# Copy all workspace packages (needed for workspace: dependencies)
COPY packages ./packages
COPY apps/labeler ./apps/labeler
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json
COPY apps/firehose-service/package.json ./apps/firehose-service/package.json
COPY apps/webhook-service/package.json ./apps/webhook-service/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Compile to a single binary
RUN NODE_ENV=production bun build --compile --minify apps/labeler/src/index.ts --outfile /app/labeler

# Stage 2: Minimal runtime
FROM alpine:3.22

RUN apk add --no-cache libstdc++ libgcc ca-certificates

COPY --from=builder /app/labeler /usr/local/bin/labeler

ENV NODE_ENV=production
# The labeler defaults to loopback; the container binds everywhere so the proxy can reach it.
ENV LABELER_HOST=0.0.0.0
ENV LABELER_PORT=3010

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3010/xrpc/_health || exit 1

CMD ["labeler"]
