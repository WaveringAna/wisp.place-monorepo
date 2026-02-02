import type { Record as WispFsRecord, Directory, Entry, File } from '@wispplace/lexicons/types/place/wisp/fs';
import type { Record as SubfsRecord } from '@wispplace/lexicons/types/place/wisp/subfs';
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { writeFile, readFile, rename } from 'fs/promises';
import { Readable } from 'stream';
import { safeFetchJson, safeFetchBlob } from '@wispplace/safe-fetch';
import { CID } from 'multiformats';
import { extractBlobCid, resolveDid, getPdsForDid, didWebToHttps } from '@wispplace/atproto-utils';
import { sanitizePath, collectFileCidsFromEntries, countFilesInDirectory } from '@wispplace/fs-utils';
import { shouldCompressMimeType } from '@wispplace/atproto-utils/compression';
import { MAX_BLOB_SIZE, MAX_FILE_COUNT, MAX_SITE_SIZE } from '@wispplace/constants';
import { storage } from './storage';

// Re-export shared utilities for local usage and tests
export { extractBlobCid, sanitizePath, resolveDid, getPdsForDid, didWebToHttps };

const CACHE_DIR = process.env.CACHE_DIR || './cache/sites';
const CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days cache TTL

interface CacheMetadata {
  recordCid: string;
  cachedAt: number;
  did: string;
  rkey: string;
  // Map of file path to blob CID for incremental updates
  fileCids?: Record<string, string>;
  // Site settings (null = explicitly no settings, undefined = not yet checked)
  settings?: WispSettings | null;
}


export async function fetchSiteRecord(did: string, rkey: string): Promise<{ record: WispFsRecord; cid: string } | null> {
  try {
    const pdsEndpoint = await getPdsForDid(did);
    if (!pdsEndpoint) {
      console.error('[hosting-service] Failed to get PDS endpoint for DID', { did, rkey });
      return null;
    }

    const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.fs&rkey=${encodeURIComponent(rkey)}`;
    const data = await safeFetchJson(url);

    return {
      record: data.value as WispFsRecord,
      cid: data.cid || ''
    };
  } catch (err) {
    const errorCode = (err as any)?.code;
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Better error logging to distinguish between network errors and 404s
    if (errorMsg.includes('HTTP 404') || errorMsg.includes('Not Found')) {
      console.log('[hosting-service] Site record not found', { did, rkey });
    } else if (errorCode && ['ECONNRESET', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'ETIMEDOUT'].includes(errorCode)) {
      console.error('[hosting-service] Network/SSL error fetching site record (after retries)', {
        did,
        rkey,
        error: errorMsg,
        code: errorCode
      });
    } else {
      console.error('[hosting-service] Failed to fetch site record', {
        did,
        rkey,
        error: errorMsg,
        code: errorCode
      });
    }

    return null;
  }
}

export async function fetchSiteSettings(did: string, rkey: string): Promise<WispSettings | null> {
  try {
    const pdsEndpoint = await getPdsForDid(did);
    if (!pdsEndpoint) return null;

    const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.settings&rkey=${encodeURIComponent(rkey)}`;
    const data = await safeFetchJson(url);

    return data.value as WispSettings;
  } catch (err) {
    // Settings are optional, so return null if not found
    return null;
  }
}

/**
 * Calculate total size of all blobs in a directory tree from manifest metadata
 */
function calculateTotalBlobSize(directory: Directory): number {
  let totalSize = 0;

  function sumBlobSizes(entries: Entry[]) {
    for (const entry of entries) {
      const node = entry.node;

      if ('type' in node && node.type === 'directory' && 'entries' in node) {
        // Recursively sum subdirectories
        sumBlobSizes(node.entries);
      } else if ('type' in node && node.type === 'file' && 'blob' in node) {
        // Add blob size from manifest
        const fileNode = node as File;
        const blobSize = (fileNode.blob as any)?.size || 0;
        totalSize += blobSize;
      }
    }
  }

  sumBlobSizes(directory.entries);
  return totalSize;
}

/**
 * Extract all subfs URIs from a directory tree with their mount paths
 */
export function extractSubfsUris(directory: Directory, currentPath: string = ''): Array<{ uri: string; path: string }> {
  const uris: Array<{ uri: string; path: string }> = [];

  for (const entry of directory.entries) {
    const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

    if ('type' in entry.node) {
      if (entry.node.type === 'subfs') {
        // Subfs node with subject URI
        const subfsNode = entry.node as any;
        if (subfsNode.subject) {
          uris.push({ uri: subfsNode.subject, path: fullPath });
        }
      } else if (entry.node.type === 'directory') {
        // Recursively search subdirectories
        const subUris = extractSubfsUris(entry.node as Directory, fullPath);
        uris.push(...subUris);
      }
    }
  }

  return uris;
}

