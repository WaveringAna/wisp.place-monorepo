# Build from monorepo root: docker build -f apps/hosting-service/Dockerfile .

# Stage 1: Compile to standalone binary
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy workspace configuration files
COPY package.json bun.lock tsconfig.json ./

# Copy all workspace packages (needed for workspace: dependencies)
COPY packages ./packages
COPY apps/hosting-service ./apps/hosting-service
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/firehose-service/package.json ./apps/firehose-service/package.json
COPY apps/webhook-service/package.json ./apps/webhook-service/package.json
COPY cli/package.json ./cli/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Compile to a single binary
RUN bun build --compile --minify apps/hosting-service/src/index.ts --outfile /app/hosting

# Stage 2: Minimal runtime
FROM alpine:3.22

RUN apk add --no-cache libstdc++ libgcc

COPY --from=builder /app/hosting /usr/local/bin/hosting

# Create cache directory
RUN mkdir -p /cache/sites

ENV PORT=3001
ENV NODE_ENV=production
ENV CACHE_DIR=/cache/sites

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["hosting"]
