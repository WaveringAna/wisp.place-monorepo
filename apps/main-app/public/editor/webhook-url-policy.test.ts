import { describe, expect, test } from 'bun:test'
import { canUseLocalLoopbackWebhookHttp, validateEditorWebhookEndpointUrl } from './webhook-url-policy'

describe('webhook editor URL policy', () => {
	test('requires HTTPS in production', () => {
		expect(validateEditorWebhookEndpointUrl('https://receiver.example/hook', { allowLoopbackDev: false }).ok).toBe(true)
		expect(validateEditorWebhookEndpointUrl('http://receiver.example/hook', { allowLoopbackDev: false }).ok).toBe(false)
		expect(
			validateEditorWebhookEndpointUrl('https://user:password@receiver.example/hook', { allowLoopbackDev: false }).ok,
		).toBe(false)
	})

	test('allows HTTP only for a local loopback development page and endpoint', () => {
		expect(canUseLocalLoopbackWebhookHttp('http://localhost:8000/editor')).toBe(true)
		expect(canUseLocalLoopbackWebhookHttp('https://wisp.place/editor')).toBe(false)
		expect(validateEditorWebhookEndpointUrl('http://127.0.0.1:9876/hook', { allowLoopbackDev: true }).ok).toBe(true)
		expect(validateEditorWebhookEndpointUrl('http://receiver.example/hook', { allowLoopbackDev: true }).ok).toBe(false)
	})
})
