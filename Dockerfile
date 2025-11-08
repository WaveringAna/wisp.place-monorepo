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

# Build the application (if needed)
RUN bun build \
	--compile \
	--minify \
	--outfile server \
	src/index.ts

FROM scratch AS runtime
WORKDIR /app
COPY --from=base /app/server /app/server

# Set environment variables (can be overridden at runtime)
ENV PORT=3000
ENV NODE_ENV=production

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["./server"]
