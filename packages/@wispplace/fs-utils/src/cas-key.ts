import { createHash } from 'node:crypto'

/**
 * Content-addressed names for stored site file bodies.
 *
 * The stored body is not a function of the blob CID alone: the writer derives it from the blob
 * bytes plus the manifest's `mimeType`, `encoding` and `base64`. The key therefore pairs the
 * source CID with a `variant` over those flags, so two manifests that interpret one blob
 * differently never share an object.
 */

const KEY_PREFIX = 'cas/'
const VARIANT_VERSION = 'v1'
const VARIANT_LENGTH = 8
const MAX_CID_LENGTH = 512
const MAX_EXTENSION_LENGTH = 16

const CID_PATTERN = /^[A-Za-z0-9]+$/
const EXTENSION_PATTERN = /^[a-z0-9]+$/
const CAS_KEY_PATTERN = /^cas\/([A-Za-z0-9]{1,512})\.([0-9a-f]{8})(?:\.([a-z0-9]{1,16}))?$/

export interface CasVariantFlags {
	readonly mimeType?: string
	readonly encoding?: string
	readonly base64?: boolean
}

export interface CasObjectIdentity extends CasVariantFlags {
	/** Source blob CID, verified against the downloaded bytes before anything is stored. */
	readonly cid: string
	/** Manifest path. Only its extension is used, so tier placement rules keep matching. */
	readonly path: string
}

export interface ParsedCasKey {
	readonly cid: string
	readonly variant: string
	readonly ext?: string
}

/** Hash of the manifest flags that decide the stored bytes and their metadata. */
export function casVariant(flags: CasVariantFlags): string {
	// NUL separators make field boundaries unambiguous; the version prefix lets a future
	// derivation coexist with objects already stored under this one.
	const canonical = [
		VARIANT_VERSION,
		flags.mimeType ?? '',
		flags.encoding ?? '',
		flags.base64 === true ? '1' : '0',
	].join('\0')
	return createHash('sha256').update(canonical).digest('hex').slice(0, VARIANT_LENGTH)
}

function pathExtension(path: string): string | undefined {
	const name = path.slice(path.lastIndexOf('/') + 1)
	const dot = name.lastIndexOf('.')
	// A leading dot is a dotfile, not an extension; a trailing dot has none.
	if (dot <= 0 || dot === name.length - 1) return undefined
	const ext = name.slice(dot + 1).toLowerCase()
	return ext.length <= MAX_EXTENSION_LENGTH && EXTENSION_PATTERN.test(ext) ? ext : undefined
}

/** `cas/{cid}.{variant}[.{ext}]`. Throws on a CID that could alter the key's structure. */
export function casKey(identity: CasObjectIdentity): string {
	const { cid } = identity
	if (cid.length === 0 || cid.length > MAX_CID_LENGTH || !CID_PATTERN.test(cid)) {
		throw new Error(`Invalid CID for content-addressed key (length ${cid.length})`)
	}
	const ext = pathExtension(identity.path)
	return `${KEY_PREFIX}${cid}.${casVariant(identity)}${ext ? `.${ext}` : ''}`
}

/** Inverse of {@link casKey}; null for anything that is not exactly one of its outputs. */
export function parseCasKey(key: string): ParsedCasKey | null {
	const match = CAS_KEY_PATTERN.exec(key)
	if (!match) return null
	const [, cid, variant, ext] = match
	return ext === undefined
		? { cid: cid ?? '', variant: variant ?? '' }
		: { cid: cid ?? '', variant: variant ?? '', ext }
}

export function isCasKey(key: string): boolean {
	return CAS_KEY_PATTERN.test(key)
}
