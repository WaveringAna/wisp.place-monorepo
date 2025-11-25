import postgres from 'postgres';
import { createHash } from 'crypto';
import type { DomainLookup, CustomDomainLookup } from '@wisp/database';

// Global cache-only mode flag (set by index.ts)
let cacheOnlyMode = false;

export function setCacheOnlyMode(enabled: boolean) {
  cacheOnlyMode = enabled;
  if (enabled) {
    console.log('[DB] Cache-only mode enabled - database writes will be skipped');
  }
}

const sql = postgres(
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp',
  {
    max: 10,
    idle_timeout: 20,
  }
);

// Domain lookup cache with TTL
const DOMAIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CachedDomain<T> {
  value: T;
  timestamp: number;
}

const domainCache = new Map<string, CachedDomain<DomainLookup | null>>();
const customDomainCache = new Map<string, CachedDomain<CustomDomainLookup | null>>();

let cleanupInterval: NodeJS.Timeout | null = null;

export function startDomainCacheCleanup() {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const now = Date.now();

    for (const [key, entry] of domainCache.entries()) {
      if (now - entry.timestamp > DOMAIN_CACHE_TTL) {
        domainCache.delete(key);
      }
    }

    for (const [key, entry] of customDomainCache.entries()) {
      if (now - entry.timestamp > DOMAIN_CACHE_TTL) {
        customDomainCache.delete(key);
      }
    }
  }, 30 * 60 * 1000); // Run every 30 minutes
}

export function stopDomainCacheCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export async function getWispDomain(domain: string): Promise<DomainLookup | null> {
  const key = domain.toLowerCase();

  // Check cache first
  const cached = domainCache.get(key);
  if (cached && Date.now() - cached.timestamp < DOMAIN_CACHE_TTL) {
    return cached.value;
  }

  // Query database
  const result = await sql<DomainLookup[]>`
    SELECT did, rkey FROM domains WHERE domain = ${key} LIMIT 1
  `;
  const data = result[0] || null;

  // Cache the result
  domainCache.set(key, { value: data, timestamp: Date.now() });

  return data;
}

export async function getCustomDomain(domain: string): Promise<CustomDomainLookup | null> {
  const key = domain.toLowerCase();

  // Check cache first
  const cached = customDomainCache.get(key);
  if (cached && Date.now() - cached.timestamp < DOMAIN_CACHE_TTL) {
    return cached.value;
  }

  // Query database
  const result = await sql<CustomDomainLookup[]>`
    SELECT id, domain, did, rkey, verified FROM custom_domains
    WHERE domain = ${key} AND verified = true LIMIT 1
  `;
  const data = result[0] || null;

  // Cache the result
  customDomainCache.set(key, { value: data, timestamp: Date.now() });

  return data;
}

export async function getCustomDomainByHash(hash: string): Promise<CustomDomainLookup | null> {
  const key = `hash:${hash}`;

  // Check cache first
  const cached = customDomainCache.get(key);
  if (cached && Date.now() - cached.timestamp < DOMAIN_CACHE_TTL) {
    return cached.value;
  }

  // Query database
  const result = await sql<CustomDomainLookup[]>`
    SELECT id, domain, did, rkey, verified FROM custom_domains
    WHERE id = ${hash} AND verified = true LIMIT 1
  `;
  const data = result[0] || null;

  // Cache the result
  customDomainCache.set(key, { value: data, timestamp: Date.now() });

  return data;
}

export async function upsertSite(did: string, rkey: string, displayName?: string) {
  // Skip database writes in cache-only mode
  if (cacheOnlyMode) {
    console.log('[DB] Skipping upsertSite (cache-only mode)', { did, rkey });
    return;
  }

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

export interface SiteRecord {
  did: string;
  rkey: string;
  display_name?: string;
}

export async function getAllSites(): Promise<SiteRecord[]> {
  try {
    const result = await sql<SiteRecord[]>`
      SELECT did, rkey, display_name FROM sites
      ORDER BY created_at DESC
    `;
    return result;
  } catch (err) {
    console.error('Failed to get all sites', err);
    return [];
  }
}

/**
 * Generate a numeric lock ID from a string key
 * PostgreSQL advisory locks use bigint (64-bit signed integer)
 */
function stringToLockId(key: string): bigint {
  const hash = createHash('sha256').update(key).digest('hex');
  // Take first 16 hex characters (64 bits) and convert to bigint
  const hashNum = BigInt('0x' + hash.substring(0, 16));
  // Keep within signed int64 range
  return hashNum & 0x7FFFFFFFFFFFFFFFn;
}

/**
 * Acquire a distributed lock using PostgreSQL advisory locks
 * Returns true if lock was acquired, false if already held by another instance
 * Lock is automatically released when the transaction ends or connection closes
 */
export async function tryAcquireLock(key: string): Promise<boolean> {
  const lockId = stringToLockId(key);

  try {
    const result = await sql`SELECT pg_try_advisory_lock(${Number(lockId)}) as acquired`;
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
    await sql`SELECT pg_advisory_unlock(${Number(lockId)})`;
  } catch (err) {
    console.error('Failed to release lock', { key, error: err });
  }
}

export { sql };
