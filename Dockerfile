# Use official Bun image
FROM oven/bun:1.3 AS base

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Copy Bun configuration
COPY bunfig.toml ./

COPY tsconfig.json ./

# Install dependencies
RUN bun install

# Copy source code
COPY src ./src
COPY public ./public

ENV PORT=8000
ENV NODE_ENV=production

EXPOSE 8000

CMD ["bun", "start"]
