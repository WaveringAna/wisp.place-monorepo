const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_POLL_INTERVAL_MS = 250

export const waitForSiteCacheProjection = async (
	isReady: () => Promise<boolean>,
	options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<boolean> => {
	const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
	const deadline = Date.now() + timeoutMs

	while (true) {
		if (await isReady()) return true

		const remainingMs = deadline - Date.now()
		if (remainingMs <= 0) return false
		await Bun.sleep(Math.min(pollIntervalMs, remainingMs))
	}
}
