# Build from monorepo root: docker build -f apps/webhook-service/Dockerfile .

# Stage 1: Install dependencies and compile binary
FROM oven/bun:1.3.7-alpine AS builder

WORKDIR /app

# Copy workspace configuration files
COPY package.json bun.lock tsconfig.json ./

# Copy all workspace packages (needed for workspace: dependencies)
COPY packages ./packages
COPY apps/webhook-service ./apps/webhook-service
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json
COPY apps/firehose-service/package.json ./apps/firehose-service/package.json
COPY cli/package.json ./cli/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Compile to a single binary
RUN bun build --compile --minify apps/webhook-service/src/index.ts --outfile /app/webhook

# Stage 2: Minimal runtime
FROM alpine:3.22

RUN apk add --no-cache libstdc++ libgcc

COPY --from=builder /app/webhook /usr/local/bin/webhook

ENV NODE_ENV=production

CMD ["webhook"]
