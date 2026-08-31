import { createLogger } from '@wispplace/observability'
import { SQL } from 'bun'
import { databaseConfiguration } from './db'
import { withReservedOAuthLock } from './oauth-lock'

const logger = createLogger('main-app')
const LOCK_NAMESPACE = 0x5749535055504c44n // "WISPUPLD"
const lockDb = new SQL({ url: databaseConfiguration.primaryUrl, max: 4 })
let closePromise: Promise<void> | undefined

function lockKey(did: string, siteName: string): bigint {
	const bytes = new Bun.CryptoHasher('sha256').update(`${did}\u0000${siteName}`).digest()
	return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, false) ^ LOCK_NAMESPACE
}

/** Serialize one public site's manifest mutation across main-app instances. */
export async function withSiteUploadLock<T>(did: string, siteName: string, work: () => Promise<T>): Promise<T> {
	const reserved = await lockDb.reserve()
	const key = lockKey(did, siteName)
	return await withReservedOAuthLock(
		{
			async acquire(): Promise<void> {
				await reserved`SET lock_timeout = '30s'`
				await reserved`SELECT pg_advisory_lock(${key})`
			},
			async unlock(): Promise<void> {
				await reserved`SELECT pg_advisory_unlock(${key})`
			},
			release(): void {
				reserved.release()
			},
			close(): Promise<void> {
				return reserved.close({ timeout: 0 })
			},
		},
		work,
		(kind) => logger.error('Site upload advisory lock cleanup failed', { kind }),
	)
}

export function closeSiteUploadLockDatabase(): Promise<void> {
	closePromise ??= lockDb.end().catch(() => {
		logger.error('Site upload advisory lock database close failed')
	})
	return closePromise
}
