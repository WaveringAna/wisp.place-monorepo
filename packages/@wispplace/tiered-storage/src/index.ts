/**
 * Tiered Storage Library
 *
 * A lightweight, pluggable tiered storage library that orchestrates caching across
 * hot (memory), warm (disk/database), and cold (S3/object storage) tiers.
 *
 * @packageDocumentation
 */

// Main class
export { TieredStorage } from './TieredStorage.js'
export {
	DiskStorageTier,
	type DiskStorageTierConfig,
	type EvictionPolicy,
} from './tiers/DiskStorageTier.js'
// Built-in tier implementations
export { MemoryStorageTier, type MemoryStorageTierConfig } from './tiers/MemoryStorageTier.js'
export { S3StorageTier, type S3StorageTierConfig } from './tiers/S3StorageTier.js'

// Types
export type {
	AllTierStats,
	PlacementRule,
	SetOptions,
	SetResult,
	StorageMetadata,
	StorageResult,
	StorageSnapshot,
	StorageTier,
	StreamResult,
	StreamSetOptions,
	TieredStorageConfig,
	TierGetResult,
	TierStats,
	TierStreamResult,
} from './types/index.js'
export { calculateChecksum, verifyChecksum } from './utils/checksum.js'
// Utilities
export {
	compress,
	createCompressStream,
	createDecompressStream,
	decompress,
	isGzipped,
} from './utils/compression.js'
export { decodeKey, encodeKey } from './utils/path-encoding.js'
export { defaultDeserialize, defaultSerialize } from './utils/serialization.js'
