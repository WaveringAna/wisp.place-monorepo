# Build from monorepo root: docker build -f apps/preview-bot/Dockerfile .

# Stage 1: Install dependencies and compile binary
FROM docker.io/oven/bun:1.4.2-alpine AS builder

WORKDIR /app

# Copy workspace configuration files
COPY package.json bun.lock tsconfig.json ./
COPY patches ./patches

# Copy all workspace packages (needed for workspace: dependencies)
COPY packages ./packages
COPY apps/preview-bot ./apps/preview-bot
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json
COPY apps/firehose-service/package.json ./apps/firehose-service/package.json
COPY apps/webhook-service/package.json ./apps/webhook-service/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Compile to a single binary
RUN NODE_ENV=production bun build --compile --minify apps/preview-bot/src/index.ts --outfile /app/preview-bot

# Stage 2: Minimal runtime
FROM docker.io/alpine:3.22

RUN apk add --no-cache libstdc++ libgcc ca-certificates

COPY --from=builder /app/preview-bot /usr/local/bin/preview-bot

ENV NODE_ENV=production
ENV PORT=3004

EXPOSE 3004

CMD ["preview-bot"]
