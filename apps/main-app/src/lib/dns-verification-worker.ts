import {
	classifyVerificationFailure,
	MAX_WARNING_DETAILS_PER_PASS,
	shouldLogDiagnosticDetail,
} from './dns-verification-logging'
import {
	checkStatus,
	DEFAULT_DNS_VERIFICATION_POLICY,
	type DnsVerificationPolicy,
	type DomainVerificationColumns,
	type DomainVerificationState,
	passIsDue,
	planCheck,
} from './dns-verification-schedule'
import type { VerificationResult } from './dns-verify'
import { type PeriodicSingleFlightTask, startPeriodicSingleFlightTask } from './lifecycle'

export type DNSVerificationLogLevel = 'info' | 'warn' | 'error'

/** Database access for one pass. Every call goes to the primary. */
export interface DnsVerificationStore {
	/**
	 * Run `pass` while holding the fleet-wide pass lock, or return
	 * `{ acquired: false }` at once when another instance holds it.
	 */
	withPassLock<T>(pass: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>
	/** The last completed pass start and the database clock, in epoch seconds. */
	readPassClock(): Promise<{ lastPassAt: number | null; now: number }>
	recordPass(startedAt: number): Promise<void>
	removeDuplicateRows(): Promise<number>
	listDomains(): Promise<DomainVerificationState[]>
	/** Id of the row that currently owns `domain`, if any. */
	currentOwnerId(domain: string): Promise<string | null>
	/** Write the worker's columns; false when the row is gone or changed owner. */
	saveDomain(id: string, did: string, columns: DomainVerificationColumns): Promise<boolean>
}

export type VerifyDomain = (domain: string, did: string, expectedHash: string) => Promise<VerificationResult>

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
	/** Verified domains whose recheck falls in a later pass. */
	notDue: number
	/** Failing domains still waiting out their backoff. */
	backoff: number
	/** Domains that only a user-triggered verify will check again. */
	parked: number
	newlyParked: number
	writes: number
}

export type PassOutcome = 'completed' | 'failed' | 'locked' | 'recent'

const emptyPassStats = (): VerificationPassStats => ({
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
	notDue: 0,
	backoff: 0,
	parked: 0,
	newlyParked: 0,
	writes: 0,
})

export interface DNSVerificationWorkerOptions {
	store: DnsVerificationStore
	verify: VerifyDomain
	policy?: DnsVerificationPolicy
	onLog?: (message: string, data?: Record<string, unknown>, level?: DNSVerificationLogLevel) => void
}

/**
 * Every main-app instance schedules passes, but a pass runs on one instance at
 * a time and at most once per interval fleet-wide; the rest skip quietly.
 * Within a pass only due domains are checked (see dns-verification-schedule).
 */
export class DNSVerificationWorker {
	private task: PeriodicSingleFlightTask<PassOutcome> | null = null
	private lastRunTime: number | null = null
	private readonly policy: DnsVerificationPolicy
	private stats = {
		totalChecked: 0,
		verified: 0,
		failed: 0,
		errors: 0,
		passesRun: 0,
		passesSkipped: 0,
	}

	constructor(private readonly options: DNSVerificationWorkerOptions) {
		this.policy = options.policy ?? DEFAULT_DNS_VERIFICATION_POLICY
	}

	private log(message: string, data?: Record<string, unknown>, level: DNSVerificationLogLevel = 'info') {
		this.options.onLog?.(message, data, level)
	}

	start() {
		if (this.task) {
			this.log('DNS verification worker already running')
			return
		}

		this.log('Starting DNS verification worker', {
			intervalMinutes: this.policy.passIntervalSec / 60,
			verifiedRecheckMinutes: this.policy.verifiedRecheckSec / 60,
			parkAfterDays: this.policy.parkAfterSec / 86400,
		})
		this.task = startPeriodicSingleFlightTask(
			() => this.runPass(false),
			this.policy.passIntervalSec * 1000,
			() => this.log('DNS verification pass crashed', undefined, 'error'),
		)
	}

	/** Stop scheduling and wait for an active pass to finish. */
	async stop(): Promise<void> {
		const task = this.task
		if (!task) return
		this.task = null
		await task.stop()
		this.log('DNS verification worker stopped')
	}

