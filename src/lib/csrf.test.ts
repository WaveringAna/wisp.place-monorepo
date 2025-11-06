import { describe, test, expect } from 'bun:test'
import { verifyRequestOrigin } from './csrf'

describe('verifyRequestOrigin', () => {
	test('should accept matching origin and host', () => {
		expect(verifyRequestOrigin('https://example.com', ['example.com'])).toBe(true)
		expect(verifyRequestOrigin('http://localhost:8000', ['localhost:8000'])).toBe(true)
		expect(verifyRequestOrigin('https://app.example.com', ['app.example.com'])).toBe(true)
	})

	test('should accept origin matching one of multiple allowed hosts', () => {
		const allowedHosts = ['example.com', 'app.example.com', 'localhost:8000']
		expect(verifyRequestOrigin('https://example.com', allowedHosts)).toBe(true)
		expect(verifyRequestOrigin('https://app.example.com', allowedHosts)).toBe(true)
		expect(verifyRequestOrigin('http://localhost:8000', allowedHosts)).toBe(true)
	})

	test('should reject non-matching origin', () => {
		expect(verifyRequestOrigin('https://evil.com', ['example.com'])).toBe(false)
		expect(verifyRequestOrigin('https://fake-example.com', ['example.com'])).toBe(false)
		expect(verifyRequestOrigin('https://example.com.evil.com', ['example.com'])).toBe(false)
	})

	test('should reject empty origin', () => {
		expect(verifyRequestOrigin('', ['example.com'])).toBe(false)
	})

	test('should reject invalid URL format', () => {
		expect(verifyRequestOrigin('not-a-url', ['example.com'])).toBe(false)
		expect(verifyRequestOrigin('javascript:alert(1)', ['example.com'])).toBe(false)
		expect(verifyRequestOrigin('file:///etc/passwd', ['example.com'])).toBe(false)
	})

	test('should handle different protocols correctly', () => {
		// Same host, different protocols should match (we only check host)
		expect(verifyRequestOrigin('http://example.com', ['example.com'])).toBe(true)
		expect(verifyRequestOrigin('https://example.com', ['example.com'])).toBe(true)
	})

	test('should handle port numbers correctly', () => {
		expect(verifyRequestOrigin('http://localhost:3000', ['localhost:3000'])).toBe(true)
		expect(verifyRequestOrigin('http://localhost:3000', ['localhost:8000'])).toBe(false)
		expect(verifyRequestOrigin('http://localhost', ['localhost'])).toBe(true)
	})

	test('should handle subdomains correctly', () => {
		expect(verifyRequestOrigin('https://sub.example.com', ['sub.example.com'])).toBe(true)
		expect(verifyRequestOrigin('https://sub.example.com', ['example.com'])).toBe(false)
	})

	test('should handle case sensitivity (exact match required)', () => {
		// URL host is automatically lowercased by URL parser
		expect(verifyRequestOrigin('https://EXAMPLE.COM', ['example.com'])).toBe(true)
		expect(verifyRequestOrigin('https://example.com', ['example.com'])).toBe(true)
		// But allowed hosts are case-sensitive
		expect(verifyRequestOrigin('https://example.com', ['EXAMPLE.COM'])).toBe(false)
	})

	test('should handle trailing slashes in origin', () => {
		expect(verifyRequestOrigin('https://example.com/', ['example.com'])).toBe(true)
	})

	test('should handle paths in origin (host extraction)', () => {
		expect(verifyRequestOrigin('https://example.com/path/to/page', ['example.com'])).toBe(true)
		expect(verifyRequestOrigin('https://evil.com/example.com', ['example.com'])).toBe(false)
	})

	test('should reject when allowed hosts is empty', () => {
		expect(verifyRequestOrigin('https://example.com', [])).toBe(false)
	})

	test('should handle IPv4 addresses', () => {
		expect(verifyRequestOrigin('http://127.0.0.1:8000', ['127.0.0.1:8000'])).toBe(true)
		expect(verifyRequestOrigin('http://192.168.1.1', ['192.168.1.1'])).toBe(true)
	})

	test('should handle IPv6 addresses', () => {
		expect(verifyRequestOrigin('http://[::1]:8000', ['[::1]:8000'])).toBe(true)
		expect(verifyRequestOrigin('http://[2001:db8::1]', ['[2001:db8::1]'])).toBe(true)
	})
})
