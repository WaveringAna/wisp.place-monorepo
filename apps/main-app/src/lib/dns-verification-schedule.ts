/**
 * Scheduling policy for the DNS verification worker, kept free of I/O so the
 * rules can be tested directly.
 *
 * Verified domains are rechecked once per `verifiedRecheckSec`, each at a fixed
 * phase derived from its id, so passes share the work and a verified domain
 * whose DNS is unchanged costs no database write. Failing domains back off;
 * after `parkAfterSec` of continuous failure they are parked and only a
 * user-triggered verify checks them again.
 *
 * A verified domain whose lookup fails without a different owner in DNS keeps
 * serving through a grace window, rechecked every pass, so one resolver or
 * nameserver blip does not take a live site offline.
 */

export interface DnsVerificationPolicy {
	/** How often each instance tries to run a pass. */
	passIntervalSec: number
	/** How often a verified domain is rechecked to catch removed DNS. */
	verifiedRecheckSec: number
	/** Delay after the 1st, 2nd, ... consecutive failure; the last entry repeats. */
	failureBackoffSec: readonly number[]
	/** Continuous failure after which a domain is parked. */
	parkAfterSec: number
	/** Oldest `last_verified_at` an unchanged verified domain may keep. */
	lastCheckedRefreshSec: number
	/** A verified domain stays verified until it has failed this long... */
	unverifyAfterSec: number
	/** ...and in at least this many consecutive passes. */
	unverifyAfterFailures: number
	/** In-pass rechecks of a verified domain that failed, each after `confirmDelaySec`. */
	confirmRetries: number
	confirmDelaySec: number
	/**
	 * Most failing domains rechecked in one pass. More than this failing at once
	 * points at our resolvers, and the grace window covers the rest.
	 */
	confirmMaxDomains: number
}

export const DEFAULT_DNS_VERIFICATION_POLICY: DnsVerificationPolicy = {
	passIntervalSec: 10 * 60,
	verifiedRecheckSec: 60 * 60,
	failureBackoffSec: [10 * 60, 30 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60],
	parkAfterSec: 7 * 24 * 60 * 60,
	lastCheckedRefreshSec: 6 * 60 * 60,
	unverifyAfterSec: 30 * 60,
	unverifyAfterFailures: 3,
	confirmRetries: 2,
	confirmDelaySec: 15,
	confirmMaxDomains: 20,
}

