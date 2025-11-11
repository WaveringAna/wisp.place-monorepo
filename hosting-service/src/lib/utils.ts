import { AtpAgent } from '@atproto/api';
import type { Record as WispFsRecord, Directory, Entry, File } from '../lexicon/types/place/wisp/fs';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { writeFile, readFile, rename } from 'fs/promises';
import { safeFetchJson, safeFetchBlob } from './safe-fetch';
import { CID } from 'multiformats';

const CACHE_DIR = process.env.CACHE_DIR || './cache/sites';
const CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days cache TTL

interface CacheMetadata {
  recordCid: string;
  cachedAt: number;
  did: string;
  rkey: string;
  // Map of file path to blob CID for incremental updates
  fileCids?: Record<string, string>;
}

/**
 * Determines if a MIME type should benefit from gzip compression.
 * Returns true for text-based web assets (HTML, CSS, JS, JSON, XML, SVG).
 * Returns false for already-compressed formats (images, video, audio, PDFs).
 * 
 */
export function shouldCompressMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  
  const mime = mimeType.toLowerCase();
  
  // Text-based web assets that benefit from compression
  const compressibleTypes = [
    'text/html',
    'text/css',
    'text/javascript',
    'application/javascript',
    'application/x-javascript',
    'text/xml',
    'application/xml',
    'application/json',
    'text/plain',
    'image/svg+xml',
  ];
  
  if (compressibleTypes.some(type => mime === type || mime.startsWith(type))) {
    return true;
  }
  
  // Already-compressed formats that should NOT be double-compressed
  const alreadyCompressedPrefixes = [
    'video/',
    'audio/',
    'image/',
    'application/pdf',
    'application/zip',
    'application/gzip',
  ];
  
  if (alreadyCompressedPrefixes.some(prefix => mime.startsWith(prefix))) {
    return false;
  }
  
  // Default to not compressing for unknown types
  return false;
}

interface IpldLink {
  $link: string;
}

interface TypedBlobRef {
  ref: CID | IpldLink;
}

interface UntypedBlobRef {
  cid: string;
}

function isIpldLink(obj: unknown): obj is IpldLink {
  return typeof obj === 'object' && obj !== null && '$link' in obj && typeof (obj as IpldLink).$link === 'string';
}

function isTypedBlobRef(obj: unknown): obj is TypedBlobRef {
  return typeof obj === 'object' && obj !== null && 'ref' in obj;
}

function isUntypedBlobRef(obj: unknown): obj is UntypedBlobRef {
  return typeof obj === 'object' && obj !== null && 'cid' in obj && typeof (obj as UntypedBlobRef).cid === 'string';
}

export async function resolveDid(identifier: string): Promise<string | null> {
  try {
    // If it's already a DID, return it
    if (identifier.startsWith('did:')) {
      return identifier;
    }

    // Otherwise, resolve the handle using agent's built-in method
    const agent = new AtpAgent({ service: 'https://public.api.bsky.app' });
    const response = await agent.resolveHandle({ handle: identifier });
    return response.data.did;
  } catch (err) {
    console.error('Failed to resolve identifier', identifier, err);
    return null;
  }
}

export async function getPdsForDid(did: string): Promise<string | null> {
  try {
    let doc;

    if (did.startsWith('did:plc:')) {
      doc = await safeFetchJson(`https://plc.directory/${encodeURIComponent(did)}`);
    } else if (did.startsWith('did:web:')) {
      const didUrl = didWebToHttps(did);
      doc = await safeFetchJson(didUrl);
    } else {
      console.error('Unsupported DID method', did);
      return null;
    }

    const services = doc.service || [];
    const pdsService = services.find((s: any) => s.id === '#atproto_pds');

    return pdsService?.serviceEndpoint || null;
  } catch (err) {
    console.error('Failed to get PDS for DID', did, err);
    return null;
  }
}

