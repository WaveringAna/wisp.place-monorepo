/**
 * Path redaction for telemetry.
 *
 * Some routes carry a credential in a path segment rather than a query string — the
 * private-site share link `/p/<token>` is one. Metric labels and error logs record the
 * request path, so those segments are replaced before they can reach a log sink, a metrics
 * store, or a dashboard label.
 *
 * Applied at the observability boundary rather than at each call site so that a new route
 * cannot forget to do it.
 */

/** Path prefixes whose next segment is a secret. */
const SECRET_SEGMENT_PREFIXES = ['/p/']

/** Replace a credential-bearing path segment with a placeholder. */
export const redactSecretPath = (pathname: string): string => {
	for (const prefix of SECRET_SEGMENT_PREFIXES) {
		if (pathname.startsWith(prefix)) {
			const rest = pathname.slice(prefix.length)
			if (rest.length === 0) return pathname
			const slash = rest.indexOf('/')
			return slash === -1 ? `${prefix}<redacted>` : `${prefix}<redacted>${rest.slice(slash)}`
		}
	}
	return pathname
}