const positiveNumber = (value: string | undefined): number | undefined => {
	const parsed = Number(value)
	return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** Read the operator overrides; anything missing or invalid keeps its default. */
export const resolveDnsVerificationPolicy = (
	env: Record<string, string | undefined>,
	defaults: DnsVerificationPolicy = DEFAULT_DNS_VERIFICATION_POLICY,
): DnsVerificationPolicy => {
	const minutes = positiveNumber(env.DNS_VERIFIER_VERIFIED_RECHECK_MINUTES)
	const days = positiveNumber(env.DNS_VERIFIER_PARK_AFTER_DAYS)
	const hours = positiveNumber(env.DNS_VERIFIER_LAST_CHECKED_REFRESH_HOURS)
	const graceMinutes = positiveNumber(env.DNS_VERIFIER_UNVERIFY_AFTER_MINUTES)
	return {
		...defaults,
		verifiedRecheckSec: minutes !== undefined ? Math.round(minutes * 60) : defaults.verifiedRecheckSec,
		parkAfterSec: days !== undefined ? Math.round(days * 24 * 60 * 60) : defaults.parkAfterSec,
		lastCheckedRefreshSec: hours !== undefined ? Math.round(hours * 60 * 60) : defaults.lastCheckedRefreshSec,
		unverifyAfterSec: graceMinutes !== undefined ? Math.round(graceMinutes * 60) : defaults.unverifyAfterSec,
	}
}

/** The columns the worker owns on a `custom_domains` row. Times are epoch seconds. */
export interface DomainVerificationColumns {
	verified: boolean
	lastVerifiedAt: number | null
	failures: number
	failingSince: number | null
	/** The failing streak started on a domain that was verified. */
	lost: boolean
	nextCheckAt: number | null
	parkedAt: number | null
	warning: string | null
}

export interface DomainVerificationState extends DomainVerificationColumns {
	id: string
	domain: string
	did: string
}

/** Pass window: the previous pass start (null on the first pass) to this one. */
export interface PassWindow {
	from: number | null
	to: number
}

export type DueStatus = 'due' | 'parked' | 'backoff' | 'scheduled'

// FNV-1a, so the phase does not depend on the id being hex.
const phaseOf = (id: string, period: number): number => {
	let hash = 0x811c9dc5
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash % period
}

export const checkStatus = (
	state: DomainVerificationState,
	window: PassWindow,
	policy: DnsVerificationPolicy,
): DueStatus => {
	if (state.parkedAt !== null) return 'parked'
	if (!state.verified) {
		// Round to the nearest pass: a retry due a few seconds after this pass
		// starts would otherwise wait a whole extra interval.
		const dueBy = window.to + policy.passIntervalSec / 2
		return state.nextCheckAt === null || state.nextCheckAt <= dueBy ? 'due' : 'backoff'
	}
	// A verified domain in its grace window is rechecked every pass.
	if (state.failingSince !== null) return 'due'
	const period = policy.verifiedRecheckSec
	if (window.from === null || window.to - window.from >= period) return 'due'
	// Due when this domain's phase point k * period + phase lies in (from, to].
	const phase = phaseOf(state.id, period)
	return Math.floor((window.to - phase) / period) > Math.floor((window.from - phase) / period) ? 'due' : 'scheduled'
}

export const backoffDelaySec = (failures: number, lost: boolean, policy: DnsVerificationPolicy): number => {
	const steps = policy.failureBackoffSec
	const delay = steps[Math.min(Math.max(failures, 1), steps.length) - 1] ?? policy.passIntervalSec
	// A domain that was serving recovers within the verified recheck interval.
	return lost ? Math.min(delay, policy.verifiedRecheckSec) : delay
}

/**
 * 'failing': a verified domain started failing and keeps serving in grace.
 * 'recovered': it passed again before the grace ran out.
 */
export type VerificationTransition = 'verified' | 'lost' | 'parked' | 'failing' | 'recovered'

export interface CheckResult {
	verified: boolean
	warning?: string
	found?: { txt?: string[] }
}

/**
 * The TXT answer names another DID, so the domain has positively changed
 * hands. An empty answer or a lookup error proves nothing either way.
 */
export const pointsToAnotherOwner = (result: CheckResult, did: string): boolean =>
	!result.verified && (result.found?.txt ?? []).some((value) => value.trim().startsWith('did:') && value !== did)

export interface CheckOutcome {
	/** Columns to write, or null when nothing changed. */
	next: DomainVerificationColumns | null
	transition: VerificationTransition | null
	/** A warning that is new or different for this domain. */
	newWarning: string | null
}

const sameColumns = (a: DomainVerificationColumns, b: DomainVerificationColumns): boolean =>
	a.verified === b.verified &&
	a.lastVerifiedAt === b.lastVerifiedAt &&
	a.failures === b.failures &&
	a.failingSince === b.failingSince &&
	a.lost === b.lost &&
	a.nextCheckAt === b.nextCheckAt &&
	a.parkedAt === b.parkedAt &&
	a.warning === b.warning

/** Decide what one check result changes, at pass time `now`. */
export const planCheck = (
	state: DomainVerificationState,
	result: CheckResult,
	now: number,
	policy: DnsVerificationPolicy,
): CheckOutcome => {
	if (result.verified) {
		const warning = result.warning ?? null
		const refresh =
			!state.verified || state.lastVerifiedAt === null || now - state.lastVerifiedAt >= policy.lastCheckedRefreshSec
		const next: DomainVerificationColumns = {
			verified: true,
			lastVerifiedAt: refresh ? now : state.lastVerifiedAt,
			failures: 0,
			failingSince: null,
			lost: false,
			nextCheckAt: null,
			parkedAt: null,
			warning,
		}
		return {
			next: sameColumns(state, next) ? null : next,
			transition: !state.verified ? 'verified' : state.failingSince !== null ? 'recovered' : null,
			newWarning: warning !== null && warning !== state.warning ? warning : null,
		}
	}

	const failures = state.failures + 1
	const failingSince = state.failingSince ?? now
	const graceOver = failures >= policy.unverifyAfterFailures && now - failingSince >= policy.unverifyAfterSec
	if (state.verified && !graceOver && !pointsToAnotherOwner(result, state.did)) {
		return {
			next: {
				verified: true,
				lastVerifiedAt: state.lastVerifiedAt,
				failures,
				failingSince,
				lost: true,
				nextCheckAt: null,
				parkedAt: null,
				warning: state.warning,
			},
			transition: state.failingSince === null ? 'failing' : null,
			newWarning: null,
		}
	}

	const lost = state.verified || state.lost
	// Backoff restarts when the grace ends, so a site back soon after goes live soon.
	const backoffStep = state.verified ? 1 : failures
	const parked = now - failingSince >= policy.parkAfterSec
	return {
		next: {
			verified: false,
			lastVerifiedAt: now,
			failures,
			failingSince,
			lost,
			nextCheckAt: now + backoffDelaySec(backoffStep, lost, policy),
			parkedAt: parked ? now : null,
			warning: null,
		},
		transition: state.verified ? 'lost' : parked ? 'parked' : null,
		newWarning: null,
	}
}

/** A pass may start once most of an interval has passed since the last one anywhere. */
export const passIsDue = (lastPassAt: number | null, now: number, policy: DnsVerificationPolicy): boolean =>
	lastPassAt === null || now - lastPassAt >= policy.passIntervalSec * 0.9
