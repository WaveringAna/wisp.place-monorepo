// Redact at the observability boundary so callers cannot accidentally leak path credentials.
const SECRET_SEGMENT_PREFIXES = ['/p/']

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
