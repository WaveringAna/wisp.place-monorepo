import { type LogEntry, logCollector } from '@wispplace/observability'

const RETAINED = 5_000

/**
 * The entries `service` logged through the real in-process collector while
 * `run` ran, for tests asserting on what reaches the logs.
 */
export const logsDuring = async (service: string, run: () => Promise<void>): Promise<LogEntry[]> => {
	const read = () => logCollector.getLogs({ service, limit: RETAINED })
	const before = new Set(read().map((entry) => entry.id))
	await run()
	return read().filter((entry) => !before.has(entry.id))
}
