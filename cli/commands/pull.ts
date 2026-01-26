import type { Directory, Entry, File, Record as FsRecord } from '@wisp/lexicons/types/place/wisp/fs';
import type { Record as SubfsRecord } from '@wisp/lexicons/types/place/wisp/subfs';
import { extractBlobCid, resolveDid, getPdsForDid } from '@wisp/atproto-utils';
import { sanitizePath } from '@wisp/fs-utils';
import { existsSync, mkdirSync, writeFileSync, rmSync, renameSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { gunzipSync } from 'zlib';
import { createSpinner, formatBytes, pc } from '../lib/progress.ts';
import { loadMetadata, saveMetadata, type SiteMetadata } from '../lib/metadata.ts';

const MAX_CONCURRENT_DOWNLOADS = 20;

export interface PullOptions {
  site: string;
  path: string;
}

async function fetchRecord(pdsEndpoint: string, did: string, collection: string, rkey: string): Promise<any> {
  const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch record: ${res.status}`);
  }
  return res.json();
}

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

async function expandSubfsNodes(
  directory: Directory,
  pdsEndpoint: string,
  depth: number = 0,
  subfsCache: Map<string, SubfsRecord | null> = new Map()
): Promise<Directory> {
  const MAX_DEPTH = 10;

  if (depth >= MAX_DEPTH) {
    console.warn('Max subfs expansion depth reached');
    return directory;
  }

  const subfsUris = extractSubfsUris(directory);
  if (subfsUris.length === 0) {
    return directory;
  }

  // Fetch uncached subfs records
  const uncachedUris = subfsUris.filter(({ uri }) => !subfsCache.has(uri));

  if (uncachedUris.length > 0) {
    await Promise.all(uncachedUris.map(async ({ uri }) => {
      try {
        const parts = uri.replace('at://', '').split('/');
        const did = parts[0]!;
        const collection = parts[1]!;
        const rkey = parts[2]!;

        const data = await fetchRecord(pdsEndpoint, did, collection, rkey);
        subfsCache.set(uri, data.value as SubfsRecord);
      } catch {
        subfsCache.set(uri, null);
      }
    }));
  }

  // Build map of path -> entries
  const subfsMap = new Map<string, Entry[]>();
  for (const { uri, path } of subfsUris) {
    const record = subfsCache.get(uri);
    if (record?.root?.entries) {
      subfsMap.set(path, record.root.entries as unknown as Entry[]);
    }
  }

  // Replace subfs nodes with their content
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
            result.push({
              name: entry.name,
              node: {
                type: 'directory',
                entries: processedEntries
              } as any
            });
          }
        } else {
          result.push(entry);
        }
      } else if ('type' in node && node.type === 'directory' && 'entries' in node) {
        result.push({
          ...entry,
          node: {
            ...node,
            entries: replaceSubfsInEntries(node.entries, fullPath)
          }
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

interface FileToDownload {
  path: string;
  cid: string;
  encoding?: 'gzip';
  mimeType?: string;
  base64?: boolean;
}

function collectFiles(
  entries: Entry[],
  pathPrefix: string,
  existingCids: Record<string, string>
): { toDownload: FileToDownload[]; toSkip: number } {
  const toDownload: FileToDownload[] = [];
  let toSkip = 0;

  function collect(entries: Entry[], currentPath: string) {
    for (const entry of entries) {
      const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
      const node = entry.node;

      if ('type' in node && node.type === 'directory' && 'entries' in node) {
        collect(node.entries, fullPath);
      } else if ('type' in node && node.type === 'file' && 'blob' in node) {
        const fileNode = node as File;
        const cid = extractBlobCid(fileNode.blob);

        if (!cid) continue;

        if (existingCids[fullPath] === cid) {
          toSkip++;
        } else {
          toDownload.push({
            path: fullPath,
            cid,
            encoding: fileNode.encoding,
            mimeType: fileNode.mimeType,
            base64: fileNode.base64
          });
        }
      }
    }
  }

  collect(entries, pathPrefix);
  return { toDownload, toSkip };
}

async function downloadBlob(
  pdsEndpoint: string,
  did: string,
  file: FileToDownload
): Promise<Buffer> {
  const url = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(file.cid)}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to download blob ${file.cid}: ${res.status}`);
  }

  let content = Buffer.from(await res.arrayBuffer());

  // Decode base64 if needed
  if (file.base64) {
    const base64String = content.toString('utf-8');
    content = Buffer.from(base64String, 'base64');
  }

  // Decompress gzip
  if (file.encoding === 'gzip' && content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b) {
    try {
      content = gunzipSync(content);
    } catch {
      // Keep original content if decompression fails
    }
  }

  return content;
}

