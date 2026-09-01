// Blob utilities
export { computeCID, extractBlobCid, extractBlobMap } from './blob'

// Compression utilities
export { compressFile, isTextMimeType, shouldCompressFile, shouldCompressMimeType } from './compression'
export type {
	CachedIdentityGetFetcher,
	IdentityCacheOptions,
	IdentityCacheRequestOptions,
	IdentityDnsResolver,
	IdentityFetchOptions,
	IdentityGetFetcher,
	IdentityPdsOptions,
	IdentityResolvedAddress,
	PinnedIdentityFetcherOptions,
	PinnedIdentityRequest,
	PinnedIdentityTransport,
} from './identity'
// Identity utilities
export {
	createCachedIdentityFetcher,
	createPinnedIdentityFetcher,
	didWebToHttps,
	getDidDocument,
	getHandleForDid,
	getPdsForDid,
	isIdentityLoopbackDevelopmentAllowed,
	isPublicIdentityAddress,
	MAX_IDENTITY_JSON_BYTES,
	readBoundedIdentityJson,
	resolveDid,
	resolvePdsFromHandle,
	unsafeRawIdentityGet,
	validatePdsEndpoint,
} from './identity'
// DNS-pinned keep-alive connection pooling
export type { PinnedAgentAddress, PinnedAgentFamily } from './pinned-agent'
export { closePinnedKeepAliveAgents, pinnedKeepAliveAgent } from './pinned-agent'
export type {
	ExpandedSubfs,
	ExpandSubfsOptions,
	FetchSubfsRecord,
	SubfsExpansionErrorCode,
	SubfsExpansionLimits,
	SubfsSubject,
} from './subfs'
// Subfs utilities
export {
	DEFAULT_SUBFS_EXPANSION_LIMITS,
	expandSubfs,
	expandSubfsNodes,
	extractSubfsUris,
	parseSubfsSubject,
	SubfsExpansionError,
} from './subfs'
export type {
	ParsedWebhookScope,
	WebhookEventKind,
	WebhookRecordValidationErrorKind,
	WebhookRecordValidationOptions,
	WebhookRecordValidationResult,
} from './webhook-record-validation'
// Webhook record validation shared by intake, backfill, and API routes
export {
	isCanonicalWebhookDid,
	parseWebhookScopeAtUri,
	validateWebhookRecord,
	validateWebhookUrlSyntax,
} from './webhook-record-validation'
export type { WebhookSecretEncryptionEnvironment, WebhookSecretEncryptionKeyring } from './webhook-secret-encryption'
// Server-managed webhook secret encryption utilities
export {
	createWebhookSecretEncryptionKeyringFromEnv,
	decryptWebhookSecret,
	encryptWebhookSecret,
	isWebhookSecretEnvelopeCandidate,
	MAX_WEBHOOK_SECRET_BYTES,
	parseWebhookSecretEncryptionKeyring,
	WEBHOOK_SECRET_ENCRYPTION_ERROR,
	WEBHOOK_SECRET_ENVELOPE_PREFIX,
	WEBHOOK_SECRET_ENVELOPE_VERSION,
	WebhookSecretEncryptionError,
} from './webhook-secret-encryption'
// Canonical server-managed webhook signing-secret IDs
export {
	isValidWebhookSecretId,
	MAX_WEBHOOK_SECRET_ID_LENGTH,
	WEBHOOK_SECRET_ID_PATTERN,
} from './webhook-secret-id'
