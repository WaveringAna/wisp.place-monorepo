import postgres from 'postgres';
import type { SiteCache, SiteSettingsCache } from '@wispplace/database';
import { config } from '../config';

const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

// Read functions

export async function getSiteCache(did: string, rkey: string): Promise<SiteCache | null> {
  const result = await sql<SiteCache[]>`
    SELECT did, rkey, record_cid, file_cids, cached_at, updated_at
    FROM site_cache
    WHERE did = ${did} AND rkey = ${rkey}
    LIMIT 1
  `;
  return result[0] || null;
}

export async function getSiteSettingsCache(did: string): Promise<SiteSettingsCache | null> {
  const result = await sql<SiteSettingsCache[]>`
    SELECT did, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at
    FROM site_settings_cache
    WHERE did = ${did}
    LIMIT 1
  `;
  return result[0] || null;
}

export async function listAllSiteCaches(): Promise<SiteCache[]> {
  return await sql<SiteCache[]>`
    SELECT did, rkey, record_cid, file_cids, cached_at, updated_at
    FROM site_cache
    ORDER BY updated_at DESC
  `;
}

// Write functions

export async function upsertSiteCache(
  did: string,
  rkey: string,
  recordCid: string,
  fileCids: Record<string, string>
): Promise<void> {
  const fileCidsJson = fileCids ?? {};
  console.log(`[DB] upsertSiteCache starting for ${did}/${rkey}`);
  try {
    await sql`
      INSERT INTO site_cache (did, rkey, record_cid, file_cids, cached_at, updated_at)
      VALUES (${did}, ${rkey}, ${recordCid}, ${fileCidsJson}::jsonb, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        record_cid = EXCLUDED.record_cid,
        file_cids = EXCLUDED.file_cids,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `;
    console.log(`[DB] upsertSiteCache completed for ${did}/${rkey}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[DB] upsertSiteCache error:', { did, rkey, error: error.message, stack: error.stack });
    throw error;
  }
}

export async function deleteSiteCache(did: string, rkey: string): Promise<void> {
  await sql`DELETE FROM site_cache WHERE did = ${did} AND rkey = ${rkey}`;
}

export async function upsertSiteSettingsCache(
  did: string,
  recordCid: string,
  settings: {
    directoryListing: boolean;
    spaMode?: string;
    custom404?: string;
    indexFiles?: string[];
    cleanUrls: boolean;
    headers?: Array<{ name: string; value: string; path?: string }>;
  }
): Promise<void> {
  const directoryListing = settings.directoryListing ?? false;
  const spaMode = settings.spaMode ?? null;
  const custom404 = settings.custom404 ?? null;
  const indexFilesJson = settings.indexFiles ?? [];
  const cleanUrls = settings.cleanUrls ?? true;
  const headersJson = settings.headers ?? [];

  console.log(`[DB] upsertSiteSettingsCache starting for ${did}`, {
    directoryListing,
    spaMode,
    custom404,
    indexFiles: indexFilesJson,
    cleanUrls,
    headers: headersJson,
  });

  try {
    await sql`
      INSERT INTO site_settings_cache (did, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at)
      VALUES (
        ${did},
        ${recordCid},
        ${directoryListing},
        ${spaMode},
        ${custom404},
        ${indexFilesJson}::jsonb,
        ${cleanUrls},
        ${headersJson}::jsonb,
        EXTRACT(EPOCH FROM NOW()),
        EXTRACT(EPOCH FROM NOW())
      )
      ON CONFLICT (did)
      DO UPDATE SET
        record_cid = EXCLUDED.record_cid,
        directory_listing = EXCLUDED.directory_listing,
        spa_mode = EXCLUDED.spa_mode,
        custom_404 = EXCLUDED.custom_404,
        index_files = EXCLUDED.index_files,
        clean_urls = EXCLUDED.clean_urls,
        headers = EXCLUDED.headers,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `;
    console.log(`[DB] upsertSiteSettingsCache completed for ${did}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[DB] upsertSiteSettingsCache error:', { did, error: error.message, stack: error.stack });
    throw error;
  }
}

export async function deleteSiteSettingsCache(did: string): Promise<void> {
  await sql`DELETE FROM site_settings_cache WHERE did = ${did}`;
}

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
  console.log('[DB] Database connections closed');
}

export { sql };
