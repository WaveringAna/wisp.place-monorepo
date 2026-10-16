import { describe, expect, test } from 'bun:test'
import { Secp256k1Keypair } from '@atproto/crypto'
import { formatLabel, isLabelSubject, signLabel, verifyLabel } from './labels'

const SRC = 'did:plc:25fzqofm2xkx27bcaicxbyxk'
const CTS = '2026-10-16T12:00:00.000Z'

describe('formatLabel', () => {
	test('keeps only the fields that are set, and neg only when true', () => {
		expect(formatLabel(SRC, { uri: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', val: '!takedown', neg: false }, CTS)).toEqual({
			ver: 1,
			src: SRC,
			uri: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
			val: '!takedown',
			cts: CTS,
		})
		const negated = formatLabel(SRC, { uri: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', val: 'spam', neg: true }, CTS)
		expect(negated.neg).toBe(true)
		expect(Object.keys(negated)).not.toContain('cid')
		expect(Object.keys(negated)).not.toContain('exp')
	})
})

describe('signLabel', () => {
	test('a signature verifies against the signing did:key and breaks when the label changes', async () => {
		const keypair = await Secp256k1Keypair.create()
		const label = await signLabel(
			formatLabel(SRC, { uri: 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/place.wisp.fs/site', val: '!takedown' }, CTS),
			keypair,
		)
		expect(label.sig).toHaveLength(64)
		expect(await verifyLabel(label, keypair.did())).toBe(true)
		expect(await verifyLabel({ ...label, val: '!hide' }, keypair.did())).toBe(false)
		expect(await verifyLabel({ ...label, neg: true }, keypair.did())).toBe(false)
		const other = await Secp256k1Keypair.create()
		expect(await verifyLabel(label, other.did())).toBe(false)
	})
})

describe('isLabelSubject', () => {
	test('accepts account DIDs and record URIs, nothing else', () => {
		expect(isLabelSubject('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true)
		expect(isLabelSubject('did:web:example.com')).toBe(true)
		expect(isLabelSubject('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/place.wisp.fs/my-site')).toBe(true)
		expect(isLabelSubject('at://example.com/place.wisp.fs/my-site')).toBe(false)
		expect(isLabelSubject('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
		expect(isLabelSubject('https://example.com')).toBe(false)
		expect(isLabelSubject('did:plc:short')).toBe(false)
	})
})
