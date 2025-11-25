import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import {
	claimCustomDomain,
	getCustomDomainInfo,
	deleteCustomDomain,
	updateCustomDomainVerification,
	db
} from './db'

describe('custom domain claiming', () => {
	const testDid1 = 'did:plc:testuser1'
	const testDid2 = 'did:plc:testuser2'
	const testDomain = 'example-test-domain.com'
	const hash1 = 'testhash12345678'
	const hash2 = 'testhash87654321'
	const hash3 = 'testhash11111111'

	beforeAll(async () => {
		// Clean up any existing test data
		try {
			await db`DELETE FROM custom_domains WHERE domain = ${testDomain}`
		} catch (err) {
			// Ignore errors if table doesn't exist or other issues
		}
	})

	afterAll(async () => {
		// Clean up test data
		try {
			await db`DELETE FROM custom_domains WHERE domain = ${testDomain}`
		} catch (err) {
			// Ignore cleanup errors
		}
	})

	test('should allow first user to claim a domain', async () => {
		const result = await claimCustomDomain(testDid1, testDomain, hash1)
		expect(result.success).toBe(true)
		expect(result.hash).toBe(hash1)

		const domainInfo = await getCustomDomainInfo(testDomain)
		expect(domainInfo).toBeTruthy()
		expect(domainInfo!.domain).toBe(testDomain)
		expect(domainInfo!.did).toBe(testDid1)
		expect(domainInfo!.verified).toBe(false)
		expect(domainInfo!.id).toBe(hash1)
	})

	test('should allow second user to claim an unverified domain', async () => {
		const result = await claimCustomDomain(testDid2, testDomain, hash2)
		expect(result.success).toBe(true)
		expect(result.hash).toBe(hash2)

		const domainInfo = await getCustomDomainInfo(testDomain)
		expect(domainInfo).toBeTruthy()
		expect(domainInfo!.domain).toBe(testDomain)
		expect(domainInfo!.did).toBe(testDid2) // Should have changed
		expect(domainInfo!.verified).toBe(false)
		expect(domainInfo!.id).toBe(hash2) // Should have changed
	})

	test('should prevent claiming a verified domain', async () => {
		// First verify the domain for testDid2
		await updateCustomDomainVerification(hash2, true)

		// Now try to claim it with testDid1 - should fail
		try {
			await claimCustomDomain(testDid1, testDomain, hash3)
			expect('Should have thrown an error when trying to claim a verified domain').fail()
		} catch (err) {
			expect((err as Error).message).toBe('conflict')
		}

		// Verify the domain is still owned by testDid2 and verified
		const domainInfo = await getCustomDomainInfo(testDomain)
		expect(domainInfo).toBeTruthy()
		expect(domainInfo!.did).toBe(testDid2)
		expect(domainInfo!.verified).toBe(true)
		expect(domainInfo!.id).toBe(hash2)
	})

	test('should allow claiming after unverification', async () => {
		// Unverify the domain
		await updateCustomDomainVerification(hash2, false)

		// Now should be claimable again
		const result = await claimCustomDomain(testDid1, testDomain, hash3)
		expect(result.success).toBe(true)
		expect(result.hash).toBe(hash3)

		const domainInfo = await getCustomDomainInfo(testDomain)
		expect(domainInfo).toBeTruthy()
		expect(domainInfo!.did).toBe(testDid1) // Should have changed back
		expect(domainInfo!.verified).toBe(false)
		expect(domainInfo!.id).toBe(hash3)
	})

	test('should handle concurrent claims gracefully', async () => {
		// Both users try to claim at the same time - one should win
		const promise1 = claimCustomDomain(testDid1, testDomain, hash1)
		const promise2 = claimCustomDomain(testDid2, testDomain, hash2)

		const [result1, result2] = await Promise.allSettled([promise1, promise2])
		
		// At least one should succeed
		const successCount = [result1, result2].filter(r => r.status === 'fulfilled').length
		expect(successCount).toBeGreaterThan(0)
		expect(successCount).toBeLessThanOrEqual(2)

		// Final state should be consistent
		const domainInfo = await getCustomDomainInfo(testDomain)
		expect(domainInfo).toBeTruthy()
		expect(domainInfo!.verified).toBe(false)
		expect([hash1, hash2]).toContain(domainInfo!.id)
	})
})