function didWebToHttps(did: string): string {
  const didParts = did.split(':');
  if (didParts.length < 3 || didParts[0] !== 'did' || didParts[1] !== 'web') {
    throw new Error('Invalid did:web format');
  }

  const domain = didParts[2];
  const pathParts = didParts.slice(3);

  if (pathParts.length === 0) {
    return `https://${domain}/.well-known/did.json`;
  } else {
    const path = pathParts.join('/');
    return `https://${domain}/${path}/did.json`;
  }
}

export async function fetchSiteRecord(did: string, rkey: string): Promise<{ record: WispFsRecord; cid: string } | null> {
  try {
    const pdsEndpoint = await getPdsForDid(did);
    if (!pdsEndpoint) return null;

    const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.fs&rkey=${encodeURIComponent(rkey)}`;
    const data = await safeFetchJson(url);

    return {
      record: data.value as WispFsRecord,
      cid: data.cid || ''
    };
  } catch (err) {
    console.error('Failed to fetch site record', did, rkey, err);
    return null;
  }
}

export function extractBlobCid(blobRef: unknown): string | null {
  if (isIpldLink(blobRef)) {
    return blobRef.$link;
  }

  if (isTypedBlobRef(blobRef)) {
    const ref = blobRef.ref;

    const cid = CID.asCID(ref);
    if (cid) {
      return cid.toString();
    }

    if (isIpldLink(ref)) {
      return ref.$link;
    }
  }

  if (isUntypedBlobRef(blobRef)) {
    return blobRef.cid;
  }

  return null;
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

  // Get existing cache metadata to check for incremental updates
  const existingMetadata = await getCacheMetadata(did, rkey);
  const existingFileCids = existingMetadata?.fileCids || {};

  // Use a temporary directory with timestamp to avoid collisions
  const tempSuffix = `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const tempDir = `${CACHE_DIR}/${did}/${rkey}${tempSuffix}`;
  const finalDir = `${CACHE_DIR}/${did}/${rkey}`;

  try {
    // Collect file CIDs from the new record
    const newFileCids: Record<string, string> = {};
    collectFileCidsFromEntries(record.root.entries, '', newFileCids);

    // Download/copy files to temporary directory (with incremental logic)
    await cacheFiles(did, rkey, record.root.entries, pdsEndpoint, '', tempSuffix, existingFileCids, finalDir);
    await saveCacheMetadata(did, rkey, recordCid, tempSuffix, newFileCids);

    // Atomically replace old cache with new cache
    // On POSIX systems (Linux/macOS), rename is atomic
    if (existsSync(finalDir)) {
      // Rename old directory to backup
      const backupDir = `${finalDir}.old-${Date.now()}`;
      await rename(finalDir, backupDir);

      try {
        // Rename new directory to final location
        await rename(tempDir, finalDir);

        // Clean up old backup
        rmSync(backupDir, { recursive: true, force: true });
      } catch (err) {
        // If rename failed, restore backup
        if (existsSync(backupDir) && !existsSync(finalDir)) {
          await rename(backupDir, finalDir);
        }
        throw err;
      }
    } else {
      // No existing cache, just rename temp to final
      await rename(tempDir, finalDir);
    }

    console.log('Successfully cached site atomically', did, rkey);
  } catch (err) {
    // Clean up temp directory on failure
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    throw err;
  }
}

/**
 * Recursively collect file CIDs from entries for incremental update tracking
 */
function collectFileCidsFromEntries(entries: Entry[], pathPrefix: string, fileCids: Record<string, string>): void {
  for (const entry of entries) {
    const currentPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
    const node = entry.node;

    if ('type' in node && node.type === 'directory' && 'entries' in node) {
      collectFileCidsFromEntries(node.entries, currentPath, fileCids);
    } else if ('type' in node && node.type === 'file' && 'blob' in node) {
      const fileNode = node as File;
      const cid = extractBlobCid(fileNode.blob);
      if (cid) {
        fileCids[currentPath] = cid;
      }
    }
  }
}

async function cacheFiles(
  did: string,
  site: string,
  entries: Entry[],
  pdsEndpoint: string,
  pathPrefix: string,
  dirSuffix: string = '',
  existingFileCids: Record<string, string> = {},
  existingCacheDir?: string
): Promise<void> {
  // Collect file tasks, separating unchanged files from new/changed files
  const downloadTasks: Array<() => Promise<void>> = [];
  const copyTasks: Array<() => Promise<void>> = [];

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
        if (cid && existingFileCids[currentPath] === cid && existingCacheDir) {
          // File unchanged - copy from existing cache instead of downloading
          copyTasks.push(() => copyExistingFile(
            did,
            site,
            currentPath,
            dirSuffix,
            existingCacheDir
          ));
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
            fileNode.base64,
            dirSuffix
          ));
        }
      }
    }
  }

  collectFileTasks(entries, pathPrefix);

  console.log(`[Incremental Update] Files to copy: ${copyTasks.length}, Files to download: ${downloadTasks.length}`);

  // Copy unchanged files in parallel (fast local operations)
  const copyLimit = 10;
  for (let i = 0; i < copyTasks.length; i += copyLimit) {
    const batch = copyTasks.slice(i, i + copyLimit);
    await Promise.all(batch.map(task => task()));
  }

  // Download new/changed files concurrently with a limit of 3 at a time
  const downloadLimit = 3;
  for (let i = 0; i < downloadTasks.length; i += downloadLimit) {
    const batch = downloadTasks.slice(i, i + downloadLimit);
    await Promise.all(batch.map(task => task()));
  }
}