/**
 * Fetch a subfs record from the PDS
 */
async function fetchSubfsRecord(uri: string, pdsEndpoint: string): Promise<SubfsRecord | null> {
  try {
    // Parse URI: at://did/collection/rkey
    const parts = uri.replace('at://', '').split('/');
    if (parts.length < 3) {
      console.error('Invalid subfs URI:', uri);
      return null;
    }

    const did = parts[0] || '';
    const collection = parts[1] || '';
    const rkey = parts[2] || '';

    // Fetch the record from PDS
    const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
    const response = await safeFetchJson(url);

    if (!response || !response.value) {
      console.error('Subfs record not found:', uri);
      return null;
    }

    return response.value as SubfsRecord;
  } catch (err) {
    console.error('Failed to fetch subfs record:', uri, err);
    return null;
  }
}

/**
 * Replace subfs nodes in a directory tree with their actual content
 * Subfs entries are "merged" - their root entries are hoisted into the parent directory
 * This function is recursive - it will keep expanding until no subfs nodes remain
 * Uses a cache to avoid re-fetching the same subfs records across recursion depths
 */
export async function expandSubfsNodes(
  directory: Directory,
  pdsEndpoint: string,
  depth: number = 0,
  subfsCache: Map<string, SubfsRecord | null> = new Map()
): Promise<Directory> {
  const MAX_DEPTH = 10; // Prevent infinite loops

  if (depth >= MAX_DEPTH) {
    console.error('Max subfs expansion depth reached, stopping to prevent infinite loop');
    return directory;
  }

  // Extract all subfs URIs
  const subfsUris = extractSubfsUris(directory);

  if (subfsUris.length === 0) {
    // No subfs nodes, return as-is
    return directory;
  }

  // Filter to only URIs we haven't fetched yet
  const uncachedUris = subfsUris.filter(({ uri }) => !subfsCache.has(uri));

  if (uncachedUris.length > 0) {
    console.log(`[Depth ${depth}] Found ${subfsUris.length} subfs references, fetching ${uncachedUris.length} new records (${subfsUris.length - uncachedUris.length} cached)...`);

    // Fetch only uncached subfs records in parallel
    const fetchedRecords = await Promise.all(
      uncachedUris.map(async ({ uri }) => {
        const record = await fetchSubfsRecord(uri, pdsEndpoint);
        return { uri, record };
      })
    );

    // Add fetched records to cache
    for (const { uri, record } of fetchedRecords) {
      subfsCache.set(uri, record);
    }
  } else {
    console.log(`[Depth ${depth}] Found ${subfsUris.length} subfs references, all cached`);
  }

  // Build a map of path -> root entries to merge using the cache
  // Note: SubFS entries are compatible with FS entries at runtime
  const subfsMap = new Map<string, Entry[]>();
  for (const { uri, path } of subfsUris) {
    const record = subfsCache.get(uri);
    if (record && record.root && record.root.entries) {
      subfsMap.set(path, record.root.entries as unknown as Entry[]);
    }
  }

  // Replace subfs nodes by merging their root entries into the parent directory
  function replaceSubfsInEntries(entries: Entry[], currentPath: string = ''): Entry[] {
    const result: Entry[] = [];

    for (const entry of entries) {
      const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      const node = entry.node;

      if ('type' in node && node.type === 'subfs') {
        // Check if this is a flat merge or subdirectory merge (default to flat if not specified)
        const subfsNode = node as any;
        const isFlat = subfsNode.flat !== false; // Default to true
        const subfsEntries = subfsMap.get(fullPath);

        if (subfsEntries) {
          console.log(`[Depth ${depth}] Merging subfs node at ${fullPath} (${subfsEntries.length} entries, flat: ${isFlat})`);

          if (isFlat) {
            // Flat merge: hoist entries directly into parent directory
            const processedEntries = replaceSubfsInEntries(subfsEntries, currentPath);
            result.push(...processedEntries);
          } else {
            // Subdirectory merge: create a directory with the subfs node's name
            const processedEntries = replaceSubfsInEntries(subfsEntries, fullPath);
            const directoryNode: Directory = {
              type: 'directory',
              entries: processedEntries
            };
            result.push({
              name: entry.name,
              node: directoryNode as any  // Type assertion needed due to lexicon type complexity
            });
          }
        } else {
          // If not in map yet, preserve the subfs node for next recursion depth
          console.log(`[Depth ${depth}] Subfs at ${fullPath} not yet fetched, preserving for next iteration`);
          result.push(entry);
        }
      } else if ('type' in node && node.type === 'directory' && 'entries' in node) {
        // Recursively process subdirectories
        result.push({
          ...entry,
          node: {
            ...node,
            entries: replaceSubfsInEntries(node.entries, fullPath)
          }
        });
      } else {
        // Regular file entry
        result.push(entry);
      }
    }

    return result;
  }

  const partiallyExpanded = {
    ...directory,
    entries: replaceSubfsInEntries(directory.entries)
  };

  // Recursively expand any remaining subfs nodes (e.g., nested subfs inside parent subfs)
  // Pass the cache to avoid re-fetching records
  return expandSubfsNodes(partiallyExpanded, pdsEndpoint, depth + 1, subfsCache);
}


