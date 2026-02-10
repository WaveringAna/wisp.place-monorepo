import type { Agent, BlobRef } from '@atproto/api';
import type { Directory, Record as FsRecord } from '@wispplace/lexicons/types/place/wisp/fs';
import type { Record as SubfsRecord } from '@wispplace/lexicons/types/place/wisp/subfs';
import type { Record as SettingsRecord } from '@wispplace/lexicons/types/place/wisp/settings';
import {
  processUploadedFiles,
  updateFileBlobs,
  createManifest,
  estimateDirectorySize,
  findLargeDirectories,
  replaceDirectoryWithSubfs,
  splitDirectoryIntoChunks,
  countFilesInDirectory,
  type UploadedFile,
  type FileUploadResult
} from '@wispplace/fs-utils';
import { computeCID, extractBlobMap, shouldCompressFile, compressFile, extractSubfsUris } from '@wispplace/atproto-utils';
import { MAX_SITE_SIZE, MAX_FILE_COUNT, MAX_FILE_SIZE } from '@wispplace/constants';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import ignore, { type Ignore } from 'ignore';
import { lookup } from 'mime-types';
import { createSpinner, formatBytes, pc } from '../lib/progress.ts';

// Constants for manifest splitting
const MAX_MANIFEST_SIZE = 140 * 1024; // 140KB (PDS limit is 150KB)
const FILE_COUNT_THRESHOLD = 250;
const TARGET_FILE_COUNT = 200;
const MAX_SUBFS_SIZE = 75 * 1024; // 75KB per subfs
const DEFAULT_CONCURRENT_UPLOADS = 3;
const RATELIMITED_CONCURRENT_UPLOADS = 2;

export interface DeployOptions {
  path: string;
  site?: string;
  directory?: boolean;
  spa?: boolean;
  yes?: boolean;
  concurrency?: number;
}

interface FileInfo {
  path: string;
  relativePath: string;
  size: number;
}

// Default ignore patterns
const DEFAULT_IGNORE_PATTERNS = [
  '.git', '.git/**', '.github', '.github/**', '.gitlab', '.gitlab/**',
  '.DS_Store', '.wisp-metadata.json', '.env', '.env.*',
  'node_modules', 'node_modules/**', 'Thumbs.db', 'desktop.ini',
  '._*', '.Spotlight-V100/**', '.Trashes/**', '.fseventsd/**',
  '.cache/**', '.temp/**', '.tmp/**', '__pycache__/**', '*.pyc',
  '.venv/**', 'venv/**', '*.swp', '*.swo', '*~', '.tangled/**',
  '.wispignore'
];

function createIgnoreMatcher(siteDir: string): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_IGNORE_PATTERNS);

  // Load custom .wispignore if exists
  const wispignorePath = join(siteDir, '.wispignore');
  if (existsSync(wispignorePath)) {
    const content = readFileSync(wispignorePath, 'utf-8');
    const patterns = content.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    ig.add(patterns);
  }

  return ig;
}

function collectFiles(dir: string, ig: Ignore, baseDir: string): FileInfo[] {
  const files: FileInfo[] = [];

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = relative(baseDir, fullPath);

    // The ignore package needs trailing '/' for directory-pattern matching
    const isDir = entry.isDirectory();
    if (ig.ignores(isDir ? relativePath + '/' : relativePath)) continue;

    if (isDir) {
      files.push(...collectFiles(fullPath, ig, baseDir));
    } else if (entry.isFile()) {
      const stat = statSync(fullPath);
      files.push({
        path: fullPath,
        relativePath,
        size: stat.size
      });
    }
  }

  return files;
}

