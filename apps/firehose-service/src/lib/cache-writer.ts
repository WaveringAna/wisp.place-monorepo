/**
 * Cache writer - downloads blobs from PDS and writes to S3
 * Handles incremental updates by comparing CIDs
 */

import type { Record as WispFsRecord, Directory, Entry, File } from '@wispplace/lexicons/types/place/wisp/fs';
import type { Record as SubfsRecord } from '@wispplace/lexicons/types/place/wisp/subfs';
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings';
import { safeFetchJson, safeFetchBlob } from '@wispplace/safe-fetch';
import { extractBlobCid, getPdsForDid } from '@wispplace/atproto-utils';
import { collectFileCidsFromEntries, countFilesInDirectory, normalizeFileCids } from '@wispplace/fs-utils';
import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression';
import { MAX_BLOB_SIZE, MAX_FILE_COUNT, MAX_SITE_SIZE } from '@wispplace/constants';
import { createLogger } from '@wispplace/observability';
import { writeFile, deleteFile, listFiles } from './storage';
import { getSiteCache, upsertSiteCache, deleteSiteCache, upsertSiteSettingsCache, deleteSiteSettingsCache } from './db';
import { rewriteHtmlPaths, isHtmlFile } from './html-rewriter';
import { gunzipSync } from 'zlib';
import { publishCacheInvalidation } from './cache-invalidation';

const logger = createLogger('firehose-service');

/**
 * Fetch a site record from the PDS
 */
