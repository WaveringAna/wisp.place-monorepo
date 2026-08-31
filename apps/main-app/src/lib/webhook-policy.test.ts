import { describe, expect, test } from 'bun:test'
import {
	isWebhookOwnerAtCapacity,
	MAX_WEBHOOK_LIST_LIMIT,
	normalizeWebhookListLimit,
	validateWebhookCreateInput,
	type WebhookCreateInput,
} from './webhook-policy'

const did = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const valid = {
	scopeAturi: `at://${did}`,
	url: 'https://receiver.example/hook',
	events: ['create', 'update'] as const,
}

describe('main webhook API policy', () => {
	test('accepts a canonical DID-only scope and HTTPS endpoint', () => {
		const result = validateWebhookCreateInput(valid, { allowLoopbackDev: false })
		expect(result.ok).toBe(true)
		if (result.ok) expect(result.record.scope.aturi).toBe(valid.scopeAturi)
	})

	test('rejects HTTP, handle scopes, duplicate/oversized events, and conflicting secret forms before PDS writes', () => {
		const invalidInputs: WebhookCreateInput[] = [
			{ ...valid, url: 'http://receiver.example/hook' },
			{ ...valid, scopeAturi: 'at://alice.example' },
			{ ...valid, events: ['create', 'create'] },
			{ ...valid, events: ['create', 'update', 'delete', 'create'] },
			{ ...valid, secret: 'inline', secretId: 'managed' },
			{ ...valid, secret: 'x'.repeat(257) },
			{ ...valid, secretId: 'x'.repeat(65) },
			{ ...valid, secretId: 'secret-☃' },
			{ ...valid, secretId: 'secret/name' },
			{ ...valid, secretId: 'secret%2Fname' },
			{ ...valid, url: `https://receiver.example/${'x'.repeat(2_049)}` },
			{ ...valid, scopeAturi: `at://${did}/${'x'.repeat(2_049)}` },
		]
		for (const input of invalidInputs) {
			expect(validateWebhookCreateInput(input, { allowLoopbackDev: false }).ok).toBe(false)
		}
	})

	test('uses the same exact secret-ID boundary as secret management', () => {
		expect(validateWebhookCreateInput({ ...valid, secretId: 'a'.repeat(64) }, { allowLoopbackDev: false }).ok).toBe(
			true,
		)
	})

	test('permits HTTP only for explicitly enabled loopback development', () => {
		expect(
			validateWebhookCreateInput({ ...valid, url: 'http://127.0.0.1:43123/hook' }, { allowLoopbackDev: false }).ok,
		).toBe(false)
		expect(
			validateWebhookCreateInput({ ...valid, url: 'http://127.0.0.1:43123/hook' }, { allowLoopbackDev: true }).ok,
		).toBe(true)
		expect(
			validateWebhookCreateInput({ ...valid, url: 'http://not-loopback.example/hook' }, { allowLoopbackDev: true }).ok,
		).toBe(false)
	})

	test('enforces the owner quota at exactly 50 records', () => {
		expect(isWebhookOwnerAtCapacity(49)).toBe(false)
		expect(isWebhookOwnerAtCapacity(50)).toBe(true)
		expect(isWebhookOwnerAtCapacity(51)).toBe(true)
	})

	test('bounds public webhook list pages', () => {
		expect(normalizeWebhookListLimit(undefined)).toBe(MAX_WEBHOOK_LIST_LIMIT)
		expect(normalizeWebhookListLimit(0)).toBe(MAX_WEBHOOK_LIST_LIMIT)
		expect(normalizeWebhookListLimit(1)).toBe(1)
		expect(normalizeWebhookListLimit(10_000)).toBe(MAX_WEBHOOK_LIST_LIMIT)
	})
})
