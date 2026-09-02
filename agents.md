The project is wisp.place. It is a static site hoster built on top of the AT Protocol. The overall basis of the project is that users upload site assets to their PDS as blobs, and creates a manifest record listing every blob as well as site name. The hosting service then catches events relating to the site (create, read, upload, delete) and handles them appropriately. 

The lexicons look like this:
```typescript
//place.wisp.fs
interface Main {
  $type: 'place.wisp.fs'
  site: string
  root: Directory
  fileCount?: number
  createdAt: string
}

interface File {
  $type?: 'place.wisp.fs#file'
  type: 'file'
  blob: BlobRef
  encoding?: 'gzip'
  mimeType?: string
  base64?: boolean
}

interface Directory {
  $type?: 'place.wisp.fs#directory'
  type: 'directory'
  entries: Entry[]
}

interface Entry {
  $type?: 'place.wisp.fs#entry'
  name: string
  node: $Typed<File> | $Typed<Directory> | $Typed<Subfs> | { $type: string }
}

interface Subfs {
  $type?: 'place.wisp.fs#subfs'
  type: 'subfs'
  subject: string  // AT-URI pointing to a place.wisp.subfs record 
  flat?: boolean
}

//place.wisp.subfs
interface Main {
  $type: 'place.wisp.subfs'
  root: Directory
  fileCount?: number
  createdAt: string
}

interface File {
  $type?: 'place.wisp.subfs#file'
  type: 'file'
  blob: BlobRef
  encoding?: 'gzip'
  mimeType?: string
  base64?: boolean
}

interface Directory {
  $type?: 'place.wisp.subfs#directory'
  type: 'directory'
  entries: Entry[]
}

interface Entry {
  $type?: 'place.wisp.subfs#entry'
  name: string
  node: $Typed<File> | $Typed<Directory> | $Typed<Subfs> | { $type: string }
}

interface Subfs {
  $type?: 'place.wisp.subfs#subfs'
  type: 'subfs'
  subject: string  // AT-URI pointing to another place.wisp.subfs record
}

//place.wisp.settings
interface Main {
  $type: 'place.wisp.settings'
  directoryListing: boolean
  spaMode?: string
  custom404?: string
  indexFiles?: string[]
  cleanUrls: boolean
  headers?: CustomHeader[]
}

interface CustomHeader {
  $type?: 'place.wisp.settings#customHeader'
  name: string
  value: string
  path?: string  // Optional glob pattern
}
```

The main differences between place.wisp.fs and place.wisp.subfs:
  - place.wisp.fs has a required site field
  - place.wisp.fs#subfs has an optional flat field that place.wisp.subfs#subfs doesn't have

The project is a monorepo. The package handler it uses is bun. Please when you want to add a package, which is never unless told to, do bun add ..., please do not try to edit package.json yourself.

### Typescript Bun Workspace Layout

Bun workspaces: `packages/@wisp/*`, `apps/main-app`, `apps/hosting-service`, etc

PLEASE USE `bun check` to type check and `biome check --write` to lint.

Run tests with `bun test --isolate` (or `bun run test`, which passes it), never a
bare `bun test`. Several suites call `mock.module('../lib/db', ...)` with a partial
set of exports, and without isolation that replacement leaks into every test file
loaded afterwards: those files fail to link with a misleading
`SyntaxError: Export named '<something>' not found in module .../lib/db.ts`, and
their tests are silently skipped rather than reported as failures. Adding any new
export to `src/lib/db.ts` is enough to trigger it. `bunfig.toml` does not support
`[test] isolate`, so it has to be the CLI flag.

There are three typescript apps
**`apps/main-app`** - Main backend (Bun + Elysia)

- OAuth authentication and session management
- Site CRUD operations via PDS
- Custom domain management
- Admin database view in /admin
- React frontend in public/

**`apps/hosting-service`** - CDN static file server (Bun + Hono)
- Serves sites at `https://sites.wisp.place/{did}/{site-name}` and custom domains
- Handles redirects (`_redirects` file support) and routing logic
- Pulls sites from Tiered Storage (packages/@wispplace/tiered-storage)

**`apps/firehose-service`** - ATProto Firehose consumer (Bun or Node)
- Watches AT Protocol firehose for `place.wisp.*` record changes
- Downloads and caches site files to S3
- Backfill mode for syncing existing sites

**`apps/webhook-service`** - ATProto Webhooks service
- Watches AT Protocol firehose for `place.wisp.v2.wh` record changes and CRUDs webhooks
- Watches AT Protocol firehose for scoped aturis based on what is in place.wisp.v2.wh and POSTs them


### Shared Packages (`packages/@wisp/*`)

- **`lexicons`** - AT Protocol lexicons (`place.wisp.fs`, `place.wisp.subfs`, `place.wisp.settings`) with
  generated TypeScript types
- **`fs-utils`** - Filesystem tree building, manifest creation, subfs splitting logic
- **`atproto-utils`** - AT Protocol helpers (blob upload, record operations, CID handling)
- **`database`** - PostgreSQL schema and queries
- **`constants`** - Shared constants (limits, file patterns, default settings)
- **`observability`** - OpenTelemetry instrumentation
- **`safe-fetch`** - Wrapped fetch with timeout/retry logic
- **`tiered-storage`** - KV caching where reads bubble up from cold tier to warm/hot tier and writes bubble down from selected tier down. Streaming as well as buffering support. Used to store files in S3 cold tier as source of truth

### CLI

**`cli/`** - TypeScript CLI using commander, clack. 
- Direct PDS uploads without interacting with main-app
- Can also do the same firehose watching, caching, and serving hosting-service does, just without domain management

### Other Directories

- **`docs/`** - Astro documentation site
- **`binaries/`** - Compiled CLI binaries for distribution
