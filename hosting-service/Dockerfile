# Use official Node.js Alpine image
FROM node:alpine AS base

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY src ./src

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

# Start the application (can override with 'npm run backfill' in compose)
CMD ["npm", "run", "start"]
