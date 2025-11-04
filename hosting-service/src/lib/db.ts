import postgres from 'postgres';

const sql = postgres(
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp',
  {
    max: 10,
    idle_timeout: 20,
  }
);

export interface DomainLookup {
  did: string;
  rkey: string | null;
}

export interface CustomDomainLookup {
  id: string;
  domain: string;
  did: string;
  rkey: string | null;
  verified: boolean;
}

// In-memory cache with TTL
interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

class SimpleCache<T> {
  private cache = new Map<string, CacheEntry<T>>();

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set(key: string, data: T): void {
    this.cache.set(key, {
      data,
      expiry: Date.now() + CACHE_TTL_MS,
    });
  }

  // Periodic cleanup to prevent memory leaks
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiry) {
        this.cache.delete(key);
      }
    }
  }
}

// Create cache instances
const wispDomainCache = new SimpleCache<DomainLookup | null>();
const customDomainCache = new SimpleCache<CustomDomainLookup | null>();
const customDomainHashCache = new SimpleCache<CustomDomainLookup | null>();

// Run cleanup every 5 minutes
setInterval(() => {
  wispDomainCache.cleanup();
  customDomainCache.cleanup();
  customDomainHashCache.cleanup();
}, 5 * 60 * 1000);

export async function getWispDomain(domain: string): Promise<DomainLookup | null> {
  const key = domain.toLowerCase();

  // Check cache first
  const cached = wispDomainCache.get(key);
  if (cached !== null) {
    return cached;
  }

  // Query database
  const result = await sql<DomainLookup[]>`
    SELECT did, rkey FROM domains WHERE domain = ${key} LIMIT 1
  `;
  const data = result[0] || null;

  // Store in cache
  wispDomainCache.set(key, data);

  return data;
}

export async function getCustomDomain(domain: string): Promise<CustomDomainLookup | null> {
  const key = domain.toLowerCase();

  // Check cache first
  const cached = customDomainCache.get(key);
  if (cached !== null) {
    return cached;
  }

  // Query database
  const result = await sql<CustomDomainLookup[]>`
    SELECT id, domain, did, rkey, verified FROM custom_domains
    WHERE domain = ${key} AND verified = true LIMIT 1
  `;
  const data = result[0] || null;

  // Store in cache
  customDomainCache.set(key, data);

  return data;
}

export async function getCustomDomainByHash(hash: string): Promise<CustomDomainLookup | null> {
  // Check cache first
  const cached = customDomainHashCache.get(hash);
  if (cached !== null) {
    return cached;
  }

  // Query database
  const result = await sql<CustomDomainLookup[]>`
    SELECT id, domain, did, rkey, verified FROM custom_domains
    WHERE id = ${hash} AND verified = true LIMIT 1
  `;
  const data = result[0] || null;

  // Store in cache
  customDomainHashCache.set(hash, data);

  return data;
}

export async function upsertSite(did: string, rkey: string, displayName?: string) {
  try {
    // Only set display_name if provided (not undefined/null/empty)
    const cleanDisplayName = displayName && displayName.trim() ? displayName.trim() : null;

    await sql`
      INSERT INTO sites (did, rkey, display_name, created_at, updated_at)
      VALUES (${did}, ${rkey}, ${cleanDisplayName}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        display_name = CASE
          WHEN EXCLUDED.display_name IS NOT NULL THEN EXCLUDED.display_name
          ELSE sites.display_name
        END,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `;
  } catch (err) {
    console.error('Failed to upsert site', err);
  }
}

/**
 * Generate a numeric lock ID from a string key
 * PostgreSQL advisory locks use bigint (64-bit signed integer)
 */
function stringToLockId(key: string): bigint {
  let hash = 0n;
  for (let i = 0; i < key.length; i++) {
    const char = BigInt(key.charCodeAt(i));
    hash = ((hash << 5n) - hash + char) & 0x7FFFFFFFFFFFFFFFn; // Keep within signed int64 range
  }
  return hash;
}

/**
 * Acquire a distributed lock using PostgreSQL advisory locks
 * Returns true if lock was acquired, false if already held by another instance
 * Lock is automatically released when the transaction ends or connection closes
 */
export async function tryAcquireLock(key: string): Promise<boolean> {
  const lockId = stringToLockId(key);

  try {
    const result = await sql`SELECT pg_try_advisory_lock(${lockId}) as acquired`;
    return result[0]?.acquired === true;
  } catch (err) {
    console.error('Failed to acquire lock', { key, error: err });
    return false;
  }
}

/**
 * Release a distributed lock
 */
export async function releaseLock(key: string): Promise<void> {
  const lockId = stringToLockId(key);

  try {
    await sql`SELECT pg_advisory_unlock(${lockId})`;
  } catch (err) {
    console.error('Failed to release lock', { key, error: err });
  }
}

export { sql };
