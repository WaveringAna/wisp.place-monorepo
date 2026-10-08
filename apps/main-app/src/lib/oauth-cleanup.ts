import type { SQL } from 'bun'
import { logger } from './logger'

type CleanupLogger = Pick<typeof logger, 'info' | 'debug' | 'error'>

/**
 * Delete expired OAuth sessions and states. Runs hourly on every instance, so
 * a pass that deletes nothing logs at debug.
 */
export const deleteExpiredOAuthRows = async (
	sql: SQL,
	log: CleanupLogger = logger,
	now = Math.floor(Date.now() / 1000),
) => {
	try {
		const sessionsDeleted = await sql`
			DELETE FROM oauth_sessions WHERE expires_at < ${now}
		`
		const statesDeleted = await sql`
			DELETE FROM oauth_states WHERE expires_at IS NOT NULL AND expires_at < ${now}
		`
		// Without RETURNING the result has no rows; count is the affected row count.
		const sessions = Number(sessionsDeleted.count ?? 0)
		const states = Number(statesDeleted.count ?? 0)
		const message = `[Cleanup] Deleted ${sessions} expired sessions and ${states} expired states`
		if (sessions + states > 0) log.info(message)
		else log.debug(message)
		return { sessions, states }
	} catch (err) {
		log.error('[Cleanup] Failed to cleanup expired data', err)
		return { sessions: 0, states: 0 }
	}
}