async function fetchExistingManifest(
  agent: Agent,
  did: string,
  rkey: string
): Promise<{ record: FsRecord; blobMap: Map<string, { blobRef: BlobRef; cid: string }> } | null> {
  try {
    const response = await agent.com.atproto.repo.getRecord({
      repo: did,
      collection: 'place.wisp.fs',
      rkey
    });

    const record = response.data.value as FsRecord;
    const blobMap = extractBlobMap(record.root);

    // Also fetch any subfs records and merge their blob maps
    const subfsUris = extractSubfsUris(record.root);
    for (const { uri } of subfsUris) {
      try {
        const parts = uri.replace('at://', '').split('/');
        const subfsRepo = parts[0]!;
        const subfsRkey = parts[2]!;

        const subfsResponse = await agent.com.atproto.repo.getRecord({
          repo: subfsRepo,
          collection: 'place.wisp.subfs',
          rkey: subfsRkey
        });

        const subfsRecord = subfsResponse.data.value as SubfsRecord;
        const subfsBlobMap = extractBlobMap(subfsRecord.root as unknown as Directory);
        subfsBlobMap.forEach((value, key) => blobMap.set(key, value));
      } catch {
        // Subfs not found, skip
      }
    }

    return { record, blobMap };
  } catch {
    return null;
  }
}

async function uploadBlob(
  agent: Agent,
  content: Buffer,
  mimeType: string,
  retries = 3,
  onRateLimit?: () => void
): Promise<BlobRef> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await agent.com.atproto.repo.uploadBlob(content, {
        encoding: mimeType
      });
      return response.data.blob;
    } catch (err: any) {
      if (attempt === retries - 1) throw err;

      // Handle rate limits
      if (err?.status === 429) {
        onRateLimit?.();
        const delay = Math.pow(2, attempt) * 2000;
        await new Promise(r => setTimeout(r, delay));
      } else {
        const delay = Math.pow(2, attempt) * 500;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error('Failed to upload blob after retries');
}

async function processAndUploadFiles(
  agent: Agent,
  files: FileInfo[],
  existingBlobMap: Map<string, { blobRef: BlobRef; cid: string }>,
  concurrency: number
): Promise<{ uploadedFiles: UploadedFile[]; uploadResults: FileUploadResult[]; filePaths: string[] }> {
  const spinner = createSpinner(`Processing ${files.length} files...`).start();

  const uploadedFiles: UploadedFile[] = [];
  const uploadResults: FileUploadResult[] = [];
  const filePaths: string[] = [];

  let uploaded = 0;
  let reused = 0;
  let currentConcurrency = concurrency;

  const onRateLimit = () => {
    const reduced = Math.min(currentConcurrency, RATELIMITED_CONCURRENT_UPLOADS);
    if (reduced < currentConcurrency) {
      currentConcurrency = reduced;
      spinner.text = `Rate limited — reducing concurrency to ${currentConcurrency}`;
    }
  };

  // Process in batches for concurrency
  for (let i = 0; i < files.length; i += currentConcurrency) {
    const batch = files.slice(i, i + currentConcurrency);

    await Promise.all(batch.map(async (file) => {
      const content = readFileSync(file.path);
      const mimeType = lookup(file.relativePath) || 'application/octet-stream';
      const shouldCompress = shouldCompressFile(mimeType, file.relativePath);

      let processedContent: Buffer;
      let encoding: 'gzip' | undefined;
      let base64Encoded = false;

      if (shouldCompress) {
        // Compress with gzip
        const compressed = compressFile(content);
        // Base64 encode
        processedContent = Buffer.from(compressed.toString('base64'));
        encoding = 'gzip';
        base64Encoded = true;
      } else {
        processedContent = content;
      }

      // Compute CID
      const cid = computeCID(processedContent);

      // Check if blob already exists
      const existing = existingBlobMap.get(file.relativePath);
      let blobRef: BlobRef;

      if (existing && existing.cid === cid) {
        // Reuse existing blob
        blobRef = existing.blobRef;
        reused++;
      } else {
        // Upload new blob
        blobRef = await uploadBlob(agent, processedContent, 'application/octet-stream', 3, onRateLimit);
        uploaded++;
      }

      uploadedFiles.push({
        name: file.relativePath,
        content: processedContent,
        mimeType,
        size: processedContent.length,
        compressed: shouldCompress,
        base64Encoded,
        originalMimeType: mimeType
      });

      uploadResults.push({
        hash: cid,
        blobRef,
        encoding,
        mimeType,
        base64: base64Encoded || undefined
      });

      filePaths.push(file.relativePath);

      spinner.text = `Processing files: ${uploaded + reused}/${files.length} (${uploaded} uploaded, ${reused} reused)`;
    }));
  }

  spinner.succeed(`Processed ${files.length} files (${uploaded} uploaded, ${reused} reused)`);

  return { uploadedFiles, uploadResults, filePaths };
}

async function createSubfsRecord(
  agent: Agent,
  did: string,
  directory: Directory,
  rkey: string
): Promise<string> {
  const record = {
    $type: 'place.wisp.subfs' as const,
    root: directory as any, // fs Directory and subfs Directory are compatible at runtime
    fileCount: countFilesInDirectory(directory),
    createdAt: new Date().toISOString()
  };

  await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: 'place.wisp.subfs',
    rkey,
    record
  });

  return `at://${did}/place.wisp.subfs/${rkey}`;
}

