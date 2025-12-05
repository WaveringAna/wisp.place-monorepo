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

The project is a monorepo. The package handler it uses for the typescript side is Bun. For the Rust cli, it is cargo.

### Typescript Bun Workspace Layout

Bun workspaces: `packages/@wisp/*`, `apps/main-app`, `apps/hosting-service`

There are two typescript apps
**`apps/main-app`** - Main backend (Bun + Elysia)

- OAuth authentication and session management
- Site CRUD operations via PDS
- Custom domain management
- Admin database view in /admin
- React frontend in public/

**`apps/hosting-service`** - CDN static file server (Node + Hono)

- Watches AT Protocol firehose for `place.wisp.fs` record changes
- Downloads and caches site files to disk
- Serves sites at `https://sites.wisp.place/{did}/{site-name}` and custom domains
- Handles redirects (`_redirects` file support) and routing logic
- Backfill mode for syncing existing sites

### Shared Packages (`packages/@wisp/*`)

- **`lexicons`** - AT Protocol lexicons (`place.wisp.fs`, `place.wisp.subfs`, `place.wisp.settings`) with
  generated TypeScript types
- **`fs-utils`** - Filesystem tree building, manifest creation, subfs splitting logic
- **`atproto-utils`** - AT Protocol helpers (blob upload, record operations, CID handling)
- **`database`** - PostgreSQL schema and queries
- **`constants`** - Shared constants (limits, file patterns, default settings)
- **`observability`** - OpenTelemetry instrumentation
- **`safe-fetch`** - Wrapped fetch with timeout/retry logic

### CLI

**`cli/`** - Rust CLI using Jacquard (AT Protocol library)
- Direct PDS uploads without interacting with main-app
- Can also do the same firehose watching, caching, and serving hosting-service does, just without domain management

### Other Directories

- **`docs/`** - Astro documentation site
- **`binaries/`** - Compiled CLI binaries for distribution
