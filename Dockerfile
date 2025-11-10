# Use official Bun image
FROM oven/bun:1.3 AS base

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY src ./src
COPY public ./public

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["bun", "start"]
