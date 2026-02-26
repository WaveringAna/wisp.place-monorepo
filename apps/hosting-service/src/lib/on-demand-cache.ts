/**
 * On-demand site caching for the hosting service
 *
 * When a request hits a site that is completely missing (no DB entry, no files),
 * this module fetches the site record from the PDS, downloads all blobs,
 * writes them to local storage (hot + warm tiers), and updates the DB.
 *
 * This gives immediate serving capability. A revalidate is also enqueued
 * so the firehose-service backfills S3 (cold tier).
 */

import type { Record as WispFsRecord, Directory, Entry, File } from '@wispplace/lexicons/types/place/wisp/fs';
import { safeFetchJson, safeFetchBlob } from '@wispplace/safe-fetch';
import { extractBlobCid, getPdsForDid } from '@wispplace/atproto-utils';
import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression';
import { collectFileCidsFromEntries, countFilesInDirectory } from '@wispplace/fs-utils';
import { MAX_BLOB_SIZE, MAX_FILE_COUNT, MAX_SITE_SIZE, MAX_SITE_SIZE_SUPPORTER } from '@wispplace/constants';
import { expandSubfsNodes } from './utils';
import { storage } from './storage';
import { upsertSiteCache, tryAcquireLock, releaseLock, isSupporter } from './db';
import { enqueueRevalidate } from './revalidate-queue';
import { gunzipSync } from 'zlib';
import { createLogger } from '@wispplace/observability';

const logger = createLogger('on-demand-cache');

// Track in-flight fetches to avoid duplicate work
const inFlightFetches = new Map<string, Promise<boolean>>();

interface FileInfo {
  path: string;
  cid: string;
  blob: any;
  encoding?: 'gzip';
  mimeType?: string;
  base64?: boolean;
}

/**
 * Attempt to fetch and cache a completely missing site on-demand.
 * Returns true if the site was successfully cached, false otherwise.
 *
 * Uses a distributed lock (pg advisory lock) to prevent multiple
 * hosting-service instances from fetching the same site simultaneously.
 */
export async function fetchAndCacheSite(did: string, rkey: string): Promise<boolean> {
  const key = `${did}:${rkey}`;

  // Check if there's already an in-flight fetch for this site
  const existing = inFlightFetches.get(key);
  if (existing) {
    return existing;
  }

  const fetchPromise = doFetchAndCache(did, rkey);
  inFlightFetches.set(key, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    inFlightFetches.delete(key);
  }
}

