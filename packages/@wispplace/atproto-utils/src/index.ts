// Blob utilities
export { computeCID, extractBlobMap, extractBlobCid } from './blob';

// Compression utilities
export { shouldCompressFile, shouldCompressMimeType, compressFile } from './compression';

// Subfs utilities
export { extractSubfsUris } from './subfs';

// Identity utilities
export {
  resolveDid,
  getPdsForDid,
  getDidDocument,
  getHandleForDid,
  didWebToHttps,
  resolvePdsFromHandle
} from './identity';
