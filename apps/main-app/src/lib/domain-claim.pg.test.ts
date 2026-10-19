import { describe, expect, test } from 'bun:test'

// Runs only against a disposable local database, e.g.
// TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/wisp_main_app_test NODE_ENV=test bun test domain-claim.pg
const enabled = Boolean(process.env.TEST_DATABASE_URL)

describe.skipIf(!enabled)('wisp domain claims (postgres)', () => {
	test('parallel claims by one account stop at the three-domain limit', async () => {
		const { db, claimDomain } = await import('./db')
		const { runDatabaseMigrations } = await import('./migrations')
		await runDatabaseMigrations(db)
		const did = `did:plc:race${Date.now()}`
		const results = await Promise.allSettled(
			Array.from({ length: 10 }, (_, i) => claimDomain(did, `race-${Date.now()}-${i}`)),
		)
		const rows = await db`SELECT count(*)::int AS count FROM domains WHERE did = ${did}`
		expect(rows[0].count).toBe(3)
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
		const reasons = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason?.message)] : []))
		expect(new Set(reasons)).toEqual(new Set(['domain_limit_reached']))
	})

	test('private site usage counts each owner, leaving out sites being deleted', async () => {
		const { db } = await import('./db')
		const owner = `did:plc:usage${Date.now()}`
		await db`
			INSERT INTO private_sites (site_id, owner_did, name, file_count, total_bytes, state, expires_at) VALUES
				(${`${owner}-a`}, ${owner}, 'a', 3, 1000, 'ready', NULL),
				(${`${owner}-b`}, ${owner}, 'b', 2, 500, 'ready', NOW() + interval '1 day'),
				(${`${owner}-c`}, ${owner}, 'c', 9, 9000, 'deleting', NULL)
		`
		await db`
			INSERT INTO private_site_shares (share_id, site_id, token_hash, token_prefix, revoked_at) VALUES
				(${`${owner}-s1`}, ${`${owner}-a`}, ${`${owner}-h1`}, 'p', NULL),
				(${`${owner}-s2`}, ${`${owner}-a`}, ${`${owner}-h2`}, 'p', NOW())
		`
		const [usage] =
			await db`SELECT sites::int, never_expiring::int, files::int, bytes::int FROM private_site_usage WHERE owner_did = ${owner}`
		expect(usage).toEqual({ sites: 2, never_expiring: 1, files: 5, bytes: 1500 })
		const [shares] =
			await db`SELECT shares::int, active_shares::int FROM private_site_share_usage WHERE owner_did = ${owner}`
		expect(shares).toEqual({ shares: 2, active_shares: 1 })

		const { createPresentationReadQueries } = await import('./presentation-reads')
		const report = await createPresentationReadQueries(db).getAdminDatabaseReport()
		expect(report.privateSites.sites).toBeGreaterThanOrEqual(2)
		expect(report.privateSites.topOwners.some((row: { owner_did: string }) => row.owner_did === owner)).toBe(true)
	})
})