export async function fetchSiteRecord(did: string, rkey: string): Promise<{ record: WispFsRecord; cid: string } | null> {
  try {
    const pdsEndpoint = await getPdsForDid(did);
    if (!pdsEndpoint) {
      logger.error('Failed to get PDS endpoint for DID', undefined, { did, rkey });
      return null;
    }

    const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.fs&rkey=${encodeURIComponent(rkey)}`;
    const data = await safeFetchJson(url);

    return {
      record: data.value as WispFsRecord,
      cid: data.cid || ''
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('HTTP 404') || errorMsg.includes('Not Found')) {
      logger.info('Site record not found', { did, rkey });
    } else {
      logger.error('Failed to fetch site record', err, { did, rkey });
    }
    return null;
  }
}

/**
 * Fetch a settings record from the PDS
 */
export async function fetchSettingsRecord(
  did: string,
  rkey: string,
  pdsEndpoint?: string
): Promise<{ record: WispSettings; cid: string } | null> {
  try {
    const endpoint = pdsEndpoint ?? await getPdsForDid(did);
    if (!endpoint) {
      logger.error('Failed to get PDS endpoint for DID (settings)', undefined, { did, rkey });
      return null;
    }

    const url = `${endpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.settings&rkey=${encodeURIComponent(rkey)}`;
    const data = await safeFetchJson(url);

    return {
      record: data.value as WispSettings,
      cid: data.cid || ''
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('HTTP 404') || errorMsg.includes('Not Found')) {
      logger.info('Settings record not found', { did, rkey });
    } else {
      logger.error('Failed to fetch settings record', err, { did, rkey });
    }
    return null;
  }
}

/**
 * Fetch a subfs record from the PDS
 */
async function fetchSubfsRecord(uri: string, pdsEndpoint: string): Promise<SubfsRecord | null> {
  try {
    const parts = uri.replace('at://', '').split('/');
    if (parts.length < 3) return null;

    const did = parts[0] || '';
    const collection = parts[1] || '';
    const rkey = parts[2] || '';

    const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
    const response = await safeFetchJson(url);

    return response?.value as SubfsRecord || null;
  } catch {
    return null;
  }
}

/**
 * Extract all subfs URIs from a directory tree
 */
function extractSubfsUris(directory: Directory, currentPath: string = ''): Array<{ uri: string; path: string }> {
  const uris: Array<{ uri: string; path: string }> = [];

  for (const entry of directory.entries) {
    const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

    if ('type' in entry.node) {
      if (entry.node.type === 'subfs') {
        const subfsNode = entry.node as any;
        if (subfsNode.subject) {
          uris.push({ uri: subfsNode.subject, path: fullPath });
        }
      } else if (entry.node.type === 'directory') {
        const subUris = extractSubfsUris(entry.node as Directory, fullPath);
        uris.push(...subUris);
      }
    }
  }

  return uris;
}

/**
 * Expand subfs nodes in a directory tree
 */
export async function expandSubfsNodes(
  directory: Directory,
  pdsEndpoint: string,
  depth: number = 0,
  subfsCache: Map<string, SubfsRecord | null> = new Map()
): Promise<Directory> {
  const MAX_DEPTH = 10;

  if (depth >= MAX_DEPTH) {
    logger.error('Max subfs expansion depth reached');
    return directory;
  }

  const subfsUris = extractSubfsUris(directory);
  if (subfsUris.length === 0) return directory;

  // Fetch uncached subfs records
  const uncachedUris = subfsUris.filter(({ uri }) => !subfsCache.has(uri));
  if (uncachedUris.length > 0) {
    logger.info(`Fetching ${uncachedUris.length} subfs records`, { depth });
    const fetchedRecords = await Promise.all(
      uncachedUris.map(async ({ uri }) => {
        const record = await fetchSubfsRecord(uri, pdsEndpoint);
        return { uri, record };
      })
    );
    for (const { uri, record } of fetchedRecords) {
      subfsCache.set(uri, record);
    }
  }

  // Build map of path -> entries
  const subfsMap = new Map<string, Entry[]>();
  for (const { uri, path } of subfsUris) {
    const record = subfsCache.get(uri);
    if (record?.root?.entries) {
      subfsMap.set(path, record.root.entries as unknown as Entry[]);
    }
  }

  // Replace subfs nodes
  function replaceSubfsInEntries(entries: Entry[], currentPath: string = ''): Entry[] {
    const result: Entry[] = [];

    for (const entry of entries) {
      const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      const node = entry.node;

      if ('type' in node && node.type === 'subfs') {
        const subfsNode = node as any;
        const isFlat = subfsNode.flat !== false;
        const subfsEntries = subfsMap.get(fullPath);

        if (subfsEntries) {
          if (isFlat) {
            const processedEntries = replaceSubfsInEntries(subfsEntries, currentPath);
            result.push(...processedEntries);
          } else {
            const processedEntries = replaceSubfsInEntries(subfsEntries, fullPath);
            const directoryNode: Directory = { type: 'directory', entries: processedEntries };
            result.push({ name: entry.name, node: directoryNode as any });
          }
        } else {
          result.push(entry);
        }
      } else if ('type' in node && node.type === 'directory' && 'entries' in node) {
        result.push({
          ...entry,
          node: { ...node, entries: replaceSubfsInEntries(node.entries, fullPath) }
        });
      } else {
        result.push(entry);
      }
    }

    return result;
  }

  const partiallyExpanded = {
    ...directory,
    entries: replaceSubfsInEntries(directory.entries)
  };

  return expandSubfsNodes(partiallyExpanded, pdsEndpoint, depth + 1, subfsCache);
}

/**
 * Calculate total blob size from directory tree
 */
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

interface FileInfo {
  path: string;
  cid: string;
  blob: any;
  encoding?: 'gzip';
  mimeType?: string;
  base64?: boolean;
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

function looksLikeBase64(content: Uint8Array): boolean {
  if (content.length === 0) return false;
  let nonWhitespace = 0;
  for (const byte of content) {
    const char = byte;
    if (char === 0x0a || char === 0x0d || char === 0x20 || char === 0x09) {
      continue;
    }
    nonWhitespace++;
    const isBase64Char =
      (char >= 0x41 && char <= 0x5a) || // A-Z
      (char >= 0x61 && char <= 0x7a) || // a-z
      (char >= 0x30 && char <= 0x39) || // 0-9
      char === 0x2b || // +
      char === 0x2f || // /
      char === 0x3d;   // =
    if (!isBase64Char) return false;
  }

  // Base64 length should be divisible by 4 (ignoring whitespace)
  return nonWhitespace % 4 === 0;
}

function tryDecodeBase64(content: Uint8Array): Uint8Array | null {
  if (!looksLikeBase64(content)) return null;
  const base64String = new TextDecoder().decode(content).replace(/\s+/g, '');
  try {
    return Buffer.from(base64String, 'base64');
  } catch {
    return null;
  }
}

/**
 * Collect file info from directory entries
 */
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

/**
 * Download a blob and write to S3
 */
async function downloadAndWriteBlob(
  did: string,
  rkey: string,
  file: FileInfo,
  pdsEndpoint: string
): Promise<void> {
  const blobUrl = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(file.cid)}`;

  logger.debug(`Downloading ${file.path}`);

  let content = await safeFetchBlob(blobUrl, { maxSize: MAX_BLOB_SIZE, timeout: 300000 });
  let encoding = file.encoding;

  // Decode base64 if needed
  if (file.base64) {
    const textDecoder = new TextDecoder();
    const base64String = textDecoder.decode(content);
    content = Buffer.from(base64String, 'base64');
  } else if (isTextLikeMime(file.mimeType, file.path)) {
    // Heuristic fallback: some records omit base64 flag but content is base64 text
    const decoded = tryDecodeBase64(content);
    if (decoded) {
      logger.warn(`Decoded base64 fallback for ${file.path} (base64 flag missing)`);
      content = decoded;
    }
  }

  // Decompress if needed and shouldn't stay compressed
  const shouldStayCompressed = shouldCompressMimeType(file.mimeType);

  if (encoding === 'gzip' && !shouldStayCompressed && content.length >= 2 &&
      content[0] === 0x1f && content[1] === 0x8b) {
    try {
      content = gunzipSync(content);
      encoding = undefined;
    } catch (error) {
      logger.error(`Failed to decompress ${file.path}, storing gzipped`, error);
    }
  } else if (encoding === 'gzip' && content.length >= 2 &&
      !(content[0] === 0x1f && content[1] === 0x8b)) {
    // If marked gzip but doesn't look gzipped, attempt base64 decode and retry
    const decoded = tryDecodeBase64(content);
    if (decoded && decoded.length >= 2 && decoded[0] === 0x1f && decoded[1] === 0x8b) {
      logger.warn(`Decoded base64+gzip fallback for ${file.path}`);
      try {
        content = gunzipSync(decoded);
        encoding = undefined;
      } catch (error) {
        logger.error(`Failed to decompress base64+gzip fallback for ${file.path}, storing gzipped`, error);
        content = decoded;
      }
    }
  }

  // If encoding is missing but data looks gzipped for a text-like file, mark it
  if (!encoding && isTextLikeMime(file.mimeType, file.path) && content.length >= 2 &&
      content[0] === 0x1f && content[1] === 0x8b) {
    encoding = 'gzip';
  }

  // Build storage key
  const key = `${did}/${rkey}/${file.path}`;

  // Build metadata
  const metadata: Record<string, string> = {};
  if (encoding) metadata.encoding = encoding;
  if (file.mimeType) metadata.mimeType = file.mimeType;

  // Write original file to S3
  await writeFile(key, content, metadata);

  // If HTML, also write rewritten version
  if (isHtmlFile(file.path)) {
    const basePath = `/${did}/${rkey}/`;
    let rewriteSource = content;
    if (encoding === 'gzip' && content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b) {
      try {
        rewriteSource = gunzipSync(content);
      } catch (error) {
        logger.error(`Failed to decompress ${file.path} for rewrite, using raw content`, error);
      }
    }

    const htmlString = new TextDecoder().decode(rewriteSource);
    const rewritten = rewriteHtmlPaths(htmlString, basePath, file.path);
    const rewrittenContent = new TextEncoder().encode(rewritten);

    const rewrittenKey = `${did}/${rkey}/.rewritten/${file.path}`;
    await writeFile(rewrittenKey, rewrittenContent, { mimeType: 'text/html' });
    logger.debug(`Wrote rewritten HTML: ${rewrittenKey}`);
  }

  logger.debug(`Stored ${file.path} (${content.length} bytes)`);
}

/**
 * Handle a site create/update event
 */
export async function handleSiteCreateOrUpdate(
  did: string,
  rkey: string,
  record: WispFsRecord,
  recordCid: string,
  options?: {
    forceRewriteHtml?: boolean;
    skipInvalidation?: boolean;
    forceDownload?: boolean;
  }
): Promise<void> {
  const forceRewriteHtml = options?.forceRewriteHtml === true;
  const forceDownload = options?.forceDownload === true;
  logger.info(`Processing site ${did}/${rkey}`, {
    recordCid,
    forceRewriteHtml,
    forceDownload,
  });

  if (!record.root?.entries) {
    logger.error('Invalid record structure');
    return;
  }

  // Get PDS endpoint
  const pdsEndpoint = await getPdsForDid(did);
  if (!pdsEndpoint) {
    logger.error('Could not resolve PDS', undefined, { did });
    return;
  }

  // Expand subfs nodes
  const expandedRoot = await expandSubfsNodes(record.root, pdsEndpoint);

  // Validate limits
  const fileCount = countFilesInDirectory(expandedRoot);
  if (fileCount > MAX_FILE_COUNT) {
    logger.error(`Site exceeds file limit: ${fileCount} > ${MAX_FILE_COUNT}`);
    return;
  }

  const totalSize = calculateTotalBlobSize(expandedRoot);
  if (totalSize > MAX_SITE_SIZE) {
    logger.error(`Site exceeds size limit: ${totalSize} > ${MAX_SITE_SIZE}`);
    return;
  }

  // Collect new file CIDs
  const newFileCids: Record<string, string> = {};
  collectFileCidsFromEntries(expandedRoot.entries, '', newFileCids);

  // Get existing cache from DB
  const existing = await getSiteCache(did, rkey);
  const rawFileCids = existing?.file_cids as unknown;
  const normalizedFileCids = normalizeFileCids(rawFileCids);
  const oldFileCids = normalizedFileCids.value;
  if (normalizedFileCids.source === 'string-invalid' || normalizedFileCids.source === 'other') {
    logger.warn('Existing file_cids had unexpected shape; treating as empty', {
      did,
      rkey,
      type: Array.isArray(rawFileCids) ? 'array' : typeof rawFileCids,
    });
  }

  // Compare CIDs to determine what to download/delete
  const newFiles = collectFileInfo(expandedRoot.entries);
  const filesToDownload: FileInfo[] = [];
  const pathsToDelete: string[] = [];

  // Find new or changed files
  for (const file of newFiles) {
    const shouldForceRewrite = forceRewriteHtml && isHtmlFile(file.path);
    if (forceDownload || oldFileCids[file.path] !== file.cid || shouldForceRewrite) {
      filesToDownload.push(file);
    }
  }

  // Find deleted files
  for (const oldPath of Object.keys(oldFileCids)) {
    if (!(oldPath in newFileCids)) {
      pathsToDelete.push(oldPath);
    }
  }

  logger.info(`Files unchanged: ${newFiles.length - filesToDownload.length}, to download: ${filesToDownload.length}, to delete: ${pathsToDelete.length}`);

  // Download new/changed files (with concurrency limit)
  const DOWNLOAD_CONCURRENCY = 20;
  for (let i = 0; i < filesToDownload.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = filesToDownload.slice(i, i + DOWNLOAD_CONCURRENCY);
    await Promise.allSettled(
      batch.map(file => downloadAndWriteBlob(did, rkey, file, pdsEndpoint))
    );
  }

  // Delete removed files (both original and rewritten) with batching
  if (pathsToDelete.length > 0) {
    const keysToDelete: string[] = [];
    for (const path of pathsToDelete) {
      keysToDelete.push(`${did}/${rkey}/${path}`);
      if (isHtmlFile(path)) {
        keysToDelete.push(`${did}/${rkey}/.rewritten/${path}`);
      }
    }

    const DELETE_CONCURRENCY = 50;
    for (let i = 0; i < keysToDelete.length; i += DELETE_CONCURRENCY) {
      const batch = keysToDelete.slice(i, i + DELETE_CONCURRENCY);
      await Promise.allSettled(batch.map(key => deleteFile(key)));
    }
  }

  // Update DB with new CIDs
  logger.debug(`About to upsert site cache for ${did}/${rkey}`);
  await upsertSiteCache(did, rkey, recordCid, newFileCids);
  logger.debug(`Updated site cache for ${did}/${rkey} with record CID ${recordCid}`);

  // Backfill settings if a record exists for this rkey
  const settingsRecord = await fetchSettingsRecord(did, rkey, pdsEndpoint);
  if (settingsRecord) {
    await handleSettingsUpdate(did, rkey, settingsRecord.record, settingsRecord.cid, {
      skipInvalidation: options?.skipInvalidation,
    });
  }

  // Notify hosting-service to invalidate its local caches
  // (skip for revalidate/backfill since hosting-service already has the files locally)
  if (!options?.skipInvalidation) {
    await publishCacheInvalidation(did, rkey, 'update');
  }

  logger.info(`Successfully cached site ${did}/${rkey}`);
}

/**
 * Handle a site delete event
 */
export async function handleSiteDelete(did: string, rkey: string): Promise<void> {
  logger.info(`Deleting site ${did}/${rkey}`);

  // List all files for this site and delete them
  const prefix = `${did}/${rkey}/`;
  const keys = await listFiles(prefix);

  for (const key of keys) {
    await deleteFile(key);
  }

  // Delete from DB
  await deleteSiteCache(did, rkey);

  // Notify hosting-service to invalidate its local caches
  await publishCacheInvalidation(did, rkey, 'delete');

  logger.info(`Deleted site ${did}/${rkey} (${keys.length} files)`);
}

/**
 * Handle settings create/update event
 */
export async function handleSettingsUpdate(
  did: string,
  rkey: string,
  settings: WispSettings,
  recordCid: string,
  options?: { skipInvalidation?: boolean }
): Promise<void> {
  logger.info(`Updating settings for ${did}/${rkey}`);

  await upsertSiteSettingsCache(did, rkey, recordCid, {
    directoryListing: settings.directoryListing,
    spaMode: settings.spaMode,
    custom404: settings.custom404,
    indexFiles: settings.indexFiles,
    cleanUrls: settings.cleanUrls,
    headers: settings.headers,
  });

  // Notify hosting-service to invalidate its local caches (redirect rules depend on settings)
  if (!options?.skipInvalidation) {
    await publishCacheInvalidation(did, rkey, 'settings');
  }
}

/**
 * Handle settings delete event
 */
export async function handleSettingsDelete(did: string, rkey: string): Promise<void> {
  logger.info(`Deleting settings for ${did}/${rkey}`);
  await deleteSiteSettingsCache(did, rkey);

  // Notify hosting-service to invalidate its local caches
  await publishCacheInvalidation(did, rkey, 'settings');
}
