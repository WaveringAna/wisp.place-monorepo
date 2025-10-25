import { AtpAgent } from '@atproto/api';
import type { WispFsRecord, Directory, Entry, File } from './types';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { safeFetchJson, safeFetchBlob } from './safe-fetch';
import { CID } from 'multiformats/cid';
import { createHash } from 'crypto';

const CACHE_DIR = './cache/sites';
const CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days cache TTL

interface CacheMetadata {
  recordCid: string;
  cachedAt: number;
  did: string;
  rkey: string;
}

// Type guards for different blob reference formats
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
      // Resolve did:plc from plc.directory
      doc = await safeFetchJson(`https://plc.directory/${encodeURIComponent(did)}`);
    } else if (did.startsWith('did:web:')) {
      // Resolve did:web from the domain
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
  // did:web:example.com -> https://example.com/.well-known/did.json
  // did:web:example.com:path:to:did -> https://example.com/path/to/did/did.json

  const didParts = did.split(':');
  if (didParts.length < 3 || didParts[0] !== 'did' || didParts[1] !== 'web') {
    throw new Error('Invalid did:web format');
  }

  const domain = didParts[2];
  const pathParts = didParts.slice(3);

  if (pathParts.length === 0) {
    // No path, use .well-known
    return `https://${domain}/.well-known/did.json`;
  } else {
    // Has path
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

    // Return both the record and its CID for verification
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
  // Check if it's a direct IPLD link
  if (isIpldLink(blobRef)) {
    return blobRef.$link;
  }

  // Check if it's a typed blob ref with a ref property
  if (isTypedBlobRef(blobRef)) {
    const ref = blobRef.ref;

    // Check if ref is a CID object
    if (CID.isCID(ref)) {
      return ref.toString();
    }

    // Check if ref is an IPLD link object
    if (isIpldLink(ref)) {
      return ref.$link;
    }
  }

  // Check if it's an untyped blob ref with a cid string
  if (isUntypedBlobRef(blobRef)) {
    return blobRef.cid;
  }

  return null;
}

export async function downloadAndCacheSite(did: string, rkey: string, record: WispFsRecord, pdsEndpoint: string, recordCid: string): Promise<void> {
  console.log('Caching site', did, rkey);

  // Validate record structure
  if (!record.root) {
    console.error('Record missing root directory:', JSON.stringify(record, null, 2));
    throw new Error('Invalid record structure: missing root directory');
  }

  if (!record.root.entries || !Array.isArray(record.root.entries)) {
    console.error('Record root missing entries array:', JSON.stringify(record.root, null, 2));
    throw new Error('Invalid record structure: root missing entries array');
  }

  await cacheFiles(did, rkey, record.root.entries, pdsEndpoint, '');

  // Save cache metadata with CID for verification
  await saveCacheMetadata(did, rkey, recordCid);
}

async function cacheFiles(
  did: string,
  site: string,
  entries: Entry[],
  pdsEndpoint: string,
  pathPrefix: string
): Promise<void> {
  for (const entry of entries) {
    const currentPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
    const node = entry.node;

    if ('type' in node && node.type === 'directory' && 'entries' in node) {
      await cacheFiles(did, site, node.entries, pdsEndpoint, currentPath);
    } else if ('type' in node && node.type === 'file' && 'blob' in node) {
      await cacheFileBlob(did, site, currentPath, node.blob, pdsEndpoint);
    }
  }
}

async function cacheFileBlob(
  did: string,
  site: string,
  filePath: string,
  blobRef: any,
  pdsEndpoint: string
): Promise<void> {
  const cid = extractBlobCid(blobRef);
  if (!cid) {
    console.error('Could not extract CID from blob', blobRef);
    return;
  }

  const blobUrl = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;

  // Allow up to 100MB per file blob
  const content = await safeFetchBlob(blobUrl, { maxSize: 100 * 1024 * 1024 });

  const cacheFile = `${CACHE_DIR}/${did}/${site}/${filePath}`;
  const fileDir = cacheFile.substring(0, cacheFile.lastIndexOf('/'));

  if (fileDir && !existsSync(fileDir)) {
    mkdirSync(fileDir, { recursive: true });
  }

  await writeFile(cacheFile, content);
  console.log('Cached file', filePath, content.length, 'bytes');
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

async function saveCacheMetadata(did: string, rkey: string, recordCid: string): Promise<void> {
  const metadata: CacheMetadata = {
    recordCid,
    cachedAt: Date.now(),
    did,
    rkey
  };

  const metadataPath = `${CACHE_DIR}/${did}/${rkey}/.metadata.json`;
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
