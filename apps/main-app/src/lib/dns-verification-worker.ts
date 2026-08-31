import { db } from './db'
import {
	classifyVerificationFailure,
	MAX_WARNING_DETAILS_PER_PASS,
	shouldLogDiagnosticDetail,
} from './dns-verification-logging'
import { verifyCustomDomain } from './dns-verify'

export type DNSVerificationLogLevel = 'info' | 'warn' | 'error'

interface VerificationStats {
	totalChecked: number
	verified: number
	failed: number
	errors: number
}

interface VerificationPassStats extends VerificationStats {
	domains: number
	pending: number
	missingDns: number
	previouslyVerifiedFailed: number
	newlyVerified: number
	warnings: number
	cnameAdvisoryFailures: number
	ownershipChanged: number
	duplicatesRemoved: number
	diagnosticDetailsLogged: number
	diagnosticDetailsSuppressed: number
	warningDetailsLogged: number
	warningDetailsSuppressed: number
}

export class DNSVerificationWorker {
	private interval: Timer | null = null
	private isRunning = false
	private lastRunTime: number | null = null
	private stats: VerificationStats = {
		totalChecked: 0,
		verified: 0,
		failed: 0,
		errors: 0,
	}

	constructor(
		private checkIntervalMs: number = 60 * 60 * 1000, // 1 hour default
		private onLog?: (message: string, data?: Record<string, unknown>, level?: DNSVerificationLogLevel) => void,
	) {}

	private log(message: string, data?: Record<string, unknown>, level: DNSVerificationLogLevel = 'info') {
		this.onLog?.(message, data, level)
	}

	private async cleanupDuplicateDomainRows(): Promise<number> {
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

		const value = rows[0]?.removed ?? 0
		return typeof value === 'string' ? Number.parseInt(value, 10) : value
	}

	async start() {
		if (this.isRunning) {
			this.log('DNS verification worker already running')
			return
		}

		this.isRunning = true
		this.log('Starting DNS verification worker', {
			intervalMinutes: this.checkIntervalMs / 60000,
		})

		// Run immediately on start
		await this.verifyAllDomains()

		// Then run on interval
		this.interval = setInterval(() => {
			this.verifyAllDomains()
		}, this.checkIntervalMs)
	}

	stop() {
		if (this.interval) {
			clearInterval(this.interval)
			this.interval = null
		}
		this.isRunning = false
		this.log('DNS verification worker stopped')
	}

