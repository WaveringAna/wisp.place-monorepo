/**
 * Logging-only classification and sampling helpers for the DNS verification worker.
 *
 * These helpers deliberately do not affect whether a domain is verified or how
 * verification failures are persisted. They only keep expected DNS outcomes
 * out of the per-domain log stream and cap diagnostic detail per pass.
 */

export const MAX_DIAGNOSTIC_DETAILS_PER_PASS = 8
export const MAX_WARNING_DETAILS_PER_PASS = 4

export interface VerificationResultForLogging {
	verified: boolean
	error?: string
	found?: {
		txt?: string[]
	}
}

export type VerificationFailureKind = 'pending' | 'missing-dns' | 'mismatch'

/**
 * Missing DNS is a normal result while a user is configuring a domain. An
 * empty TXT answer is also represented by the verifier as a non-matching TXT
 * result, so inspect the found records as well as the error text.
 */
export function isMissingDnsOutcome(result: VerificationResultForLogging): boolean {
	if (result.verified) return false

	const error = result.error?.toLowerCase() ?? ''
	return (
		result.found?.txt?.length === 0 ||
		error.startsWith('dns lookup failed:') ||
		error.includes('no ns records found') ||
		error.includes('no cname record found') ||
		error.includes('dns query timed out')
	)
}

/**
 * Classify a failed result for pass counters and logging. Pending claims and
 * missing DNS are expected; a mismatch on a previously verified domain is an
 * actionable state transition and may receive sampled detail.
 */
export function classifyVerificationFailure(
	result: VerificationResultForLogging,
	wasVerified: boolean,
): VerificationFailureKind {
	if (isMissingDnsOutcome(result)) return 'missing-dns'
	return wasVerified ? 'mismatch' : 'pending'
}

/** Return whether another diagnostic detail can be emitted in this pass. */
export function shouldLogDiagnosticDetail(
	emittedCount: number,
	limit: number = MAX_DIAGNOSTIC_DETAILS_PER_PASS,
): boolean {
	return emittedCount < limit
}
