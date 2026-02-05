/**
 * Tiered Storage Library
 *
 * A lightweight, pluggable tiered storage library that orchestrates caching across
 * hot (memory), warm (disk/database), and cold (S3/object storage) tiers.
 *
 * @packageDocumentation
 */

// Main class
export { TieredStorage } from './TieredStorage.js';

// Built-in tier implementations
export { MemoryStorageTier, type MemoryStorageTierConfig } from './tiers/MemoryStorageTier.js';
export {
	DiskStorageTier,
	type DiskStorageTierConfig,
	type EvictionPolicy,
} from './tiers/DiskStorageTier.js';
export { S3StorageTier, type S3StorageTierConfig } from './tiers/S3StorageTier.js';

// Types
export type {
	StorageTier,
	StorageMetadata,
	TierStats,
	TierGetResult,
	TierStreamResult,
	AllTierStats,
	TieredStorageConfig,
	PlacementRule,
	SetOptions,
	StreamSetOptions,
	StorageResult,
	StreamResult,
	SetResult,
	StorageSnapshot,
} from './types/index.js';

// Utilities
export {
	compress,
	decompress,
	isGzipped,
	createCompressStream,
	createDecompressStream,
} from './utils/compression.js';
export { defaultSerialize, defaultDeserialize } from './utils/serialization.js';
export { calculateChecksum, verifyChecksum } from './utils/checksum.js';
export { encodeKey, decodeKey } from './utils/path-encoding.js';