async function splitIntoSubfs(
  agent: Agent,
  did: string,
  directory: Directory,
  siteRkey: string
): Promise<{ directory: Directory; subfsRkeys: string[] }> {
  const spinner = createSpinner('Splitting large site into subfs records...').start();
  const subfsRkeys: string[] = [];
  let currentDir = directory;
  let currentFileCount = countFilesInDirectory(currentDir);
  let iteration = 0;
  let chunkCounter = 0;

  let manifest = createManifest(siteRkey, currentDir, currentFileCount);
  let manifestSize = JSON.stringify(manifest).length;

  while ((manifestSize > MAX_MANIFEST_SIZE || currentFileCount > TARGET_FILE_COUNT) && iteration < 100) {
    iteration++;

    // Find all directories sorted by size (largest first)
    const directories = findLargeDirectories(currentDir);
    directories.sort((a, b) => b.size - a.size);

    if (directories.length > 0) {
      const largest = directories[0]!;
      spinner.text = `Split #${iteration}: ${largest.path} (${largest.fileCount} files, ${formatBytes(largest.size)})`;

      let subfsUri: string;

      // Check if directory is too large for a single subfs record
      if (largest.size > MAX_SUBFS_SIZE) {
        // Split into chunks
        console.log(pc.dim(`\n    → Directory too large (${formatBytes(largest.size)}), splitting into chunks...`));
        const chunks = splitDirectoryIntoChunks(largest.directory, MAX_SUBFS_SIZE);
        console.log(pc.dim(`    → Created ${chunks.length} chunks`));

        // Upload each chunk as a subfs record
        const chunkUris: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i]!;
          const chunkRkey = `${siteRkey}-chunk-${chunkCounter++}`;
          const chunkSize = estimateDirectorySize(chunk);
          const chunkFileCount = countFilesInDirectory(chunk);

          console.log(pc.dim(`    → Uploading chunk ${i + 1}/${chunks.length} (${chunkFileCount} files, ${formatBytes(chunkSize)})...`));

          const chunkUri = await createSubfsRecord(agent, did, chunk, chunkRkey);
          chunkUris.push(chunkUri);
          subfsRkeys.push(chunkRkey);
        }

        // Create parent subfs that references all chunks with flat: true
        console.log(pc.dim(`    → Creating parent subfs with ${chunkUris.length} chunk references...`));

        const parentEntries = chunkUris.map((uri, i) => ({
          name: `chunk${i}`,
          node: {
            $type: 'place.wisp.fs#subfs' as const,
            type: 'subfs' as const,
            subject: uri,
            flat: true
          }
        }));

        const parentDirectory: Directory = {
          $type: 'place.wisp.fs#directory' as const,
          type: 'directory' as const,
          entries: parentEntries
        };

        const parentRkey = `${siteRkey}-subfs-${iteration}`;
        subfsUri = await createSubfsRecord(agent, did, parentDirectory, parentRkey);
        subfsRkeys.push(parentRkey);

        console.log(pc.green(`    ✓ Created parent subfs with ${chunks.length} chunks`));
      } else {
        // Directory fits in a single subfs record
        const subfsRkey = `${siteRkey}-subfs-${iteration}`;
        subfsUri = await createSubfsRecord(agent, did, largest.directory, subfsRkey);
        subfsRkeys.push(subfsRkey);
      }

      // Replace directory with subfs reference
      currentDir = replaceDirectoryWithSubfs(currentDir, largest.path, subfsUri);
      currentFileCount -= largest.fileCount;
    } else {
      // No subdirectories — split flat files at root level
      const rootFiles = currentDir.entries.filter(e => 'type' in e.node && e.node.type === 'file');

      if (rootFiles.length === 0) {
        spinner.fail(`Cannot split further — no files or directories available (${currentFileCount} files, ${(manifestSize / 1024).toFixed(1)}KB)`);
        break;
      }

      // Take a chunk of ~100 files
      const CHUNK_SIZE = 100;
      const chunkFiles = rootFiles.slice(0, Math.min(CHUNK_SIZE, rootFiles.length));
      spinner.text = `Split #${iteration}: flat root (${chunkFiles.length} files)`;

      // Create a directory with just these files
      const chunkDirectory: Directory = {
        $type: 'place.wisp.fs#directory' as const,
        type: 'directory' as const,
        entries: chunkFiles
      };

      const subfsRkey = `${siteRkey}-subfs-${iteration}`;
      const subfsUri = await createSubfsRecord(agent, did, chunkDirectory, subfsRkey);
      subfsRkeys.push(subfsRkey);

      // Remove chunked files and add a flat subfs entry
      const remainingEntries = currentDir.entries.filter(
        e => !chunkFiles.some(cf => cf.name === e.name)
      );

      remainingEntries.push({
        name: `__subfs_${iteration}`,
        node: {
          $type: 'place.wisp.fs#subfs' as const,
          type: 'subfs' as const,
          subject: subfsUri,
          flat: true
        }
      });

      currentDir = {
        $type: 'place.wisp.fs#directory' as const,
        type: 'directory' as const,
        entries: remainingEntries
      };

      currentFileCount -= chunkFiles.length;
    }

    // Recreate manifest and check new size
    manifest = createManifest(siteRkey, currentDir, currentFileCount);
    manifestSize = JSON.stringify(manifest).length;
  }

  spinner.succeed(`Created ${subfsRkeys.length} subfs records`);

  return { directory: currentDir, subfsRkeys };
}

