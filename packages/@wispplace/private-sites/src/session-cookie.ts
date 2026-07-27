export const parseCookieHeader = (header: string | null | undefined): Record<string, string> => {
	const out: Record<string, string> = {}
	if (!header) return out

	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq === -1) continue
		const name = part.slice(0, eq).trim()
		const raw = part.slice(eq + 1).trim()
		if (!name) continue
		try {
			out[name] = decodeURIComponent(raw)
		} catch {
			out[name] = raw
		}
	}
	return out
}
export const countCookieOccurrences = (header: string | null | undefined, name: string): number => {
	if (!header) return 0
	let count = 0
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq === -1) continue
		if (part.slice(0, eq).trim() === name) count += 1
	}
	return count
}
