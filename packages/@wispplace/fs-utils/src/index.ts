// Path utilities

// Content-addressed storage keys
export type { CasObjectIdentity, CasVariantFlags, ParsedCasKey } from './cas-key'
export { casKey, casVariant, isCasKey, parseCasKey } from './cas-key'
export type { CasReferenceDiff, FileObjects } from './cas-refs'
export { diffCasReferences, distinctCasKeys, normalizeFileObjects } from './cas-refs'
// File CID normalization
export type { FileCidsNormalization, FileCidsNormalizationSource } from './file-cids'
export { normalizeFileCids } from './file-cids'
// HTML rewriting for wisp basePath-scoped serving
export { isHtmlContent, rewriteHtmlPaths } from './html-rewriter'
// Manifest creation
export { createManifest } from './manifest'
export type { NormalizeSitePathOptions } from './path'
export { normalizePath, normalizeSitePath, sanitizePath } from './path'
// Redirects parsing and matching
export type { MatchRedirectContext, RedirectMatch, RedirectRule } from './redirects'
export {
	MAX_REDIRECT_FILE_BYTES,
	matchRedirectRule,
	parseCookies,
	parseQueryString,
	parseRedirectsFile,
	parseRedirectsFileBytes,
} from './redirects'

// Subfs splitting utilities
export {
	estimateDirectorySize,
	findLargeDirectories,
	findSplittableDirectory,
	type LargeDirectory,
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