async function deleteOldSubfsRecords(
  agent: Agent,
  did: string,
  oldRecord: FsRecord | null,
  newSubfsRkeys: string[]
): Promise<void> {
  if (!oldRecord) return;

  const oldSubfsUris = extractSubfsUris(oldRecord.root);
  const newSubfsSet = new Set(newSubfsRkeys);

  for (const { uri } of oldSubfsUris) {
    const parts = uri.replace('at://', '').split('/');
    const rkey = parts[2];
    if (rkey && !newSubfsSet.has(rkey)) {
      try {
        await agent.com.atproto.repo.deleteRecord({
          repo: did,
          collection: 'place.wisp.subfs',
          rkey
        });
      } catch {
        // Ignore deletion errors
      }
    }
  }
}

export async function deploy(
  agent: Agent,
  did: string,
  options: DeployOptions
): Promise<{ uri: string; url: string }> {
  const siteDir = options.path;
  const siteName = options.site || basename(siteDir);

  // Validate site name (AT Protocol rkey format)
  if (!/^[a-zA-Z0-9._~:-]{1,512}$/.test(siteName)) {
    throw new Error(`Invalid site name: ${siteName}. Must be 1-512 chars of [a-zA-Z0-9._~:-]`);
  }

  console.log(pc.cyan(`\nDeploying ${pc.bold(siteName)} from ${siteDir}\n`));

  // 1. Collect files
  const spinner = createSpinner('Scanning directory...').start();
  const ig = createIgnoreMatcher(siteDir);
  const files = collectFiles(siteDir, ig, siteDir);

  if (files.length === 0) {
    spinner.fail('No files found to deploy');
    throw new Error('No files found');
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  spinner.succeed(`Found ${files.length} files (${formatBytes(totalSize)})`);

  // 2. Validate limits
  if (files.length > MAX_FILE_COUNT) {
    console.log(pc.yellow(`\nWarning: Site has ${files.length} files (limit: ${MAX_FILE_COUNT})`));
    console.log(pc.yellow('Site may not be cached by the hosting service.\n'));
  }

  if (totalSize > MAX_SITE_SIZE) {
    console.log(pc.yellow(`\nWarning: Site is ${formatBytes(totalSize)} (limit: ${formatBytes(MAX_SITE_SIZE)})`));
    console.log(pc.yellow('Site may not be cached by the hosting service.\n'));
  }

  // Check individual file sizes
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File ${file.relativePath} exceeds max size (${formatBytes(file.size)} > ${formatBytes(MAX_FILE_SIZE)})`);
    }
  }

  // 3. Fetch existing manifest for incremental upload
  const existingSpinner = createSpinner('Checking for existing site...').start();
  const existing = await fetchExistingManifest(agent, did, siteName);
  const existingBlobMap = existing?.blobMap || new Map();

  if (existing) {
    existingSpinner.succeed('Found existing site, will reuse unchanged files');
  } else {
    existingSpinner.succeed('No existing site found, uploading all files');
  }

  // 4. Process and upload files
  const { uploadedFiles, uploadResults, filePaths } = await processAndUploadFiles(
    agent,
    files,
    existingBlobMap,
    options.concurrency ?? DEFAULT_CONCURRENT_UPLOADS
  );

  // 5. Build directory structure
  // CLI paths are already relative to site directory, so skip normalization
  const { directory: rawDirectory, fileCount } = processUploadedFiles(uploadedFiles, { skipNormalization: true });
  const successfulPaths = new Set(filePaths);
  const directory = updateFileBlobs(rawDirectory, uploadResults, filePaths, '', successfulPaths, { skipNormalization: true });

  // 6. Split into subfs if needed
  let finalDirectory = directory;
  let subfsRkeys: string[] = [];

  const initialManifest = createManifest(siteName, directory, fileCount);
  if (
    fileCount >= FILE_COUNT_THRESHOLD ||
    JSON.stringify(initialManifest).length > MAX_MANIFEST_SIZE
  ) {
    const result = await splitIntoSubfs(agent, did, directory, siteName);
    finalDirectory = result.directory;
    subfsRkeys = result.subfsRkeys;
  }

  // 7. Create manifest
  const manifestSpinner = createSpinner('Creating manifest...').start();
  const manifest = createManifest(siteName, finalDirectory, countFilesInDirectory(finalDirectory));

  await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: 'place.wisp.fs',
    rkey: siteName,
    record: manifest
  });

  manifestSpinner.succeed('Created manifest record');

  // 8. Clean up old subfs records
  await deleteOldSubfsRecords(agent, did, existing?.record || null, subfsRkeys);

  // 9. Create settings if requested
  if (options.directory || options.spa) {
    const settingsSpinner = createSpinner('Creating settings...').start();

    const settings: SettingsRecord = {
      $type: 'place.wisp.settings',
      directoryListing: options.directory || false,
      cleanUrls: true,
      ...(options.spa && { spaMode: 'index.html' })
    };

    await agent.com.atproto.repo.putRecord({
      repo: did,
      collection: 'place.wisp.settings',
      rkey: siteName,
      record: settings
    });

    settingsSpinner.succeed('Created settings record');
  }

  const uri = `at://${did}/place.wisp.fs/${siteName}`;
  const url = `https://sites.wisp.place/${did}/${siteName}`;

  return { uri, url };
}
