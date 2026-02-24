import postgres from 'postgres';
import type { SiteCache, SiteRecord, SiteSettingsCache } from '@wispplace/database';
import { createLogger } from '@wispplace/observability';
import { config } from '../config';

const logger = createLogger('firehose-service');

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

export async function getSiteSettingsCache(did: string, rkey: string): Promise<SiteSettingsCache | null> {
  const result = await sql<SiteSettingsCache[]>`
    SELECT did, rkey, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at
    FROM site_settings_cache
    WHERE did = ${did} AND rkey = ${rkey}
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

export async function listAllSites(): Promise<SiteRecord[]> {
  return await sql<SiteRecord[]>`
    SELECT did, rkey, display_name, created_at, updated_at
    FROM sites
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
  logger.debug(`[DB] upsertSiteCache starting for ${did}/${rkey}`);
  try {
    await sql`
      INSERT INTO site_cache (did, rkey, record_cid, file_cids, cached_at, updated_at)
      VALUES (${did}, ${rkey}, ${recordCid}, ${sql.json(fileCids ?? {})}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        record_cid = EXCLUDED.record_cid,
        file_cids = EXCLUDED.file_cids,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `;
    logger.debug(`[DB] upsertSiteCache completed for ${did}/${rkey}`);
  } catch (err) {
    logger.error('[DB] upsertSiteCache error', err, { did, rkey });
    throw err;
  }
}

export async function deleteSiteCache(did: string, rkey: string): Promise<void> {
  await sql`DELETE FROM site_cache WHERE did = ${did} AND rkey = ${rkey}`;
}

export async function upsertSiteSettingsCache(
  did: string,
  rkey: string,
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
  const cleanUrls = settings.cleanUrls ?? true;

  const indexFiles = settings.indexFiles ?? [];
  const headers = settings.headers ?? [];

  logger.debug(`[DB] upsertSiteSettingsCache starting for ${did}/${rkey}`, {
    directoryListing,
    spaMode,
    custom404,
    indexFiles,
    cleanUrls,
    headers,
  });

  try {
    await sql`
      INSERT INTO site_settings_cache (did, rkey, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at)
      VALUES (
        ${did},
        ${rkey},
        ${recordCid},
        ${directoryListing},
        ${spaMode},
        ${custom404},
        ${sql.json(indexFiles)},
        ${cleanUrls},
        ${sql.json(headers)},
        EXTRACT(EPOCH FROM NOW()),
        EXTRACT(EPOCH FROM NOW())
      )
      ON CONFLICT (did, rkey)
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
    logger.debug(`[DB] upsertSiteSettingsCache completed for ${did}/${rkey}`);
  } catch (err) {
    logger.error('[DB] upsertSiteSettingsCache error', err, { did, rkey });
    throw err;
  }
}

export async function deleteSiteSettingsCache(did: string, rkey: string): Promise<void> {
  await sql`DELETE FROM site_settings_cache WHERE did = ${did} AND rkey = ${rkey}`;
}

export async function upsertSite(did: string, rkey: string, displayName: string): Promise<void> {
  await sql`
    INSERT INTO sites (did, rkey, display_name, created_at, updated_at)
    VALUES (${did}, ${rkey}, ${displayName}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
    ON CONFLICT (did, rkey)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      updated_at = EXTRACT(EPOCH FROM NOW())
  `;
}

export async function deleteSite(did: string, rkey: string): Promise<void> {
  await sql`DELETE FROM sites WHERE did = ${did} AND rkey = ${rkey}`;
}

export async function isSupporter(did: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM supporter WHERE did = ${did} LIMIT 1`;
  return rows.length > 0;
}

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
  logger.info('[DB] Database connections closed');
}

export { sql };