export async function downloadAndCacheSite(did: string, rkey: string, record: WispFsRecord, pdsEndpoint: string, recordCid: string): Promise<void> {
  console.log('Caching site', did, rkey);

  if (!record.root) {
    console.error('Record missing root directory:', JSON.stringify(record, null, 2));
    throw new Error('Invalid record structure: missing root directory');
  }

  if (!record.root.entries || !Array.isArray(record.root.entries)) {
    console.error('Record root missing entries array:', JSON.stringify(record.root, null, 2));
    throw new Error('Invalid record structure: root missing entries array');
  }

  // Expand subfs nodes before caching
  const expandedRoot = await expandSubfsNodes(record.root, pdsEndpoint);

  // Verify all subfs nodes were expanded
  const remainingSubfs = extractSubfsUris(expandedRoot);
  if (remainingSubfs.length > 0) {
    console.warn(`[Cache] Warning: ${remainingSubfs.length} subfs nodes remain unexpanded after expansion`, remainingSubfs);
  }

  // Validate file count limit
  const fileCount = countFilesInDirectory(expandedRoot);
  if (fileCount > MAX_FILE_COUNT) {
    throw new Error(`Site exceeds file count limit: ${fileCount} files (max ${MAX_FILE_COUNT})`);
  }
  console.log(`[Cache] File count validation passed: ${fileCount} files (limit: ${MAX_FILE_COUNT})`);

  // Validate total size from blob metadata
  const totalBlobSize = calculateTotalBlobSize(expandedRoot);
  if (totalBlobSize > MAX_SITE_SIZE) {
    throw new Error(`Site exceeds size limit: ${(totalBlobSize / 1024 / 1024).toFixed(2)}MB (max ${(MAX_SITE_SIZE / 1024 / 1024).toFixed(0)}MB)`);
  }
  console.log(`[Cache] Size validation passed: ${(totalBlobSize / 1024 / 1024).toFixed(2)}MB (limit: ${(MAX_SITE_SIZE / 1024 / 1024).toFixed(0)}MB)`);

  // Get existing cache metadata to check for incremental updates
  const existingMetadata = await getCacheMetadata(did, rkey);
  const existingFileCids = existingMetadata?.fileCids || {};

  // Collect file CIDs from the new record (using expanded root)
  const newFileCids: Record<string, string> = {};
  collectFileCidsFromEntries(expandedRoot.entries, '', newFileCids);

  // Fetch site settings (optional)
  const settings = await fetchSiteSettings(did, rkey);

  // Determine if this is an incremental update or full cache
  const isIncremental = Object.keys(existingFileCids).length > 0;
  const updateType = isIncremental ? 'incremental update' : 'full cache';
  console.log(`[Cache] Starting ${updateType} for ${did}:${rkey}`);

  // Download files directly to tiered storage (with incremental logic)
  await cacheFiles(did, rkey, expandedRoot.entries, pdsEndpoint, '', existingFileCids);
  await saveCacheMetadata(did, rkey, recordCid, newFileCids, settings);

  console.log(`[Cache] Successfully cached site ${did}:${rkey} (${updateType})`);
}


