import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL
const integrationTimeoutMs = 15_000

if (!integrationDatabaseUrl) {
	describe.skip('custom domain claiming integration (requires TEST_DATABASE_URL)', () => {
		test('is skipped without an explicit disposable database URL', () => undefined)
	})
} else {
	// db.ts resolves TEST_DATABASE_URL only in NODE_ENV=test. It rejects any
	// non-loopback endpoint or database name other than wisp_main_app_test before
	// opening a connection, so this test cannot inherit DATABASE_URL.
	const { claimCustomDomain, closeDatabase, db, getCustomDomainInfo, updateCustomDomainVerification } = await import(
		'./db'
	)
	const runId = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
	const testDid1 = `did:plc:testuser1${runId}`
	const testDid2 = `did:plc:testuser2${runId}`
	const testDomain = `db-claim-${runId}.example.test`
	const hash1 = `testhash1${runId}`
	const hash2 = `testhash2${runId}`
	const hash3 = `testhash3${runId}`

	describe('custom domain claiming integration', () => {
		beforeAll(
			async () => {
				await db`DELETE FROM custom_domains WHERE domain = ${testDomain}`
			},
			{ timeout: integrationTimeoutMs },
		)

		afterAll(
			async () => {
				try {
					await db`DELETE FROM custom_domains WHERE domain = ${testDomain}`
				} finally {
					await closeDatabase()
				}
			},
			{ timeout: integrationTimeoutMs },
		)

		test(
			'allows the first user to claim a domain',
			async () => {
				const result = await claimCustomDomain(testDid1, testDomain, hash1)
				expect(result.success).toBe(true)
				expect(result.hash).toBe(hash1)

				const domainInfo = await getCustomDomainInfo(testDomain)
				expect(domainInfo).toBeTruthy()
				expect(domainInfo!.domain).toBe(testDomain)
				expect(domainInfo!.did).toBe(testDid1)
				expect(domainInfo!.verified).toBe(false)
				expect(domainInfo!.id).toBe(hash1)
			},
			integrationTimeoutMs,
		)

		test(
			'allows a second user to claim an unverified domain',
			async () => {
				const result = await claimCustomDomain(testDid2, testDomain, hash2)
				expect(result.success).toBe(true)
				expect(result.hash).toBe(hash2)

				const domainInfo = await getCustomDomainInfo(testDomain)
				expect(domainInfo).toBeTruthy()
				expect(domainInfo!.domain).toBe(testDomain)
				expect(domainInfo!.did).toBe(testDid2)
				expect(domainInfo!.verified).toBe(false)
				expect(domainInfo!.id).toBe(hash2)
			},
			integrationTimeoutMs,
		)

		test(
			'prevents claiming a verified domain',
			async () => {
				await updateCustomDomainVerification(hash2, true)

				await expect(claimCustomDomain(testDid1, testDomain, hash3)).rejects.toThrow('conflict')

				const domainInfo = await getCustomDomainInfo(testDomain)
				expect(domainInfo).toBeTruthy()
				expect(domainInfo!.did).toBe(testDid2)
				expect(domainInfo!.verified).toBe(true)
				expect(domainInfo!.id).toBe(hash2)
			},
			integrationTimeoutMs,
		)

		test(
			'allows claiming after unverification',
			async () => {
				await updateCustomDomainVerification(hash2, false)

				const result = await claimCustomDomain(testDid1, testDomain, hash3)
				expect(result.success).toBe(true)
				expect(result.hash).toBe(hash3)

				const domainInfo = await getCustomDomainInfo(testDomain)
				expect(domainInfo).toBeTruthy()
				expect(domainInfo!.did).toBe(testDid1)
				expect(domainInfo!.verified).toBe(false)
				expect(domainInfo!.id).toBe(hash3)
			},
			integrationTimeoutMs,
		)

		test(
			'handles concurrent claims gracefully',
			async () => {
				const promise1 = claimCustomDomain(testDid1, testDomain, hash1)
				const promise2 = claimCustomDomain(testDid2, testDomain, hash2)

				const [result1, result2] = await Promise.allSettled([promise1, promise2])
				const successCount = [result1, result2].filter((result) => result.status === 'fulfilled').length
				expect(successCount).toBeGreaterThan(0)
				expect(successCount).toBeLessThanOrEqual(2)

				const domainInfo = await getCustomDomainInfo(testDomain)
				expect(domainInfo).toBeTruthy()
				expect(domainInfo!.verified).toBe(false)
				expect([hash1, hash2]).toContain(domainInfo!.id)
			},
			integrationTimeoutMs,
		)
	})
}
