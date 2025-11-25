// Path utilities
export { sanitizePath, normalizePath } from './path';

// Tree processing
export type { UploadedFile, FileUploadResult, ProcessedDirectory } from './tree';
export { processUploadedFiles, updateFileBlobs, countFilesInDirectory, collectFileCidsFromEntries } from './tree';

// Manifest creation
export { createManifest } from './manifest';

// Subfs splitting utilities
export { estimateDirectorySize, findLargeDirectories, replaceDirectoryWithSubfs } from './subfs-split';