export async function pull(
  identifier: string,
  options: PullOptions
): Promise<void> {
  const { site, path: outputPath } = options;

  console.log(pc.cyan(`\nPulling ${pc.bold(site)} from ${identifier}\n`));

  // 1. Resolve DID
  const spinner = createSpinner('Resolving identity...').start();
  const did = await resolveDid(identifier);

  if (!did) {
    spinner.fail('Failed to resolve identity');
    throw new Error(`Could not resolve: ${identifier}`);
  }

  spinner.succeed(`Resolved to ${did}`);

  // 2. Get PDS endpoint
  const pdsSpinner = createSpinner('Getting PDS endpoint...').start();
  const pdsEndpoint = await getPdsForDid(did);

  if (!pdsEndpoint) {
    pdsSpinner.fail('Failed to get PDS endpoint');
    throw new Error(`Could not get PDS for: ${did}`);
  }

  pdsSpinner.succeed(`PDS: ${pdsEndpoint}`);

  // 3. Fetch site record
  const recordSpinner = createSpinner('Fetching site record...').start();
  let recordData;

  try {
    recordData = await fetchRecord(pdsEndpoint, did, 'place.wisp.fs', site);
  } catch {
    recordSpinner.fail('Site not found');
    throw new Error(`Site not found: ${site}`);
  }

  const record = recordData.value as FsRecord;
  const recordCid = recordData.cid || '';
  recordSpinner.succeed('Fetched site record');

  // 4. Expand subfs nodes
  const expandSpinner = createSpinner('Expanding subfs nodes...').start();
  const expandedRoot = await expandSubfsNodes(record.root, pdsEndpoint);
  expandSpinner.succeed('Expanded subfs nodes');

  // 5. Load existing metadata for incremental updates
  const existingMetadata = loadMetadata(outputPath);
  const existingCids = existingMetadata?.fileCids || {};

  // 6. Collect files to download
  const { toDownload, toSkip } = collectFiles(expandedRoot.entries, '', existingCids);

  console.log(pc.dim(`Files to download: ${toDownload.length}, unchanged: ${toSkip}`));

  if (toDownload.length === 0 && toSkip > 0) {
    console.log(pc.green('\n✓ Site is already up to date\n'));
    return;
  }

  // 7. Create temp directory
  const tempDir = `${outputPath}.tmp-${Date.now()}`;
  mkdirSync(tempDir, { recursive: true });

  // 8. Download files
  const downloadSpinner = createSpinner(`Downloading ${toDownload.length} files...`).start();
  const newFileCids: Record<string, string> = { ...existingCids };
  let downloaded = 0;

  try {
    for (let i = 0; i < toDownload.length; i += MAX_CONCURRENT_DOWNLOADS) {
      const batch = toDownload.slice(i, i + MAX_CONCURRENT_DOWNLOADS);

      await Promise.all(batch.map(async (file) => {
        const content = await downloadBlob(pdsEndpoint, did, file);
        const filePath = join(tempDir, sanitizePath(file.path));

        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);

        newFileCids[file.path] = file.cid;
        downloaded++;
        downloadSpinner.text = `Downloading files: ${downloaded}/${toDownload.length}`;
      }));
    }

    downloadSpinner.succeed(`Downloaded ${downloaded} files`);

    // 9. Copy unchanged files from existing directory
    if (toSkip > 0 && existsSync(outputPath)) {
      const copySpinner = createSpinner(`Copying ${toSkip} unchanged files...`).start();

      for (const [filePath, cid] of Object.entries(existingCids)) {
        if (!toDownload.find(f => f.path === filePath)) {
          const srcPath = join(outputPath, sanitizePath(filePath));
          const destPath = join(tempDir, sanitizePath(filePath));

          if (existsSync(srcPath)) {
            mkdirSync(dirname(destPath), { recursive: true });
            const content = readFileSync(srcPath);
            writeFileSync(destPath, content);
          }
        }
      }

      copySpinner.succeed(`Copied ${toSkip} unchanged files`);
    }

    // 10. Atomic replace
    if (existsSync(outputPath)) {
      const backupPath = `${outputPath}.backup-${Date.now()}`;
      renameSync(outputPath, backupPath);
      renameSync(tempDir, outputPath);
      rmSync(backupPath, { recursive: true, force: true });
    } else {
      renameSync(tempDir, outputPath);
    }

    // 11. Save metadata
    const metadata: SiteMetadata = {
      recordCid,
      fileCids: newFileCids,
      lastSync: Date.now()
    };
    saveMetadata(outputPath, metadata);

    console.log(pc.green(`\n✓ Pulled ${site} to ${outputPath}\n`));

  } catch (err) {
    // Cleanup temp dir on error
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}
