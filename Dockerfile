# Build stage
FROM oven/bun:1.3 AS build

WORKDIR /app

# Copy workspace configuration
COPY package.json bunfig.toml tsconfig.json bun.lock* ./

# Copy all workspace package.json files first (for dependency resolution)
COPY packages ./packages
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json

# Install all dependencies (including workspaces)
RUN bun install --frozen-lockfile

# Copy source files
COPY apps/main-app ./apps/main-app

# Build compiled server
RUN bun build \
	--compile \
	--target bun \
	--minify \
	--outfile server \
	apps/main-app/src/index.ts

# Production dependencies stage
FROM oven/bun:1.3 AS prod-deps

WORKDIR /app

COPY package.json bunfig.toml tsconfig.json bun.lock* ./
COPY packages ./packages
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json

# Install only production dependencies
RUN bun install --frozen-lockfile --production

# Remove unnecessary large packages (bun is already in base image, these are dev tools)
RUN rm -rf /app/node_modules/bun \
    /app/node_modules/@oven \
    /app/node_modules/prettier \
    /app/node_modules/@ts-morph

# Final stage - use distroless or slim debian-based image
FROM debian:bookworm-slim

# Install Bun runtime
COPY --from=oven/bun:1.3 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy compiled server
COPY --from=build /app/server /app/server

# Copy public files
COPY apps/main-app/public apps/main-app/public

# Copy production dependencies only
COPY --from=prod-deps /app/node_modules /app/node_modules

# Copy configs
COPY package.json bunfig.toml tsconfig.json /app/
COPY apps/main-app/tsconfig.json /app/apps/main-app/tsconfig.json
COPY apps/main-app/package.json /app/apps/main-app/package.json

# Create symlink for module resolution
RUN ln -s /app/node_modules /app/apps/main-app/node_modules

ENV PORT=8000

EXPOSE 8000

CMD ["./server"]
