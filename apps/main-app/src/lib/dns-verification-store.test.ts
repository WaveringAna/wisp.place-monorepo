import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { VerificationResult } from './dns-verify'

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL
const integrationTimeoutMs = 15_000

if (!integrationDatabaseUrl) {
	describe.skip('DNS verification store integration (requires TEST_DATABASE_URL)', () => {
		test('is skipped without an explicit disposable database URL', () => undefined)
	})
} else {
	// db.ts accepts only the loopback wisp_main_app_test database in NODE_ENV=test.
	const { claimCustomDomain, closeDatabase, db, updateCustomDomainVerification } = await import('./db')
	const { createDnsVerificationStore } = await import('./dns-verification-store')
	const { DNSVerificationWorker } = await import('./dns-verification-worker')
	const { DEFAULT_DNS_VERIFICATION_POLICY } = await import('./dns-verification-schedule')

	const runId = crypto.randomUUID().replaceAll('-', '').slice(0, 16)
	const did = `did:plc:dnsworker${runId}`
	const domains = Array.from({ length: 4 }, (_, i) => `dns-worker-${i}-${runId}.example.test`)
	const ids = domains.map((_, i) => `${runId}${i}`)

	const resetPassClock = async () => {
		await db`DELETE FROM dns_verification_state`
	}

	const worker = (verify: (domain: string) => Promise<VerificationResult>) =>
		new DNSVerificationWorker({
			store: createDnsVerificationStore(),
			policy: DEFAULT_DNS_VERIFICATION_POLICY,
			verify: (domain) => verify(domain),
			sleep: async () => undefined,
		})

	describe('DNS verification store integration', () => {
		beforeAll(
			async () => {
				await db`DELETE FROM custom_domains`
				for (const [i, domain] of domains.entries()) await claimCustomDomain(did, domain, ids[i] as string)
			},
			{ timeout: integrationTimeoutMs },
		)

		afterAll(
			async () => {
				try {
					await db`DELETE FROM custom_domains WHERE did = ${did}`
					await resetPassClock()
				} finally {
					await closeDatabase()
				}
			},
			{ timeout: integrationTimeoutMs },
		)

		test(
			'two workers started together run one pass and check each domain once',
			async () => {
				await resetPassClock()
				const checked: string[] = []
				const verify = async (domain: string): Promise<VerificationResult> => {
					checked.push(domain)
					await Bun.sleep(50)
					return { verified: false, error: 'TXT record mismatch', found: { txt: [] } }
				}

				const outcomes = await Promise.all([worker(verify).runPass(false), worker(verify).runPass(false)])

				expect(outcomes.sort()).toEqual(['completed', 'locked'])
				expect(checked.sort()).toEqual([...domains].sort())
				// The interval has not passed, so another tick anywhere skips.
				expect(await worker(verify).runPass(false)).toBe('recent')
				expect(checked).toHaveLength(domains.length)

				const rows = await db<Array<{ verify_failures: number; verify_next_at: string }>>`
					SELECT verify_failures, verify_next_at FROM custom_domains WHERE did = ${did}
				`
				expect(rows.map((row) => row.verify_failures)).toEqual([1, 1, 1, 1])
			},
			integrationTimeoutMs,
		)

		test(
			'a parked domain is checked again after its owner verifies it',
			async () => {
				const [domain] = domains
				const id = ids[0] as string
				await db`
					UPDATE custom_domains
					SET verify_failures = 12, verify_failing_since = 1, verify_parked_at = 2, verify_next_at = 3
					WHERE id = ${id}
				`
				await resetPassClock()
				const checked: string[] = []
				const missing = async (name: string): Promise<VerificationResult> => {
					checked.push(name)
					return { verified: false, error: 'TXT record mismatch', found: { txt: [] } }
				}
				await worker(missing).runPass(false)
				expect(checked).not.toContain(domain)

				// The owner's check fails too, but it must still unpark the domain.
				await updateCustomDomainVerification(id, false)
				await resetPassClock()
				checked.length = 0
				await worker(async (name) => {
					checked.push(name)
					return { verified: true, found: { txt: [did] } }
				}).runPass(false)

				expect(checked).toContain(domain)
				const [row] = await db<Array<{ verified: boolean; verify_parked_at: string | null; verify_failures: number }>>`
					SELECT verified, verify_parked_at, verify_failures FROM custom_domains WHERE id = ${id}
				`
				expect(row).toEqual({ verified: true, verify_parked_at: null, verify_failures: 0 })
			},
			integrationTimeoutMs,
		)

		test(
			'a verified domain keeps serving through a failing pass and clears the streak when it passes',
			async () => {
				const id = ids[1] as string
				await updateCustomDomainVerification(id, true)
				const readRow = async () => {
					const [row] = await db<
						Array<{ verified: boolean; verify_failures: number; verify_failing_since: string | null }>
					>`
						SELECT verified, verify_failures, verify_failing_since FROM custom_domains WHERE id = ${id}
					`
					return row
				}

				await resetPassClock()
				await worker(async () => ({
					verified: false,
					error: 'DNS lookup failed: No NS records',
					found: { txt: [] },
				})).runPass(false)
				expect(await readRow()).toMatchObject({ verified: true, verify_failures: 1 })
				expect((await readRow())?.verify_failing_since).not.toBeNull()

				await resetPassClock()
				await worker(async () => ({ verified: true, found: { txt: [did] } })).runPass(false)
				expect(await readRow()).toEqual({ verified: true, verify_failures: 0, verify_failing_since: null })
			},
			integrationTimeoutMs,
		)
	})
}