async function doFetchAndCache(did: string, rkey: string): Promise<boolean> {
  const lockKey = `on-demand-cache:${did}:${rkey}`;

  // Try to acquire a distributed lock
  const acquired = await tryAcquireLock(lockKey);
  if (!acquired) {
    logger.debug('Lock not acquired, another instance is handling it', { did, rkey });
    return false;
  }

  try {
    logger.info('Fetching missing site', { did, rkey });

    // Fetch site record from PDS
    const pdsEndpoint = await getPdsForDid(did);
    if (!pdsEndpoint) {
      logger.error('Could not resolve PDS', { did });
      return false;
    }

    const recordUrl = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.fs&rkey=${encodeURIComponent(rkey)}`;

    let data: any;
    try {
      data = await safeFetchJson(recordUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('HTTP 404') || msg.includes('Not Found')) {
        logger.info('Site record not found on PDS', { did, rkey });
      } else {
        logger.error('Failed to fetch site record', { did, rkey, error: msg });
      }
      return false;
    }

    const record = data.value as WispFsRecord;
    const recordCid = data.cid || '';

    if (!record?.root?.entries) {
      logger.error('Invalid record structure', { did, rkey });
      return false;
    }

    // Expand subfs nodes
    const expandedRoot = await expandSubfsNodes(record.root, pdsEndpoint);

    // Validate limits
    const fileCount = countFilesInDirectory(expandedRoot);
    if (fileCount > MAX_FILE_COUNT) {
      logger.error('Site exceeds file limit', { did, rkey, fileCount, maxFileCount: MAX_FILE_COUNT });
      return false;
    }

    const totalSize = calculateTotalBlobSize(expandedRoot);
    const sizeLimit = await isSupporter(did) ? MAX_SITE_SIZE_SUPPORTER : MAX_SITE_SIZE;
    if (totalSize > sizeLimit) {
      logger.error('Site exceeds size limit', { did, rkey, totalSize, sizeLimit });
      return false;
    }

    // Collect files
    const files = collectFileInfo(expandedRoot.entries);

    // Collect file CIDs for DB
    const fileCids: Record<string, string> = {};
    collectFileCidsFromEntries(expandedRoot.entries, '', fileCids);

    // Download and write all files to local storage (hot + warm tiers)
    const CONCURRENCY = 10;
    let downloaded = 0;
    let failed = 0;

    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(file => downloadAndWriteBlob(did, rkey, file, pdsEndpoint))
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          downloaded++;
        } else {
          failed++;
          logger.error('Failed to download blob', { did, rkey, error: result.reason });
        }
      }
    }

    logger.info('Downloaded files', { did, rkey, downloaded, failed });

    // Update DB with file CIDs so future storage misses can be detected
    await upsertSiteCache(did, rkey, recordCid, fileCids);

    // Enqueue revalidate so firehose-service backfills S3 (cold tier)
    await enqueueRevalidate(did, rkey, `storage-miss:on-demand`);

    logger.info('Successfully cached site', { did, rkey, downloaded });
    return downloaded > 0;
  } catch (err) {
    logger.error('Error caching site', { did, rkey, error: err });
    return false;
  } finally {
    await releaseLock(lockKey);
  }
}

function calculateTotalBlobSize(directory: Directory): number {
  let totalSize = 0;

  function sumBlobSizes(entries: Entry[]) {
    for (const entry of entries) {
      const node = entry.node;
      if ('type' in node && node.type === 'directory' && 'entries' in node) {
        sumBlobSizes(node.entries);
      } else if ('type' in node && node.type === 'file' && 'blob' in node) {
        const fileNode = node as File;
        totalSize += (fileNode.blob as any)?.size || 0;
      }
    }
  }

  sumBlobSizes(directory.entries);
  return totalSize;
}

function collectFileInfo(entries: Entry[], pathPrefix: string = ''): FileInfo[] {
  const files: FileInfo[] = [];

  for (const entry of entries) {
    const currentPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
    const node = entry.node;

    if ('type' in node && node.type === 'directory' && 'entries' in node) {
      files.push(...collectFileInfo(node.entries, currentPath));
    } else if ('type' in node && node.type === 'file' && 'blob' in node) {
      const fileNode = node as File;
      const cid = extractBlobCid(fileNode.blob);
      if (cid) {
        files.push({
          path: currentPath,
          cid,
          blob: fileNode.blob,
          encoding: fileNode.encoding,
          mimeType: fileNode.mimeType,
          base64: fileNode.base64,
        });
      }
    }
  }

  return files;
}

async function downloadAndWriteBlob(
  did: string,
  rkey: string,
  file: FileInfo,
  pdsEndpoint: string
): Promise<void> {
  const blobUrl = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(file.cid)}`;

  let content = await safeFetchBlob(blobUrl, { maxSize: MAX_BLOB_SIZE, timeout: 300000 });
  let encoding = file.encoding;

  // Decode base64 if flagged
  if (file.base64) {
    const base64String = new TextDecoder().decode(content);
    content = Buffer.from(base64String, 'base64');
  }

  // Decompress if needed and shouldn't stay compressed
  const shouldStayCompressed = shouldCompressMimeType(file.mimeType);

  if (encoding === 'gzip' && !shouldStayCompressed && content.length >= 2 &&
      content[0] === 0x1f && content[1] === 0x8b) {
    try {
      content = gunzipSync(content);
      encoding = undefined;
    } catch {
      // Keep gzipped if decompression fails
    }
  }

  // If encoding is missing but data looks gzipped for a text-like file, mark it
  if (!encoding && isTextLikeMime(file.mimeType, file.path) && content.length >= 2 &&
      content[0] === 0x1f && content[1] === 0x8b) {
    encoding = 'gzip';
  }

  // Build storage key and metadata
  const key = `${did}/${rkey}/${file.path}`;
  const metadata: Record<string, string> = {};
  if (encoding) metadata.encoding = encoding;
  if (file.mimeType) metadata.mimeType = file.mimeType;

  // Write to hot + warm tiers only (cold/S3 is read-only in hosting-service,
  // firehose-service will backfill via revalidate)
  await storage.set(key as any, content as any, {
    metadata,
    skipTiers: [],
  });
}

function isTextLikeMime(mimeType?: string, path?: string): boolean {
  if (mimeType) {
    if (mimeType === 'text/html') return true;
    if (mimeType === 'text/css') return true;
    if (mimeType === 'text/javascript') return true;
    if (mimeType === 'application/javascript') return true;
    if (mimeType === 'application/json') return true;
    if (mimeType === 'application/xml') return true;
    if (mimeType === 'image/svg+xml') return true;
  }

  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith('.html') ||
    lower.endsWith('.htm') ||
    lower.endsWith('.css') ||
    lower.endsWith('.js') ||
    lower.endsWith('.json') ||
    lower.endsWith('.xml') ||
    lower.endsWith('.svg');
}
