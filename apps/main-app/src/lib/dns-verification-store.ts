import { db } from './db'
import type { DomainVerificationColumns, DomainVerificationState } from './dns-verification-schedule'
import type { DnsVerificationStore } from './dns-verification-worker'
import { withReservedOAuthLock } from './oauth-lock'

const PASS_LOCK_NAME = 'wisp-dns-verification-pass'

class PassLockBusy extends Error {}

type Epoch = number | string | null

interface DomainRow {
	id: string
	domain: string
	did: string
	verified: boolean
	last_verified_at: Epoch
	verify_failures: number
	verify_failing_since: Epoch
	verify_lost: boolean
	verify_next_at: Epoch
	verify_parked_at: Epoch
	verify_warning: string | null
}

// BIGINT columns can arrive as strings.
const epoch = (value: Epoch): number | null => (value === null ? null : Number(value))

const toState = (row: DomainRow): DomainVerificationState => ({
	id: row.id,
	domain: row.domain,
	did: row.did,
	verified: row.verified === true,
	lastVerifiedAt: epoch(row.last_verified_at),
	failures: Number(row.verify_failures),
	failingSince: epoch(row.verify_failing_since),
	lost: row.verify_lost === true,
	nextCheckAt: epoch(row.verify_next_at),
	parkedAt: epoch(row.verify_parked_at),
	warning: row.verify_warning,
})

/** The primary-database store used by the running worker. */
export const createDnsVerificationStore = (): DnsVerificationStore => ({
	async withPassLock(pass) {
		const reserved = await db.reserve()
		try {
			const value = await withReservedOAuthLock(
				{
					async acquire(): Promise<void> {
						const rows = await reserved<Array<{ locked: boolean }>>`
							SELECT pg_try_advisory_lock(hashtextextended(${PASS_LOCK_NAME}, 0)) AS locked
						`
						if (!rows[0]?.locked) throw new PassLockBusy()
					},
					async unlock(): Promise<void> {
						const rows = await reserved<Array<{ unlocked: boolean }>>`
							SELECT pg_advisory_unlock(hashtextextended(${PASS_LOCK_NAME}, 0)) AS unlocked
						`
						if (!rows[0]?.unlocked) throw new Error('DNS verification pass lock was not held')
					},
					release(): void {
						reserved.release()
					},
					async close(): Promise<void> {
						await reserved.close({ timeout: 0 })
					},
				},
				pass,
				() => {
					console.error('[DNS Verifier] Pass lock cleanup failed')
				},
			)
			return { acquired: true, value }
		} catch (error) {
			if (error instanceof PassLockBusy) return { acquired: false }
			throw error
		}
	},

	async readPassClock() {
		const rows = await db<Array<{ last_pass_at: Epoch; now: Epoch }>>`
			SELECT
				(SELECT last_pass_at FROM dns_verification_state WHERE id = 'default') AS last_pass_at,
				EXTRACT(EPOCH FROM NOW())::BIGINT AS now
		`
		return { lastPassAt: epoch(rows[0]?.last_pass_at ?? null), now: Number(rows[0]?.now) }
	},

	async recordPass(startedAt) {
		await db`
			INSERT INTO dns_verification_state (id, last_pass_at)
			VALUES ('default', ${startedAt})
			ON CONFLICT (id) DO UPDATE SET last_pass_at = EXCLUDED.last_pass_at
		`
	},

	async removeDuplicateRows() {
		const rows = await db<Array<{ removed: number | string }>>`
			WITH ranked AS (
				SELECT
					ctid,
					ROW_NUMBER() OVER (
						PARTITION BY domain
						ORDER BY
							verified DESC,
							(rkey IS NOT NULL) DESC,
							last_verified_at DESC NULLS LAST,
							created_at DESC,
							id DESC
					) AS rn
				FROM custom_domains
			),
			deleted AS (
				DELETE FROM custom_domains cd
				USING ranked r
				WHERE cd.ctid = r.ctid
					AND r.rn > 1
				RETURNING 1
			)
			SELECT COUNT(*)::int AS removed FROM deleted
		`
		return Number(rows[0]?.removed ?? 0)
	},

	async listDomains() {
		const rows = await db<DomainRow[]>`
			SELECT DISTINCT ON (domain)
				id, domain, did, verified, last_verified_at, verify_failures, verify_failing_since,
				verify_lost, verify_next_at, verify_parked_at, verify_warning
			FROM custom_domains
			ORDER BY
				domain,
				verified DESC,
				(rkey IS NOT NULL) DESC,
				last_verified_at DESC NULLS LAST,
				created_at DESC,
				id DESC
		`
		return rows.map(toState)
	},

	async currentOwnerId(domain) {
		const rows = await db<Array<{ id: string }>>`
			SELECT id
			FROM custom_domains
			WHERE domain = ${domain}
			ORDER BY
				verified DESC,
				(rkey IS NOT NULL) DESC,
				last_verified_at DESC NULLS LAST,
				created_at DESC,
				id DESC
			LIMIT 1
		`
		return rows[0]?.id ?? null
	},

	async saveDomain(id: string, did: string, columns: DomainVerificationColumns) {
		const rows = await db`
			UPDATE custom_domains
			SET verified = ${columns.verified},
				last_verified_at = ${columns.lastVerifiedAt},
				verify_failures = ${columns.failures},
				verify_failing_since = ${columns.failingSince},
				verify_lost = ${columns.lost},
				verify_next_at = ${columns.nextCheckAt},
				verify_parked_at = ${columns.parkedAt},
				verify_warning = ${columns.warning}
			WHERE id = ${id} AND did = ${did}
			RETURNING id
		`
		return rows.length > 0
	},
})