	private async verifyAllDomains() {
		const startTime = Date.now()
		const runStats: VerificationPassStats = {
			domains: 0,
			totalChecked: 0,
			verified: 0,
			failed: 0,
			errors: 0,
			pending: 0,
			missingDns: 0,
			previouslyVerifiedFailed: 0,
			newlyVerified: 0,
			warnings: 0,
			cnameAdvisoryFailures: 0,
			ownershipChanged: 0,
			duplicatesRemoved: 0,
			diagnosticDetailsLogged: 0,
			diagnosticDetailsSuppressed: 0,
			warningDetailsLogged: 0,
			warningDetailsSuppressed: 0,
		}
		let completed = false
		let fatalError = false
		let diagnosticDetailsLogged = 0
		let warningDetailsLogged = 0

		const logDiagnostic = (message: string, data: Record<string, unknown>, level: DNSVerificationLogLevel = 'warn') => {
			if (shouldLogDiagnosticDetail(diagnosticDetailsLogged)) {
				diagnosticDetailsLogged++
				runStats.diagnosticDetailsLogged++
				this.log(message, data, level)
			} else {
				runStats.diagnosticDetailsSuppressed++
			}
		}

		const logWarning = (message: string, data: Record<string, unknown>) => {
			if (shouldLogDiagnosticDetail(warningDetailsLogged, MAX_WARNING_DETAILS_PER_PASS)) {
				warningDetailsLogged++
				runStats.warningDetailsLogged++
				this.log(message, data, 'warn')
			} else {
				runStats.warningDetailsSuppressed++
			}
		}

		try {
			runStats.duplicatesRemoved = await this.cleanupDuplicateDomainRows()

			// Get all custom domains (both verified and pending)
			const domains = await db<
				Array<{
					id: string
					domain: string
					did: string
					verified: boolean
				}>
			>`
        SELECT DISTINCT ON (domain) id, domain, did, verified
        FROM custom_domains
        ORDER BY
          domain,
          verified DESC,
          (rkey IS NOT NULL) DESC,
          last_verified_at DESC NULLS LAST,
          created_at DESC,
          id DESC
      `

			runStats.domains = domains?.length ?? 0
			if (!domains || domains.length === 0) {
				this.lastRunTime = Date.now()
				completed = true
				return
			}

			// Verify each domain. Normal DNS misses and pending claims are counted
			// below but intentionally do not produce one log entry per domain.
			for (const row of domains) {
				runStats.totalChecked++
				const { id, domain, did, verified: wasVerified } = row

				try {
					// Extract hash from id (SHA256 of did:domain)
					const expectedHash = id.substring(0, 16)

					// Verify DNS records - this will only verify if TXT record matches this specific DID
					const result = await verifyCustomDomain(domain, did, expectedHash)

					if (result.verified) {
						// Double-check: ensure this record is still the current owner in database
						// This prevents race conditions where domain ownership changed during verification
						const currentOwner = await db<Array<{ id: string; did: string; verified: boolean }>>`
              SELECT id, did, verified
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

						const isStillOwner = currentOwner.length > 0 && currentOwner[0].id === id

						if (!isStillOwner) {
							runStats.failed++
							runStats.ownershipChanged++
							logDiagnostic('Domain ownership changed during verification', {
								domain,
								expectedId: id,
								expectedDid: did,
								actualId: currentOwner[0]?.id,
								actualDid: currentOwner[0]?.did,
							})
							continue
						}

						// Update verified status and last_verified_at timestamp
						await db`
              UPDATE custom_domains
              SET verified = true,
                  last_verified_at = EXTRACT(EPOCH FROM NOW())
              WHERE id = ${id}
            `
						runStats.verified++
						if (!wasVerified) runStats.newlyVerified++

						const foundCname = result.found?.cname
						if (foundCname !== undefined && foundCname.toLowerCase() !== `${expectedHash}.dns.wisp.place`) {
							runStats.cnameAdvisoryFailures++
						}

						if (result.warning) {
							runStats.warnings++
							logWarning('DNS verification warning', { domain, warning: result.warning })
						}
					} else {
						// Mark domain as unverified or keep it pending
						await db`
              UPDATE custom_domains
              SET verified = false,
                  last_verified_at = EXTRACT(EPOCH FROM NOW())
              WHERE id = ${id}
            `
						runStats.failed++
						if (wasVerified) runStats.previouslyVerifiedFailed++

						const failureKind = classifyVerificationFailure(result, wasVerified)
						if (!wasVerified) runStats.pending++
						if (failureKind === 'missing-dns') {
							runStats.missingDns++
						} else if (failureKind === 'mismatch') {
							// A non-DNS mismatch on a previously verified domain is
							// unusual enough to retain, but cap detail per pass.
							logDiagnostic('Previously verified domain failed DNS verification', {
								domain,
								did,
								error: result.error,
								found: result.found,
							})
						}
					}
				} catch (error) {
					runStats.errors++
					logDiagnostic(
						`Error verifying domain: ${domain}`,
						{
							did,
							error: error instanceof Error ? error.message : String(error),
						},
						'error',
					)
				}
			}

			// Update cumulative stats. Keep these health counters unchanged: only
			// completed per-domain checks contribute to the existing totals.
			this.stats.totalChecked += runStats.totalChecked
			this.stats.verified += runStats.verified
			this.stats.failed += runStats.failed
			this.stats.errors += runStats.errors

			this.lastRunTime = Date.now()
			completed = true
		} catch (error) {
			fatalError = true
			this.log(
				'Fatal error in DNS verification worker',
				{ error: error instanceof Error ? error.message : String(error) },
				'error',
			)
		} finally {
			const durationMs = Date.now() - startTime
			this.log('DNS verification check completed', {
				duration: `${durationMs}ms`,
				durationMs,
				completed,
				fatalError,
				...runStats,
			})
		}
	}

	getHealth() {
		return {
			isRunning: this.isRunning,
			lastRunTime: this.lastRunTime,
			intervalMs: this.checkIntervalMs,
			stats: this.stats,
			healthy:
				this.isRunning && (this.lastRunTime === null || Date.now() - this.lastRunTime < this.checkIntervalMs * 2),
		}
	}

	// Manual trigger for testing
	async trigger() {
		this.log('Manual DNS verification triggered')
		await this.verifyAllDomains()
	}
}
