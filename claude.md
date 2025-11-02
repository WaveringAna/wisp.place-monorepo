  Wisp.place - Decentralized Static Site Hosting

  Architecture Overview

  Wisp.Place a two-service application that provides static site hosting on the AT
  Protocol. Wisp aims to be a CDN for static sites where the content is ultimately owned by the user at their repo. The microservice is responsbile for injesting firehose events and serving a on-disk cache of the latest site files.

  Service 1: Main App (Port 8000, Bun runtime, elysia.js)
  - User-facing editor and API
  - OAuth authentication (AT Protocol)
  - File upload processing (gzip + base64 encoding)
  - Domain management (subdomains + custom domains)
  - DNS verification worker
  - React frontend

  Service 2: Hosting Service (Port 3001, Node.js runtime, hono.js)
  - AT Protocol Firehose listener for real-time updates
  - Serves hosted websites from local cache
  - Multi-domain routing (custom domains, wisp.place subdomains, sites subdomain)
  - Distributed locking for multi-instance coordination

  Tech Stack

  - Backend: Bun/Node.js, Elysia.js, PostgreSQL, AT Protocol SDK
  - Frontend: React 19, Tailwind CSS v4, Shadcn UI

  Key Features

  - AT Protocol Integration: Sites stored as place.wisp.fs records in user repos
  - File Processing: Validates, compresses (gzip), encodes (base64), uploads to user's PDS
  - Domain Management: wisp.place subdomains + custom BYOD domains with DNS verification
  - Real-time Sync: Firehose worker listens for site updates and caches files locally
  - Atomic Updates: Safe cache swapping without downtime
