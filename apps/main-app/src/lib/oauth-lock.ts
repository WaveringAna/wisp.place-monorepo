export interface ReservedOAuthLockConnection {
	acquire(): Promise<void>
	unlock(): Promise<void>
	release(): void
	close(): Promise<void>
}

export type OAuthLockCleanupFailure = 'unlock' | 'connection-close'

/**
 * Run work while holding a session-level advisory lock.
 *
 * If unlock fails, the session may still own the lock. Do not return that
 * connection to the pool: close its physical session so PostgreSQL releases
 * any session-level locks.
 */
export async function withReservedOAuthLock<T>(
	connection: ReservedOAuthLockConnection,
	fn: () => T | PromiseLike<T>,
	onCleanupFailure: (kind: OAuthLockCleanupFailure) => void,
): Promise<T> {
	let discardConnection = false
	const reportCleanupFailure = (kind: OAuthLockCleanupFailure): void => {
		try {
			onCleanupFailure(kind)
		} catch {
			// Cleanup reporting must not replace an error from fn().
		}
	}

	try {
		await connection.acquire()
		try {
			return await fn()
		} finally {
			try {
				await connection.unlock()
			} catch {
				discardConnection = true
				reportCleanupFailure('unlock')
			}
		}
	} finally {
		if (discardConnection) {
			try {
				await connection.close()
			} catch {
				reportCleanupFailure('connection-close')
			}
		} else {
			connection.release()
		}
	}
}
