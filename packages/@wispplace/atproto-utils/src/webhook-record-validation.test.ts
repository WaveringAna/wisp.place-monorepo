import { describe, expect, test } from 'bun:test'
import { validateWebhookRecord } from './webhook-record-validation'

const baseRecord = {
	$type: 'place.wisp.v2.wh',
	scope: { aturi: 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' },
	url: 'https://webhook.example.test/events',
	createdAt: '2026-08-30T00:00:00.000Z',
} as const

describe('webhook inline secret validation', () => {
	test('rejects an explicitly empty signing secret', () => {
		expect(validateWebhookRecord({ ...baseRecord, secret: '' })).toEqual({ ok: false, kind: 'secret' })
	})

	test('accepts an omitted or non-empty signing secret', () => {
		expect(validateWebhookRecord(baseRecord).ok).toBe(true)
		expect(validateWebhookRecord({ ...baseRecord, secret: 'non-empty' }).ok).toBe(true)
	})
})

describe('webhook backlinksOnly scope flag', () => {
	test('accepts and copies backlinksOnly on its own or with backlinks: true', () => {
		for (const scope of [
			{ ...baseRecord.scope, backlinksOnly: true },
			{ ...baseRecord.scope, backlinks: true, backlinksOnly: true },
			{ ...baseRecord.scope, backlinksOnly: false },
		]) {
			const result = validateWebhookRecord({ ...baseRecord, scope })
			expect(result.ok).toBe(true)
			if (result.ok) expect(result.record.scope.backlinksOnly).toBe(scope.backlinksOnly)
		}
	})

	test('rejects a non-boolean backlinksOnly and one that contradicts backlinks: false', () => {
		expect(validateWebhookRecord({ ...baseRecord, scope: { ...baseRecord.scope, backlinksOnly: 'yes' } })).toEqual({
			ok: false,
			kind: 'scope',
		})
		expect(
			validateWebhookRecord({ ...baseRecord, scope: { ...baseRecord.scope, backlinks: false, backlinksOnly: true } }),
		).toEqual({ ok: false, kind: 'scope' })
	})
})