	/** Run one pass now. `force` ignores the fleet-wide interval but not the lock. */
	async runPass(force: boolean): Promise<PassOutcome> {
		const { store } = this.options
		let outcome: PassOutcome
		try {
			const locked = await store.withPassLock(async (): Promise<PassOutcome> => {
				const clock = await store.readPassClock()
				if (!force && !passIsDue(clock.lastPassAt, clock.now, this.policy)) return 'recent'
				return await this.verifyDueDomains(clock.lastPassAt, clock.now)
			})
			outcome = locked.acquired ? locked.value : 'locked'
		} catch (error) {
			outcome = 'failed'
			this.log(
				'Fatal error in DNS verification worker',
				{ error: error instanceof Error ? error.message : String(error) },
				'error',
			)
		}
		if (outcome === 'locked' || outcome === 'recent') this.stats.passesSkipped++
		else this.stats.passesRun++
		// A skipped tick is healthy: another instance did this interval's pass.
		if (outcome !== 'failed') this.lastRunTime = Date.now()
		return outcome
	}

	private async verifyDueDomains(lastPassAt: number | null, now: number): Promise<PassOutcome> {
		const { store, verify } = this.options
		const startTime = Date.now()
		const runStats = emptyPassStats()
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
			runStats.duplicatesRemoved = await store.removeDuplicateRows()
			const domains = await store.listDomains()
			runStats.domains = domains.length
			const window = { from: lastPassAt, to: now }

			for (const state of domains) {
				const status = checkStatus(state, window, this.policy)
				if (status === 'parked') runStats.parked++
				else if (status === 'backoff') runStats.backoff++
				else if (status === 'scheduled') runStats.notDue++
				if (status !== 'due') continue

				runStats.totalChecked++
				const { id, domain, did, verified: wasVerified } = state
				try {
					// The id is a SHA256 of did:domain; its prefix names the CNAME target.
					const expectedHash = id.substring(0, 16)
					const result = await verify(domain, did, expectedHash)
					const outcome = planCheck(state, result, now, this.policy)

					if (result.verified && outcome.next) {
						// Ownership may have changed while DNS was being checked.
						const ownerId = await store.currentOwnerId(domain)
						if (ownerId !== id) {
							runStats.failed++
							runStats.ownershipChanged++
							logDiagnostic('Domain ownership changed during verification', {
								domain,
								expectedId: id,
								expectedDid: did,
								actualId: ownerId,
							})
							continue
						}
					}

					if (outcome.next) {
						if (!(await store.saveDomain(id, did, outcome.next))) {
							runStats.ownershipChanged++
							continue
						}
						runStats.writes++
					}

					if (result.verified) {
						runStats.verified++
						if (!wasVerified) {
							runStats.newlyVerified++
							this.log('Domain verified', { domain })
						}
						const foundCname = result.found?.cname
						if (foundCname !== undefined && foundCname.toLowerCase() !== `${expectedHash}.dns.wisp.place`) {
							runStats.cnameAdvisoryFailures++
						}
						if (result.warning) runStats.warnings++
						if (outcome.newWarning) logWarning('DNS verification warning', { domain, warning: outcome.newWarning })
						continue
					}

					runStats.failed++
					if (!wasVerified) runStats.pending++
					const failureKind = classifyVerificationFailure(result, wasVerified)
					if (failureKind === 'missing-dns') runStats.missingDns++
					if (outcome.transition === 'lost') {
						runStats.previouslyVerifiedFailed++
						logDiagnostic('Previously verified domain failed DNS verification', {
							domain,
							did,
							failureKind,
							error: result.error,
							found: result.found,
						})
					} else if (outcome.transition === 'parked') {
						runStats.newlyParked++
						this.log('Domain verification parked until the owner verifies again', {
							domain,
							failures: outcome.next?.failures,
							failingSince: outcome.next?.failingSince,
						})
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

			await store.recordPass(now)
			this.stats.totalChecked += runStats.totalChecked
			this.stats.verified += runStats.verified
			this.stats.failed += runStats.failed
			this.stats.errors += runStats.errors
			completed = true
			return 'completed'
		} catch (error) {
			fatalError = true
			this.log(
				'Fatal error in DNS verification worker',
				{ error: error instanceof Error ? error.message : String(error) },
				'error',
			)
			return 'failed'
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
		const intervalMs = this.policy.passIntervalSec * 1000
		return {
			isRunning: this.task !== null,
			lastRunTime: this.lastRunTime,
			intervalMs,
			stats: this.stats,
			healthy: this.task !== null && (this.lastRunTime === null || Date.now() - this.lastRunTime < intervalMs * 2),
		}
	}

	// Manual trigger for testing
	async trigger() {
		this.log('Manual DNS verification triggered')
		await this.runPass(true)
	}
}
