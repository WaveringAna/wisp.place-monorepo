// Path utilities

// File CID normalization
export type { FileCidsNormalization, FileCidsNormalizationSource } from './file-cids'
export { normalizeFileCids } from './file-cids'
// HTML rewriting for wisp basePath-scoped serving
export { isHtmlContent, rewriteHtmlPaths } from './html-rewriter'
// Manifest creation
export { createManifest } from './manifest'
export { normalizePath, sanitizePath } from './path'
// Redirects parsing and matching
export type { MatchRedirectContext, RedirectMatch, RedirectRule } from './redirects'
export { matchRedirectRule, parseCookies, parseQueryString, parseRedirectsFile } from './redirects'

// Subfs splitting utilities
export {
	estimateDirectorySize,
	findLargeDirectories,
	replaceDirectoryWithSubfs,
	splitDirectoryIntoChunks,
} from './subfs-split'
// Tree processing
export type {
	FileUploadResult,
	ProcessedDirectory,
	ProcessUploadedFilesOptions,
	UpdateFileBlobsOptions,
	UploadedFile,
} from './tree'
export { collectFileCidsFromEntries, countFilesInDirectory, processUploadedFiles, updateFileBlobs } from './tree'
export { toSubfsDirectory } from './types'
