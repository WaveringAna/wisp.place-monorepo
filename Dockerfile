# Production stage
FROM oven/bun:1 AS build

WORKDIR /app

# Copy workspace configuration
COPY package.json package.json
COPY bun.lock bun.lock
COPY bunfig.toml bunfig.toml
COPY tsconfig.json tsconfig.json

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
RUN bun install

# Copy workspace source files
COPY packages ./packages
COPY apps/main-app ./apps/main-app

ENV NODE_ENV=production

# Build Tailwind CSS (build to temp files then replace originals)
RUN bunx @tailwindcss/cli -i ./apps/main-app/public/styles/global.css -o ./apps/main-app/public/styles/global.tmp.css --minify && \
    mv ./apps/main-app/public/styles/global.tmp.css ./apps/main-app/public/styles/global.css
RUN bunx @tailwindcss/cli -i ./apps/main-app/public/admin/styles.css -o ./apps/main-app/public/admin/styles.tmp.css --minify && \
    mv ./apps/main-app/public/admin/styles.tmp.css ./apps/main-app/public/admin/styles.css

# Build frontend (transpile all .tsx entry points to .js)
RUN bun build ./apps/main-app/public/index.tsx --outdir ./apps/main-app/public --target browser
RUN bun build ./apps/main-app/public/admin/admin.tsx --outdir ./apps/main-app/public/admin --target browser
RUN bun build ./apps/main-app/public/acceptable-use/acceptable-use.tsx --outdir ./apps/main-app/public/acceptable-use --target browser
RUN bun build ./apps/main-app/public/editor/editor.tsx --outdir ./apps/main-app/public/editor --target browser
RUN bun build ./apps/main-app/public/onboarding/onboarding.tsx --outdir ./apps/main-app/public/onboarding --target browser

# Update HTML files to reference .js instead of .tsx
RUN sed -i 's/\.tsx"/.js"/g' ./apps/main-app/public/index.html
RUN sed -i 's/\.tsx"/.js"/g' ./apps/main-app/public/admin/index.html
RUN sed -i 's/\.tsx"/.js"/g' ./apps/main-app/public/acceptable-use/index.html
RUN sed -i 's/\.tsx"/.js"/g' ./apps/main-app/public/editor/index.html
RUN sed -i 's/\.tsx"/.js"/g' ./apps/main-app/public/onboarding/index.html

# Build backend as compiled binary
RUN bun build \
	--compile \
	--target=bun \
	--minify-whitespace \
	--minify-syntax \
	--outfile server \
	./apps/main-app/src/index.ts

FROM gcr.io/distroless/base

WORKDIR /app

COPY --from=build /app/server server
COPY --from=build /app/apps/main-app/public /app/apps/main-app/public

ENV NODE_ENV=production

CMD ["./server"]

EXPOSE 8000