# Production stage
FROM oven/bun:1.3

WORKDIR /app

# Copy workspace configuration
COPY package.json bunfig.toml tsconfig.json bun.lock* ./

# Copy all workspace package.json files first (for dependency resolution)
COPY packages/@wisp/atproto-utils/package.json ./packages/@wisp/atproto-utils/package.json
COPY packages/@wisp/constants/package.json ./packages/@wisp/constants/package.json
COPY packages/@wisp/database/package.json ./packages/@wisp/database/package.json
COPY packages/@wisp/fs-utils/package.json ./packages/@wisp/fs-utils/package.json
COPY packages/@wisp/lexicons/package.json ./packages/@wisp/lexicons/package.json
COPY packages/@wisp/observability/package.json ./packages/@wisp/observability/package.json
COPY packages/@wisp/safe-fetch/package.json ./packages/@wisp/safe-fetch/package.json
COPY apps/main-app/package.json ./apps/main-app/package.json
COPY apps/hosting-service/package.json ./apps/hosting-service/package.json

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy workspace source files
COPY packages ./packages

# Copy app source and public files
COPY apps/main-app ./apps/main-app

ENV PORT=8000

EXPOSE 8000

CMD ["bun", "run", "apps/main-app/src/index.ts"]
