/** An integer setting from the environment: the fallback when it is unset, malformed or out of range. */
export function parseBoundedInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const normalized = value?.trim()
	if (!normalized) return fallback
	const parsed = Number(normalized)
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}
