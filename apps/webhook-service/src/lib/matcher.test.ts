import { describe, expect, test } from 'bun:test'
import type { WebhookEntry } from './db'
import {
	collectRelevantAtUriReferences,
	jsonMayReferenceDids,
	matchWebhooks,
	parseAtUri,
	validateWebhookRecord,
} from './matcher'

const DID_A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const DID_B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'

function webhook(scope: string, options: Partial<Record<string, unknown>> = {}): WebhookEntry {
	return {
		ownerDid: DID_A,
		rkey: 'hook',
		record: {
			$type: 'place.wisp.v2.wh',
			scope: { aturi: scope },
			url: 'https://receiver.example/hook',
			createdAt: '2025-01-01T00:00:00.000Z',
			...options,
		} as WebhookEntry['record'],
	}
}

describe('webhook matcher bounds and canonical scopes', () => {
	test('rejects handles and sanitizes only known valid WH fields', () => {
		expect(parseAtUri('at://alice.test/app.bsky.feed.post')).toBeNull()
		expect(parseAtUri(`at://${DID_A}/app.bsky.feed.post`)).not.toBeNull()
		const result = validateWebhookRecord({
			$type: 'place.wisp.v2.wh',
			scope: { aturi: `at://${DID_A}` },
			url: 'https://receiver.example/hook',
			createdAt: '2025-01-01T00:00:00Z',
			events: ['create', 'create'],
		})
		expect(result).toBeNull()
		expect(
			validateWebhookRecord({
				$type: 'place.wisp.v2.wh',
				scope: { aturi: `at://${DID_A}` },
				url: 'https://receiver.example/hook',
				createdAt: '2025-01-01T00:00:00Z',
				secret: 'inline',
				secretId: 'managed',
			}),
		).toBeNull()
		expect(
			validateWebhookRecord({
				$type: 'place.wisp.v2.wh',
				scope: { aturi: `at://${DID_A}` },
				url: 'https://receiver.example/hook',
				createdAt: '2025-01-01T00:00:00Z',
				secret: '',
			}),
		).toBeNull()
	})

	test('matches direct events and only whole AT-URI backlink string values', () => {
		const direct = webhook(`at://${DID_A}/app.bsky.feed.post`)
		expect(matchWebhooks([direct], DID_A, 'app.bsky.feed.post', 'one', 'create', {})).toHaveLength(1)

		const backlink = webhook(`at://${DID_B}/app.bsky.feed.post`, {
			scope: { aturi: `at://${DID_B}/app.bsky.feed.post`, backlinks: true },
		})
		expect(
			matchWebhooks([backlink], DID_A, 'app.bsky.feed.like', 'one', 'create', {
				text: `see at://${DID_B}/app.bsky.feed.post/one`,
			}),
		).toHaveLength(0)
		expect(
			matchWebhooks([backlink], DID_A, 'app.bsky.feed.like', 'one', 'create', {
				uri: `at://${DID_B}/app.bsky.feed.post/one.`,
			}),
		).toHaveLength(1)
		const didBacklink = webhook(`at://${DID_B}`, {
			scope: { aturi: `at://${DID_B}`, backlinks: true },
		})
		expect(
			matchWebhooks([didBacklink], DID_A, 'app.bsky.feed.post', 'mention', 'create', {
				text: '@target.example',
				facets: [{ features: [{ $type: 'app.bsky.richtext.facet#mention', did: DID_B }] }],
			}),
		).toHaveLength(1)
		// A random DID-shaped field is not a backlink; only the explicit facet shape is.
		expect(
			matchWebhooks([didBacklink], DID_A, 'app.bsky.feed.post', 'not-a-mention', 'create', { did: DID_B }),
		).toHaveLength(0)
		const hostileMention: Record<string, unknown> = { did: DID_B }
		Object.defineProperty(hostileMention, '$type', {
			enumerable: true,
			get: () => {
				throw new Error('accessor must not run')
			},
		})
		expect(
			matchWebhooks([didBacklink], DID_A, 'app.bsky.feed.post', 'hostile-mention', 'create', {
				facets: [{ features: [hostileMention] }],
			}),
		).toHaveLength(0)
	})

	test('backlinksOnly fires only for other repos that reference the scope', () => {
		const onlyBacklinks = webhook(`at://${DID_B}`, {
			scope: { aturi: `at://${DID_B}`, backlinksOnly: true },
		})
		const mentionOfB = {
			text: '@target.example',
			facets: [{ features: [{ $type: 'app.bsky.richtext.facet#mention', did: DID_B }] }],
		}
		// Another repo mentioning the scope DID fires.
		expect(matchWebhooks([onlyBacklinks], DID_A, 'app.bsky.feed.post', 'other', 'create', mentionOfB)).toHaveLength(1)
		// The scope DID's own events never fire: neither a direct match...
		expect(matchWebhooks([onlyBacklinks], DID_B, 'app.bsky.feed.post', 'own', 'create', { text: 'hi' })).toHaveLength(0)
		// ...nor its own record that references itself.
		expect(matchWebhooks([onlyBacklinks], DID_B, 'app.bsky.feed.post', 'self', 'create', mentionOfB)).toHaveLength(0)
		// A plain backlinks subscription still receives the scope's own events.
		const withDirect = webhook(`at://${DID_B}`, { scope: { aturi: `at://${DID_B}`, backlinks: true } })
		expect(matchWebhooks([withDirect], DID_B, 'app.bsky.feed.post', 'own', 'create', { text: 'hi' })).toHaveLength(1)
	})

	test('handles cyclic, deep, and prototype-hostile records without recursive overflow', () => {
		const cyclic: Record<string, unknown> = Object.create(null)
		cyclic.self = cyclic
		const deep: Record<string, unknown> = {}
		let cursor = deep
		for (let index = 0; index < 128; index++) {
			const child: Record<string, unknown> = {}
			cursor.child = child
			cursor = child
		}
		cursor.uri = `at://${DID_B}`
		const result = collectRelevantAtUriReferences(
			{ cyclic, deep },
			(reference) => reference.startsWith(`at://${DID_B}`),
			100,
		)
		expect(result.references).toEqual([])
		expect(result.tooComplex).toBe(true)
	})

	test('marks property and relevant-reference caps too complex instead of partial matching', () => {
		const properties: Record<string, unknown> = {}
		for (let index = 0; index < 257; index++) properties[`p${index}`] = `at://${DID_B}/app.bsky.feed.post/${index}`
		const propertyResult = collectRelevantAtUriReferences(properties, () => true, 100)
		expect(propertyResult.tooComplex).toBe(true)

		const refs: Record<string, unknown> = {}
		for (let index = 0; index < 101; index++) refs[`r${index}`] = `at://${DID_B}/app.bsky.feed.post/${index}`
		const referenceResult = collectRelevantAtUriReferences(refs, () => true, 100, { maxPropertiesPerObject: 200 })
		expect(referenceResult.references).toHaveLength(100)
		expect(referenceResult.tooComplex).toBe(true)
	})
})

