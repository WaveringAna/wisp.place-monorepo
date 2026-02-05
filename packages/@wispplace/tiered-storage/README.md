# tiered-storage

Cascading cache that flows hot → warm → cold. Memory, disk, S3—or bring your own.

## Features

- **Cascading writes** - data flows down through all tiers
- **Bubbling reads** - check hot first, fall back to warm, then cold
- **Pluggable backends** - memory, disk, S3, or implement your own
- **Selective placement** - skip tiers for big files that don't need memory caching
- **Prefix invalidation** - `invalidate('user:')` nukes all user keys
- **Optional compression** - transparent gzip

## Install

```bash
npm install tiered-storage
```

## Example

```typescript
import { TieredStorage, MemoryStorageTier, DiskStorageTier, S3StorageTier } from 'tiered-storage'

const storage = new TieredStorage({
  tiers: {
    hot: new MemoryStorageTier({ maxSizeBytes: 100 * 1024 * 1024 }),
    warm: new DiskStorageTier({ directory: './cache' }),
    cold: new S3StorageTier({ bucket: 'my-bucket', region: 'us-east-1' }),
  },
  placementRules: [
    { pattern: '**/index.html', tiers: ['hot', 'warm', 'cold'] },
    { pattern: '**/*.{jpg,png,gif,mp4}', tiers: ['warm', 'cold'] },
    { pattern: '**', tiers: ['warm', 'cold'] },
  ],
})

// just set - rules decide where it goes
await storage.set('site:abc/index.html', indexHtml)  // → hot + warm + cold
await storage.set('site:abc/hero.png', imageData)    // → warm + cold
await storage.set('site:abc/video.mp4', videoData)   // → warm + cold

// reads bubble up from wherever it lives
const page = await storage.getWithMetadata('site:abc/index.html')
console.log(page.source) // 'hot'

const video = await storage.getWithMetadata('site:abc/video.mp4')
console.log(video.source) // 'warm'

// nuke entire site
await storage.invalidate('site:abc/')
```

Hot tier stays small and fast. Warm tier has everything. Cold tier is the source of truth.

## How it works

```
┌─────────────────────────────────────────────┐
│  Cold (S3)     - source of truth, all data  │
│  ↑                                          │
│  Warm (disk)   - everything hot has + more  │
│  ↑                                          │
│  Hot (memory)  - just the hottest stuff     │
└─────────────────────────────────────────────┘
```

Writes cascade **down**. Reads bubble **up**.

## Eviction

Items leave upper tiers through eviction or TTL expiration:

```typescript
const storage = new TieredStorage({
  tiers: {
    // hot: LRU eviction when size/count limits hit
    hot: new MemoryStorageTier({
      maxSizeBytes: 100 * 1024 * 1024,
      maxItems: 500,
    }),

    // warm: evicts when maxSizeBytes hit, policy controls which items go
    warm: new DiskStorageTier({
      directory: './cache',
      maxSizeBytes: 10 * 1024 * 1024 * 1024,
      evictionPolicy: 'lru',  // 'lru' | 'fifo' | 'size'
    }),

    // cold: never evicts, keeps everything
    cold: new S3StorageTier({ bucket: 'my-bucket', region: 'us-east-1' }),
  },
  defaultTTL: 14 * 24 * 60 * 60 * 1000, // TTL checked on read
})
```

A file that hasn't been accessed eventually gets evicted from hot (LRU), then warm (size limit + policy). Next request fetches from cold and promotes it back up.

## Placement rules

Define once which keys go where, instead of passing `skipTiers` on every `set()`:

```typescript
const storage = new TieredStorage({
  tiers: {
    hot: new MemoryStorageTier({ maxSizeBytes: 50 * 1024 * 1024 }),
    warm: new DiskStorageTier({ directory: './cache' }),
    cold: new S3StorageTier({ bucket: 'my-bucket', region: 'us-east-1' }),
  },
  placementRules: [
    // index.html goes everywhere for instant serving
    { pattern: '**/index.html', tiers: ['hot', 'warm', 'cold'] },

    // images and video skip hot
    { pattern: '**/*.{jpg,png,gif,webp,mp4}', tiers: ['warm', 'cold'] },

    // assets directory skips hot
    { pattern: 'assets/**', tiers: ['warm', 'cold'] },

    // everything else: warm + cold only
    { pattern: '**', tiers: ['warm', 'cold'] },
  ],
})

// just call set() - rules handle placement
await storage.set('site:abc/index.html', html)       // → hot + warm + cold
await storage.set('site:abc/hero.png', image)        // → warm + cold
await storage.set('site:abc/assets/font.woff', font) // → warm + cold
await storage.set('site:abc/about.html', html)       // → warm + cold
```

Rules are evaluated in order. First match wins. Cold is always included.

## API

### `storage.get(key)`

Get data. Returns `null` if missing or expired.

### `storage.getWithMetadata(key)`

Get data plus which tier served it.

### `storage.set(key, data, options?)`

Store data. Options:

```typescript
{
  ttl: 86400000,           // custom TTL
  skipTiers: ['hot'],      // skip specific tiers
  metadata: { ... },       // custom metadata
}
```

### `storage.delete(key)`

Delete from all tiers.

### `storage.invalidate(prefix)`

Delete all keys matching prefix. Returns count.

### `storage.touch(key, ttl?)`

Renew TTL.

### `storage.listKeys(prefix?)`

Async iterator over keys.

### `storage.getStats()`

Stats across all tiers.

### `storage.bootstrapHot(limit?)`

Warm up hot tier from warm tier. Run on startup.

### `storage.bootstrapWarm(options?)`

Warm up warm tier from cold tier.

## Built-in tiers

### MemoryStorageTier

```typescript
new MemoryStorageTier({
  maxSizeBytes: 100 * 1024 * 1024,
  maxItems: 1000,
})
```

LRU eviction. Fast. Single process only.

### DiskStorageTier

```typescript
new DiskStorageTier({
  directory: './cache',
  maxSizeBytes: 10 * 1024 * 1024 * 1024,
  evictionPolicy: 'lru', // or 'fifo', 'size'
})
```

Files on disk with `.meta` sidecars.

### S3StorageTier

```typescript
new S3StorageTier({
  bucket: 'data',
  metadataBucket: 'metadata',  // recommended!
  region: 'us-east-1',
})
```

Works with AWS S3, Cloudflare R2, MinIO. Use a separate metadata bucket—otherwise updating access counts requires copying entire objects.

## Custom tiers

Implement `StorageTier`:

```typescript
interface StorageTier {
  get(key: string): Promise<Uint8Array | null>
  set(key: string, data: Uint8Array, metadata: StorageMetadata): Promise<void>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  listKeys(prefix?: string): AsyncIterableIterator<string>
  deleteMany(keys: string[]): Promise<void>
  getMetadata(key: string): Promise<StorageMetadata | null>
  setMetadata(key: string, metadata: StorageMetadata): Promise<void>
  getStats(): Promise<TierStats>
  clear(): Promise<void>

  // Optional: combine get + getMetadata for better performance
  getWithMetadata?(key: string): Promise<{ data: Uint8Array; metadata: StorageMetadata } | null>
}
```

The optional `getWithMetadata` method returns both data and metadata in a single call. Implement it if your backend can fetch both efficiently (e.g., parallel I/O, single query). Falls back to separate `get()` + `getMetadata()` calls if not implemented.

## Running the demo

```bash
cp .env.example .env  # add S3 creds
bun run serve
```

Visit http://localhost:3000 to see it work. Check http://localhost:3000/admin/stats for live cache stats.

## License

MIT
