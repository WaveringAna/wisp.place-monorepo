FROM oven/bun:1.3.7

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
ENV E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium

RUN apt-get update && \
	apt-get install -y --no-install-recommends ca-certificates chromium fonts-liberation && \
	rm -rf /var/lib/apt/lists/*

COPY . .

RUN bun install --frozen-lockfile

WORKDIR /app/apps/main-app

CMD ["bun", "e2e/wisp-e2e.ts"]