describe('relay text pre-check', () => {
	const WEB = 'did:web:example.com'
	const scopes = new Set([DID_A, WEB])
	const json = (record: unknown) => JSON.stringify({ did: DID_B, commit: { record } })

	test('finds scope DIDs only behind at://, ignoring the dots trimming removes', () => {
		expect(jsonMayReferenceDids(json({ text: 'hello' }), scopes)).toBe(false)
		expect(jsonMayReferenceDids(json({ subject: { uri: `at://${DID_B}/app.bsky.feed.post/x` } }), scopes)).toBe(false)
		expect(jsonMayReferenceDids(json({ subject: { uri: `at://${DID_A}/app.bsky.feed.post/x` } }), scopes)).toBe(true)
		expect(jsonMayReferenceDids(json({ text: `at://${WEB}.` }), scopes)).toBe(true)
		expect(jsonMayReferenceDids(json({ text: `at://${WEB}.org` }), scopes)).toBe(false)
		expect(jsonMayReferenceDids(json({ did: DID_A }), scopes)).toBe(false)
	})

	test('answers "walk it" for escapes that could hide a reference, and for mentions', () => {
		expect(jsonMayReferenceDids(`{"uri":"at:\\/\\/${DID_B}"}`, scopes)).toBe(true)
		expect(jsonMayReferenceDids(`{"uri":"\\u0061t://${DID_B}"}`, scopes)).toBe(true)
		expect(jsonMayReferenceDids(json({ $type: 'app.bsky.richtext.facet#mention', did: DID_B }), scopes)).toBe(true)
	})

	test('never rules out a record whose walk finds a scope reference', () => {
		let seed = 14
		const random = () => {
			seed = (seed + 0x6d2b79f5) | 0
			let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
			value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
			return ((value ^ (value >>> 14)) >>> 0) / 4294967296
		}
		const pieces = [
			'at://',
			DID_A,
			DID_B,
			WEB,
			'.',
			')',
			'/',
			'app.bsky.feed.post',
			'x',
			'A',
			':',
			' ',
			'\n',
			'"',
			'\\',
			'\u00a0',
			'\u0001',
		]
		const text = () =>
			Array.from({ length: 1 + Math.floor(random() * 6) }, () => pieces[Math.floor(random() * pieces.length)]).join('')
		const value = (depth: number): unknown => {
			const roll = random()
			if (depth > 2 || roll < 0.5) return text()
			if (roll < 0.6) return { $type: 'app.bsky.richtext.facet#mention', did: random() < 0.5 ? DID_A : DID_B }
			if (roll < 0.8) return [value(depth + 1), value(depth + 1)]
			return { a: value(depth + 1), b: value(depth + 1) }
		}
		const relevant = (aturi: string) => scopes.has(parseAtUri(aturi)?.did ?? '')
		let ruledOut = 0
		let referenced = 0
		for (let index = 0; index < 20_000; index++) {
			const record = { text: value(0), embed: value(0) }
			const found = collectRelevantAtUriReferences(record, relevant, 256).references.length > 0
			if (found) referenced++
			if (jsonMayReferenceDids(json(record), scopes)) continue
			ruledOut++
			expect(found).toBe(false)
		}
		expect(ruledOut).toBeGreaterThan(1_000)
		expect(referenced).toBeGreaterThan(1_000)
	})
})
