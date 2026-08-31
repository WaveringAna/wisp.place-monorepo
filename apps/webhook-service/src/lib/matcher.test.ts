import { describe, expect, test } from 'bun:test'
import type { WebhookEntry } from './db'
import { collectRelevantAtUriReferences, matchWebhooks, parseAtUri, validateWebhookRecord } from './matcher'

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
