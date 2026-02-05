# Build from monorepo root: docker build -f apps/firehose-service/Dockerfile .

# Stage 1: Install dependencies
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy workspace configuration files
COPY package.json bun.lock tsconfig.json ./

# Copy all workspace packages (needed for workspace: dependencies)
COPY packages ./packages
COPY apps/firehose-service ./apps/firehose-service
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json
COPY cli/package.json ./cli/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Stage 2: Runtime
FROM oven/bun:1-alpine AS runtime

WORKDIR /app

# Copy workspace and dependencies from builder
COPY --from=builder /app /app

WORKDIR /app/apps/firehose-service

ENV NODE_ENV=production
ENV HEALTH_PORT=3001

# Start the firehose service
CMD ["bun", "run", "start"]
