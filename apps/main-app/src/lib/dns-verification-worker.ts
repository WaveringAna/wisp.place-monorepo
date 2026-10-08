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
	pointsToAnotherOwner,
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
	/** Verified domains failing but still serving. */
	graceFailing: number
	graceRecovered: number
	/** In-pass rechecks, and those that passed. */
	confirmRetries: number
	confirmRescued: number
	/** Failing verified domains past `confirmMaxDomains`, counted without a recheck. */
	confirmSkipped: number
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
	graceFailing: 0,
	graceRecovered: 0,
	confirmRetries: 0,
	confirmRescued: 0,
	confirmSkipped: 0,
	writes: 0,
})

export interface DNSVerificationWorkerOptions {
	store: DnsVerificationStore
	verify: VerifyDomain
	policy?: DnsVerificationPolicy
	onLog?: (message: string, data?: Record<string, unknown>, level?: DNSVerificationLogLevel) => void
	/** Waits between in-pass rechecks; tests replace it. */
	sleep?: (ms: number) => Promise<void>
}

// The id is a SHA256 of did:domain; its prefix names the CNAME target.
const cnameHash = (id: string) => id.substring(0, 16)

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Every main-app instance schedules passes, but a pass runs on one instance at
 * a time and at most once per interval fleet-wide; the rest skip quietly.
 * Within a pass only due domains are checked (see dns-verification-schedule).
 */
export class DNSVerificationWorker {
	private task: PeriodicSingleFlightTask<PassOutcome> | null = null
	private lastRunTime: number | null = null
	private readonly policy: DnsVerificationPolicy
	private readonly sleep: (ms: number) => Promise<void>
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
		this.sleep = options.sleep ?? sleepFor
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
			unverifyAfterMinutes: this.policy.unverifyAfterSec / 60,
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

		const recordResult = async (state: DomainVerificationState, result: VerificationResult): Promise<void> => {
			const { id, domain, did, verified: wasVerified } = state
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
					return
				}
			}

			if (outcome.next) {
				if (!(await store.saveDomain(id, did, outcome.next))) {
					runStats.ownershipChanged++
					return
				}
				runStats.writes++
			}

			if (result.verified) {
				runStats.verified++
				if (!wasVerified) {
					runStats.newlyVerified++
					this.log('Domain verified', { domain })
				} else if (outcome.transition === 'recovered') {
					runStats.graceRecovered++
					this.log('Verified domain recovered within its grace window', {
						domain,
						failures: state.failures,
						failingForSec: state.failingSince === null ? null : now - state.failingSince,
					})
				}
				const foundCname = result.found?.cname
				if (foundCname !== undefined && foundCname.toLowerCase() !== `${cnameHash(id)}.dns.wisp.place`) {
					runStats.cnameAdvisoryFailures++
				}
				if (result.warning) runStats.warnings++
				if (outcome.newWarning) logWarning('DNS verification warning', { domain, warning: outcome.newWarning })
				return
			}

			runStats.failed++
			if (!wasVerified) runStats.pending++
			const failureKind = classifyVerificationFailure(result, wasVerified)
			if (failureKind === 'missing-dns') runStats.missingDns++
			if (outcome.next?.verified) runStats.graceFailing++
			if (outcome.transition === 'failing') {
				logDiagnostic('Verified domain failing DNS verification, still serving', {
					domain,
					did,
					failureKind,
					error: result.error,
					found: result.found,
					unverifyAfterMinutes: this.policy.unverifyAfterSec / 60,
				})
			} else if (outcome.transition === 'lost') {
				runStats.previouslyVerifiedFailed++
				logDiagnostic('Previously verified domain failed DNS verification', {
					domain,
					did,
					failureKind,
					error: result.error,
					found: result.found,
					otherOwner: pointsToAnotherOwner(result, did),
					failingSince: outcome.next?.failingSince,
				})
			} else if (outcome.transition === 'parked') {
				runStats.newlyParked++
				this.log('Domain verification parked until the owner verifies again', {
					domain,
					failures: outcome.next?.failures,
					failingSince: outcome.next?.failingSince,
				})
			}
		}

		const applyResult = async (state: DomainVerificationState, result: VerificationResult): Promise<void> => {
			try {
				await recordResult(state, result)
			} catch (error) {
				runStats.errors++
				logDiagnostic(
					`Error verifying domain: ${state.domain}`,
					{ did: state.did, error: error instanceof Error ? error.message : String(error) },
					'error',
				)
			}
		}

		try {
			runStats.duplicatesRemoved = await store.removeDuplicateRows()
			const domains = await store.listDomains()
			runStats.domains = domains.length
			const window = { from: lastPassAt, to: now }

			const verifyOnce = async (state: DomainVerificationState): Promise<VerificationResult | null> => {
				const { id, domain, did } = state
				try {
					return await verify(domain, did, cnameHash(id))
				} catch (error) {
					runStats.errors++
					logDiagnostic(
						`Error verifying domain: ${domain}`,
						{ did, error: error instanceof Error ? error.message : String(error) },
						'error',
					)
					return null
				}
			}

			// A verified domain that fails without naming another owner is checked
			// again later in the pass before the failure counts.
			const unconfirmed = (state: DomainVerificationState, result: VerificationResult): boolean =>
				state.verified && !result.verified && !pointsToAnotherOwner(result, state.did)

			let toConfirm: Array<{ state: DomainVerificationState; result: VerificationResult }> = []
			for (const state of domains) {
				const status = checkStatus(state, window, this.policy)
				if (status === 'parked') runStats.parked++
				else if (status === 'backoff') runStats.backoff++
				else if (status === 'scheduled') runStats.notDue++
				if (status !== 'due') continue

				runStats.totalChecked++
				const result = await verifyOnce(state)
				if (!result) continue
				if (unconfirmed(state, result)) toConfirm.push({ state, result })
				else await applyResult(state, result)
			}

			const unconfirmedFailures = toConfirm.splice(this.policy.confirmMaxDomains)
			runStats.confirmSkipped = unconfirmedFailures.length
			for (const check of unconfirmedFailures) await applyResult(check.state, check.result)
			for (let retry = 0; retry < this.policy.confirmRetries && toConfirm.length > 0; retry++) {
				await this.sleep(this.policy.confirmDelaySec * 1000)
				const stillFailing: typeof toConfirm = []
				for (const check of toConfirm) {
					runStats.confirmRetries++
					const result = (await verifyOnce(check.state)) ?? check.result
					if (unconfirmed(check.state, result)) {
						stillFailing.push({ state: check.state, result })
					} else {
						if (result.verified) runStats.confirmRescued++
						await applyResult(check.state, result)
					}
				}
				toConfirm = stillFailing
			}
			for (const check of toConfirm) await applyResult(check.state, check.result)

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