async function cacheFiles(
  did: string,
  site: string,
  entries: Entry[],
  pdsEndpoint: string,
  pathPrefix: string,
  existingFileCids: Record<string, string> = {}
): Promise<void> {
  // Collect file download tasks (skip unchanged files)
  const downloadTasks: Array<() => Promise<void>> = [];
  let skippedCount = 0;

  function collectFileTasks(
    entries: Entry[],
    currentPathPrefix: string
  ) {
    for (const entry of entries) {
      const currentPath = currentPathPrefix ? `${currentPathPrefix}/${entry.name}` : entry.name;
      const node = entry.node;

      if ('type' in node && node.type === 'directory' && 'entries' in node) {
        collectFileTasks(node.entries, currentPath);
      } else if ('type' in node && node.type === 'file' && 'blob' in node) {
        const fileNode = node as File;
        const cid = extractBlobCid(fileNode.blob);

        // Check if file is unchanged (same CID as existing cache)
        if (cid && existingFileCids[currentPath] === cid) {
          // File unchanged - skip download (already in tiered storage)
          skippedCount++;
        } else {
          // File new or changed - download it
          downloadTasks.push(() => cacheFileBlob(
            did,
            site,
            currentPath,
            fileNode.blob,
            pdsEndpoint,
            fileNode.encoding,
            fileNode.mimeType,
            fileNode.base64
          ));
        }
      }
    }
  }

  collectFileTasks(entries, pathPrefix);

  console.log(`[Incremental Update] Files to copy: ${skippedCount}, Files to download: ${downloadTasks.length}`);

  // Download new/changed files concurrently
  const downloadLimit = 20;
  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < downloadTasks.length; i += downloadLimit) {
    const batch = downloadTasks.slice(i, i + downloadLimit);
    const results = await Promise.allSettled(batch.map(task => task()));

    // Count successes and failures
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        failureCount++;
        console.error(`[Cache] Failed to download file (continuing with others):`, result.reason);
      }
    });

    if (downloadTasks.length > downloadLimit) {
      console.log(`[Cache Progress] Downloaded ${Math.min(i + downloadLimit, downloadTasks.length)}/${downloadTasks.length} files (${failureCount} failed)`);
    }
  }

  if (failureCount > 0) {
    console.warn(`[Cache] Completed with ${successCount} successful and ${failureCount} failed file downloads`);
  }
}

async function cacheFileBlob(
  did: string,
  site: string,
  filePath: string,
  blobRef: any,
  pdsEndpoint: string,
  encoding?: 'gzip',
  mimeType?: string,
  base64?: boolean
): Promise<void> {
  const cid = extractBlobCid(blobRef);
  if (!cid) {
    console.error('Could not extract CID from blob', blobRef);
    return;
  }

  const blobUrl = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;

  console.log(`[Cache] Fetching blob for file: ${filePath}, CID: ${cid}`);

  let content = await safeFetchBlob(blobUrl, { maxSize: MAX_BLOB_SIZE, timeout: 300000 });

  // If content is base64-encoded, decode it back to raw binary (gzipped or not)
  if (base64) {
    // Decode base64 directly from raw bytes - no string conversion
    // The blob contains base64-encoded text as raw bytes, decode it in-place
    const textDecoder = new TextDecoder();
    const base64String = textDecoder.decode(content);
    content = Buffer.from(base64String, 'base64');
  }

  // Use the shared function to determine if this should remain compressed
  const shouldStayCompressed = shouldCompressMimeType(mimeType);

  // Decompress files that shouldn't be stored compressed
  if (encoding === 'gzip' && !shouldStayCompressed && content.length >= 2 &&
      content[0] === 0x1f && content[1] === 0x8b) {
    try {
      const { gunzipSync } = await import('zlib');
      const decompressed = gunzipSync(content);
      content = decompressed;
      // Clear the encoding flag since we're storing decompressed
      encoding = undefined;
    } catch (error) {
      console.error(`Failed to decompress ${filePath}, storing original gzipped content:`, error);
    }
  }

  // Write to tiered storage with metadata
  const stream = Readable.from([content]);
  const key = `${did}/${site}/${filePath}`;

  // Build metadata object, only including defined values
  const customMetadata: Record<string, string> = {};
  if (encoding) customMetadata.encoding = encoding;
  if (mimeType) customMetadata.mimeType = mimeType;

  await storage.setStream(key, stream, {
    size: content.length,
    skipTiers: ['hot'], // Don't put in memory on ingest, only on access
    metadata: customMetadata,
  });

  // Log completion with tier info
  const tierInfo = 'to warm/cold tiers';
  if (encoding === 'gzip' && mimeType) {
    console.log(`[Cache] Stored ${filePath} ${tierInfo} (${content.length} bytes, gzipped, ${mimeType})`);
  } else {
    console.log(`[Cache] Stored ${filePath} ${tierInfo} (${content.length} bytes)`);
  }
}


