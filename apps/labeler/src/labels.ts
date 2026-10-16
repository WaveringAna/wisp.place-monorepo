import { type Keypair, Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import { encode } from '@atproto/lex-cbor'

/** A label as the atproto label spec defines it (`com.atproto.label.defs#label`), version 1. */
export type Label = {
	ver: 1
	src: string
	uri: string
	cid?: string
	val: string
	neg?: true
	cts: string
	exp?: string
}

export type SignedLabel = Label & { sig: Uint8Array }

export type LabelInput = {
	uri: string
	cid?: string
	val: string
	neg?: boolean
	exp?: string
}

/**
 * The label fields in the shape that is signed and sent: `neg` only when true and
 * no undefined optional fields, so the bytes a verifier re-encodes match ours.
 */
export function formatLabel(src: string, input: LabelInput, cts: string): Label {
	return {
		ver: 1,
		src,
		uri: input.uri,
		...(input.cid ? { cid: input.cid } : {}),
		val: input.val,
		...(input.neg ? { neg: true as const } : {}),
		cts,
		...(input.exp ? { exp: input.exp } : {}),
	}
}

/** Sign the DAG-CBOR encoding of the label without `sig` (atproto label spec, "Signature"). */
export async function signLabel(label: Label, keypair: Keypair): Promise<SignedLabel> {
	const sig = await keypair.sign(encode(label))
	return { ...label, sig }
}

export async function verifyLabel(label: SignedLabel, didKey: string): Promise<boolean> {
	const { sig, ...unsigned } = label
	return verifySignature(didKey, encode(unsigned as Label), sig)
}

export async function loadSigningKey(hex: string): Promise<Secp256k1Keypair> {
	return Secp256k1Keypair.import(hex, { exportable: false })
}

const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]+(:[a-zA-Z0-9.%-]+)*)$/
const AT_URI = /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]+)\/([a-zA-Z0-9.-]+)\/([a-zA-Z0-9._~:-]{1,512})$/
const CID = /^b[a-z2-7]{20,}$/

/** A label subject: an account DID, or the AT-URI of one record. */
export function isLabelSubject(uri: string): boolean {
	if (DID.test(uri)) return true
	const match = AT_URI.exec(uri)
	return match !== null && DID.test(match[1] ?? '')
}

export function isCid(value: string): boolean {
	return CID.test(value)
}
