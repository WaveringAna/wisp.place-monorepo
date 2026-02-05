# Build stage
FROM oven/bun:1.3 AS build

WORKDIR /app

# Copy workspace configuration
COPY package.json bunfig.toml tsconfig.json bun.lock* ./

# Copy all workspace package.json files first (for dependency resolution)
COPY cli ./cli
COPY packages ./packages
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json
COPY apps/firehose-service/package.json ./apps/firehose-service/package.json

# Install all dependencies (including workspaces)
RUN bun install --frozen-lockfile

# Copy source files
COPY apps/main-app ./apps/main-app

# Build frontend (CSS + JS bundles)
RUN cd apps/main-app && bun run build

# Build compiled server
RUN bun build \
	--compile \
	--target bun \
	--minify \
	--outfile server \
	apps/main-app/src/index.ts

# Final stage - slim image with just the compiled binary
FROM debian:bookworm-slim

WORKDIR /app

# Copy compiled server (standalone binary - no node_modules needed)
COPY --from=build /app/server /app/server

# Copy public static assets
COPY apps/main-app/public apps/main-app/public

# Copy built frontend assets
COPY --from=build /app/apps/main-app/dist apps/main-app/dist

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

CMD ["./server"]
