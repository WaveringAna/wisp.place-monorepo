---
title: Local development network
description: Run wisp infrastructure, a private reference PDS, and the end-to-end harness without production credentials.
---

The local stack uses the official AT Protocol reference PDS with a private PLC directory. It seeds two disposable accounts and keeps the PDS firehose off the public network.

## Start the infrastructure

```sh
cp .env.dev.example .env
bun run dev:infra
```

This starts:

| Service | URL or port |
| --- | --- |
| PostgreSQL | `127.0.0.1:5432` |
| Redis | `127.0.0.1:6379` |
| MinIO API | `http://127.0.0.1:9000` |
| MinIO console | `http://127.0.0.1:9001` |
| Reference PDS | `http://localhost:3300` |
| Local PLC directory | `http://127.0.0.1:2582` |
| MailDev | `http://127.0.0.1:1080` |

The PDS seed step writes the current DIDs and credentials to `.dev/atproto/accounts.env`. The stable development logins are `alice.test` / `alice-dev-password` and `bob.test` / `bob-dev-password`. It also creates an app password for Alice and records it in that file.

All secrets in this stack are fixed development-only values. Do not reuse the compose configuration or seeded credentials in a public deployment.

## Local hostnames

Use the reserved `.localhost` suffix instead of editing `/etc/hosts`:

| Surface | Hostname |
| --- | --- |
| Public path host | `http://sites.wisp.localhost:3001` |
| Wisp subdomain | `http://example.wisp.localhost:3001` |
| Private host boundary | `http://priv.wisp.localhost:3001` |
| Per-site private origin | `http://<site-id>.priv.wisp.localhost:3001` |

Browsers and macOS resolve every name beneath `.localhost` to loopback, including the per-site wildcard. Each private site therefore gets a real, separate origin and a host-only session cookie without installing a DNS server or using a Host-header rewrite proxy.

The checked-in `.env.dev.example` configures the main app and hosting service for these names. AT Protocol OAuth still returns to `127.0.0.1:8000`, which is the loopback redirect form accepted by the protocol's development client metadata.

## Run the services

With the infrastructure healthy, run the main app from the repository root:

```sh
bun run dev
```

Run the hosting and firehose services in separate terminals:

```sh
cd apps/hosting-service
bun --env-file=../../.env src/index.ts
```

```sh
cd apps/firehose-service
bunx tsx --env-file=../../.env src/index.ts
```

The firehose consumes only the local PDS at `ws://localhost:3300` (the client appends the `com.atproto.sync.subscribeRepos` XRPC path).

Stop the infrastructure without deleting its data:

```sh
bun run dev:infra:down
```

## End-to-end harness

The harness now brings up the same private PDS and seeded account automatically:

```sh
bun run e2e:harness
```

No production handle or password is required. To override the local account deliberately, set `E2E_ATPROTO_HANDLE` and `E2E_ATPROTO_PASSWORD`.

The runner exposes loopback proxies for the main app, PDS, and hosting service inside its own container. This lets Chromium follow the reference PDS OAuth redirects and visit wildcard private-site origins while the services still communicate over the Compose network.

Remove all harness volumes with:

```sh
bun run e2e:harness:down
```

## Why the reference PDS

The local network deliberately uses the reference implementation rather than a Wisp-specific miniature PDS:

- Sister Radio's embedded Rust PDS is read-only and intentionally omits accounts, OAuth, app passwords, blob uploads, and repo writes.
- Cirrus is a useful single-user Cloudflare Worker PDS, but its Durable Object and R2 architecture is not a local multi-account test network.
- `verdverm/testnet` includes a relay, SpiceDB permission service, and several databases. That is appropriate for permissioned-network experiments but unnecessarily large for testing Wisp's current PDS integration.
- `OpenMeet-Team/atproto-devnet` demonstrated the smaller shape used here: reference PDS, local PLC, seeded accounts, and an isolated firehose.

Keeping the PDS external to Wisp also means the harness tests the same protocol boundary used in production instead of a local mock that can drift from AT Protocol behavior.
