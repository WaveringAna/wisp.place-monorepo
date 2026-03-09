// Blob utilities
export { computeCID, extractBlobCid, extractBlobMap } from './blob'

// Compression utilities
export { compressFile, isTextMimeType, shouldCompressFile, shouldCompressMimeType } from './compression'
// Identity utilities
export {
	didWebToHttps,
	getDidDocument,
	getHandleForDid,
	getPdsForDid,
	resolveDid,
	resolvePdsFromHandle,
} from './identity'
// Subfs utilities
export { extractSubfsUris } from './subfs'
