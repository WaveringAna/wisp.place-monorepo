# Use official Node.js Alpine image with pnpm
# Build from monorepo root: docker build -f apps/hosting-service/Dockerfile .
FROM node:alpine AS base

# Install pnpm globally (supports workspace: protocol)
RUN npm install -g pnpm

# Set working directory
WORKDIR /app

# Copy workspace configuration
COPY package.json tsconfig.json ./

# Copy all workspace packages
COPY packages ./packages

# Copy hosting-service and main-app package.json (for workspace resolution)
COPY apps/hosting-service ./apps/hosting-service
COPY apps/main-app/package.json ./apps/main-app/package.json

# Install all dependencies (including workspaces)
RUN pnpm install --frozen-lockfile || pnpm install

# Set working directory to hosting-service
WORKDIR /app/apps/hosting-service

# Create cache directory
RUN mkdir -p ./cache/sites

# Set environment variables (can be overridden at runtime)
ENV PORT=3001
ENV NODE_ENV=production

# Expose the application port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the application (can override with 'pnpm run backfill' in compose)
CMD ["pnpm", "run", "start"]
