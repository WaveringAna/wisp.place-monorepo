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
