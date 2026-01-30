# Build from monorepo root: docker build -f apps/hosting-service/Dockerfile .

# Stage 1: Build
FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy workspace configuration files
COPY package.json bun.lock ./
COPY tsconfig.json ./

# Copy all workspace packages (needed for workspace: dependencies)
COPY packages ./packages
COPY apps/hosting-service ./apps/hosting-service
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY cli/package.json ./cli/package.json

# Install dependencies
RUN bun install --frozen-lockfile

# Build the hosting service
WORKDIR /app/apps/hosting-service
RUN bun run build

# Stage 2: Production
FROM node:22-alpine AS production

WORKDIR /app

# Copy only the built file
COPY --from=builder /app/apps/hosting-service/dist/index.js ./index.js

# Create cache directory
RUN mkdir -p ./cache/sites

# Set environment variables
ENV PORT=3001
ENV NODE_ENV=production

# Expose the application port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Start the application
CMD ["node", "index.js"]