/**
 * Copy an unchanged file from existing cache to new cache location
 */
async function copyExistingFile(
  did: string,
  site: string,
  filePath: string,
  dirSuffix: string,
  existingCacheDir: string
): Promise<void> {
  const { copyFile } = await import('fs/promises');

  const sourceFile = `${existingCacheDir}/${filePath}`;
  const destFile = `${CACHE_DIR}/${did}/${site}${dirSuffix}/${filePath}`;
  const destDir = destFile.substring(0, destFile.lastIndexOf('/'));

  // Create destination directory if needed
  if (destDir && !existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  try {
    // Copy the file
    await copyFile(sourceFile, destFile);

    // Copy metadata file if it exists
    const sourceMetaFile = `${sourceFile}.meta`;
    const destMetaFile = `${destFile}.meta`;
    if (existsSync(sourceMetaFile)) {
      await copyFile(sourceMetaFile, destMetaFile);
    }

    console.log(`[Incremental] Copied unchanged file: ${filePath}`);
  } catch (err) {
    console.error(`[Incremental] Failed to copy file ${filePath}, will attempt download:`, err);
    throw err;
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
  base64?: boolean,
  dirSuffix: string = ''
): Promise<void> {
  const cid = extractBlobCid(blobRef);
  if (!cid) {
    console.error('Could not extract CID from blob', blobRef);
    return;
  }

  const blobUrl = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;

  // Allow up to 500MB per file blob, with 5 minute timeout
  let content = await safeFetchBlob(blobUrl, { maxSize: 500 * 1024 * 1024, timeout: 300000 });

  console.log(`[DEBUG] ${filePath}: fetched ${content.length} bytes, base64=${base64}, encoding=${encoding}, mimeType=${mimeType}`);

  // If content is base64-encoded, decode it back to raw binary (gzipped or not)
  if (base64) {
    const originalSize = content.length;
    // Decode base64 directly from raw bytes - no string conversion
    // The blob contains base64-encoded text as raw bytes, decode it in-place
    const textDecoder = new TextDecoder();
    const base64String = textDecoder.decode(content);
    content = Buffer.from(base64String, 'base64');
    console.log(`[DEBUG] ${filePath}: decoded base64 from ${originalSize} bytes to ${content.length} bytes`);
    
    // Check if it's actually gzipped by looking at magic bytes
    if (content.length >= 2) {
      const hasGzipMagic = content[0] === 0x1f && content[1] === 0x8b;
      console.log(`[DEBUG] ${filePath}: has gzip magic bytes: ${hasGzipMagic}`);
    }
  }

  const cacheFile = `${CACHE_DIR}/${did}/${site}${dirSuffix}/${filePath}`;
  const fileDir = cacheFile.substring(0, cacheFile.lastIndexOf('/'));

  if (fileDir && !existsSync(fileDir)) {
    mkdirSync(fileDir, { recursive: true });
  }

  // Use the shared function to determine if this should remain compressed
  const shouldStayCompressed = shouldCompressMimeType(mimeType);

  // Decompress files that shouldn't be stored compressed
  if (encoding === 'gzip' && !shouldStayCompressed && content.length >= 2 && 
      content[0] === 0x1f && content[1] === 0x8b) {
    console.log(`[DEBUG] ${filePath}: decompressing non-compressible type (${mimeType}) before caching`);
    try {
      const { gunzipSync } = await import('zlib');
      const decompressed = gunzipSync(content);
      console.log(`[DEBUG] ${filePath}: decompressed from ${content.length} to ${decompressed.length} bytes`);
      content = decompressed;
      // Clear the encoding flag since we're storing decompressed
      encoding = undefined;
    } catch (error) {
      console.log(`[DEBUG] ${filePath}: failed to decompress, storing original gzipped content. Error:`, error);
    }
  }

  await writeFile(cacheFile, content);

  // Store metadata only if file is still compressed
  if (encoding === 'gzip' && mimeType) {
    const metaFile = `${cacheFile}.meta`;
    await writeFile(metaFile, JSON.stringify({ encoding, mimeType }));
    console.log('Cached file', filePath, content.length, 'bytes (gzipped,', mimeType + ')');
  } else {
    console.log('Cached file', filePath, content.length, 'bytes');
  }
}

/**
 * Sanitize a file path to prevent directory traversal attacks
 * Removes any path segments that attempt to go up directories
 */
export function sanitizePath(filePath: string): string {
  // Remove leading slashes
  let cleaned = filePath.replace(/^\/+/, '');

  // Split into segments and filter out dangerous ones
  const segments = cleaned.split('/').filter(segment => {
    // Remove empty segments
    if (!segment || segment === '.') return false;
    // Remove parent directory references
    if (segment === '..') return false;
    // Remove segments with null bytes
    if (segment.includes('\0')) return false;
    return true;
  });

  // Rejoin the safe segments
  return segments.join('/');
}

export function getCachedFilePath(did: string, site: string, filePath: string): string {
  const sanitizedPath = sanitizePath(filePath);
  return `${CACHE_DIR}/${did}/${site}/${sanitizedPath}`;
}

export function isCached(did: string, site: string): boolean {
  return existsSync(`${CACHE_DIR}/${did}/${site}`);
}

async function saveCacheMetadata(did: string, rkey: string, recordCid: string, dirSuffix: string = '', fileCids?: Record<string, string>): Promise<void> {
  const metadata: CacheMetadata = {
    recordCid,
    cachedAt: Date.now(),
    did,
    rkey,
    fileCids
  };

  const metadataPath = `${CACHE_DIR}/${did}/${rkey}${dirSuffix}/.metadata.json`;
  const metadataDir = metadataPath.substring(0, metadataPath.lastIndexOf('/'));

  if (!existsSync(metadataDir)) {
    mkdirSync(metadataDir, { recursive: true });
  }

  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

async function getCacheMetadata(did: string, rkey: string): Promise<CacheMetadata | null> {
  try {
    const metadataPath = `${CACHE_DIR}/${did}/${rkey}/.metadata.json`;
    if (!existsSync(metadataPath)) return null;

    const content = await readFile(metadataPath, 'utf-8');
    return JSON.parse(content) as CacheMetadata;
  } catch (err) {
    console.error('Failed to read cache metadata', err);
    return null;
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