export function getCachedFilePath(did: string, site: string, filePath: string): string {
  const sanitizedPath = sanitizePath(filePath);
  return `${CACHE_DIR}/${did}/${site}/${sanitizedPath}`;
}

/**
 * Check if a site exists in any tier of the cache (without checking metadata)
 * This is a quick existence check - for actual retrieval, use storage.get()
 */
export async function isCached(did: string, site: string): Promise<boolean> {
  // Check if any file exists for this site by checking for the index.html
  // If index.html exists, the site is cached
  const indexKey = `${did}/${site}/index.html`;
  return await storage.exists(indexKey);
}

async function saveCacheMetadata(did: string, rkey: string, recordCid: string, fileCids?: Record<string, string>, settings?: WispSettings | null): Promise<void> {
  const metadata: CacheMetadata = {
    recordCid,
    cachedAt: Date.now(),
    did,
    rkey,
    fileCids,
    settings: settings || undefined
  };

  // Store through tiered storage for persistence to S3/cold tier
  const metadataKey = `${did}/${rkey}/.metadata.json`;
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
  await storage.set(metadataKey, metadataBytes);
}

async function getCacheMetadata(did: string, rkey: string): Promise<CacheMetadata | null> {
  try {
    // Retrieve metadata from tiered storage
    const metadataKey = `${did}/${rkey}/.metadata.json`;
    const data = await storage.get(metadataKey);

    if (!data) return null;

    // Deserialize from Uint8Array to JSON (storage uses identity serialization)
    const jsonString = new TextDecoder().decode(data as Uint8Array);
    return JSON.parse(jsonString) as CacheMetadata;
  } catch (err) {
    console.error('Failed to read cache metadata', err);
    return null;
  }
}

export async function getCachedSettings(did: string, rkey: string): Promise<WispSettings | null> {
  const metadata = await getCacheMetadata(did, rkey);

  // If metadata has settings (including explicit null for "no settings"), return them
  if (metadata && 'settings' in metadata) {
    return metadata.settings ?? null;
  }

  // If metadata exists but has never checked for settings, try to fetch from PDS and update cache
  if (metadata) {
    console.log('[Cache] Metadata missing settings, fetching from PDS', { did, rkey });
    try {
      const settings = await fetchSiteSettings(did, rkey);
      // Update cache with settings (or null if none found)
      // This caches the "no settings" state to avoid repeated PDS fetches
      await updateCacheMetadataSettings(did, rkey, settings);
      console.log('[Cache] Updated metadata with fetched settings', { did, rkey, hasSettings: !!settings });
      return settings;
    } catch (err) {
      console.error('[Cache] Failed to fetch/update settings', { did, rkey, err });
    }
  }

  return null;
}

export async function updateCacheMetadataSettings(did: string, rkey: string, settings: WispSettings | null): Promise<void> {
  try {
    // Read existing metadata from tiered storage
    const metadata = await getCacheMetadata(did, rkey);

    if (!metadata) {
      console.warn('Metadata does not exist, cannot update settings', { did, rkey });
      return;
    }

    // Update settings field
    // Store null explicitly to cache "no settings" state and avoid repeated fetches
    metadata.settings = settings ?? null;

    // Write back through tiered storage
    // Convert to Uint8Array since storage is typed for binary data
    const metadataKey = `${did}/${rkey}/.metadata.json`;
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
    await storage.set(metadataKey, metadataBytes);
    console.log('Updated metadata settings', { did, rkey, hasSettings: !!settings });
  } catch (err) {
    console.error('Failed to update metadata settings', err);
    throw err;
  }
}

export async function isCacheValid(did: string, rkey: string, currentRecordCid?: string): Promise<boolean> {
  const metadata = await getCacheMetadata(did, rkey);
  if (!metadata) return false;

  // Check if cache has expired (14 days TTL)
  const cacheAge = Date.now() - metadata.cachedAt;
  if (cacheAge > CACHE_TTL) {
    console.log('[Cache] Cache expired for', did, rkey);
    return false;
  }

  // If current CID is provided, verify it matches
  if (currentRecordCid && metadata.recordCid !== currentRecordCid) {
    console.log('[Cache] CID mismatch for', did, rkey, 'cached:', metadata.recordCid, 'current:', currentRecordCid);
    return false;
  }

  return true;
}
