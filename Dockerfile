# Use official Bun image
FROM oven/bun:1.3 AS base

# Set working directory
WORKDIR /app

# Copy workspace configuration
COPY package.json bunfig.toml tsconfig.json ./

# Copy workspace packages
COPY packages ./packages

# Copy both apps (needed for workspace resolution)
COPY apps/main-app ./apps/main-app
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json

# Install all dependencies (including workspaces)
RUN bun install

ENV PORT=8000
ENV NODE_ENV=production

EXPOSE 8000

CMD ["bun", "run", "start"]
