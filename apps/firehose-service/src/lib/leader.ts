/**
 * Leader election for distributed firehose deployments.
 *
 * Only one instance connects to the firehose at a time. If the leader dies,
 * its Redis key expires and a standby wins the next election, reading the
 * last saved cursor to resume from approximately where the leader left off.
 *
 * Enable with LEADER_ELECTION=true. Requires REDIS_URL.
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from '@wispplace/observability'
import Redis from 'ioredis'
import { config } from '../config'

const logger = createLogger('firehose-service')

const LEADER_KEY = 'wisp:firehose-leader'
const CURSOR_KEY_PREFIX = 'wisp:firehose-cursor'

// Cursors are seq numbers scoped to a specific relay's backfill — they are not
// portable across relays. Namespacing by host prevents a stale cursor from one
// relay stalling a connection to another (accepted WS, zero events).
function cursorKey(service: string): string {
	try {
		return `${CURSOR_KEY_PREFIX}:${new URL(service).host}`
	} catch {
		return `${CURSOR_KEY_PREFIX}:${service}`
	}
}

// Unique ID for this process instance
const instanceId = randomUUID()

// Lua script: renew leadership only if this instance still owns the key
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('set', KEYS[1], ARGV[1], 'XX', 'PX', tonumber(ARGV[2]))
else
  return 0
end
`

// Lua script: release leadership only if this instance still owns the key
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`

let redis: Redis | null = null

function getRedis(): Redis {
	if (!redis) {
		if (!config.redisUrl) throw new Error('REDIS_URL is required for leader election')
		redis = new Redis(config.redisUrl, {
			maxRetriesPerRequest: 2,
			enableReadyCheck: true,
			lazyConnect: true,
		})
		redis.on('error', (err) => logger.error('[Leader] Redis error', err))
	}
	return redis
}

async function tryBecomeLeader(): Promise<boolean> {
	const result = await getRedis().set(LEADER_KEY, instanceId, 'PX', config.leaderTtlMs, 'NX')
	return result === 'OK'
}

async function renewLeadership(): Promise<boolean> {
	const result = (await getRedis().eval(RENEW_SCRIPT, 1, LEADER_KEY, instanceId, String(config.leaderTtlMs))) as
		| string
		| null
	return result === 'OK'
}

export async function releaseLeadership(): Promise<void> {
	try {
		const deleted = (await getRedis().eval(RELEASE_SCRIPT, 1, LEADER_KEY, instanceId)) as number
		if (deleted === 1) logger.info('[Leader] Released leader key for immediate standby takeover')
	} catch (err) {
		logger.warn('[Leader] Failed to release leader key', { error: String(err) })
	}
}

export async function saveCursor(seq: number, service: string): Promise<void> {
	try {
		await getRedis().set(cursorKey(service), String(seq))
	} catch (err) {
		logger.warn('[Leader] Failed to save cursor', { error: String(err) })
	}
}

export async function readCursor(service: string): Promise<number | undefined> {
	try {
		const val = await getRedis().get(cursorKey(service))
		if (!val) return undefined
		const n = parseInt(val, 10)
		return Number.isNaN(n) ? undefined : n
	} catch (err) {
		logger.warn('[Leader] Failed to read cursor', { error: String(err) })
		return undefined
	}
}

export function getLeaderInfo() {
	return { instanceId }
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run the leader election loop. Calls onBecomeLeader when this instance wins
 * and onLoseLeadership when it loses the key mid-term. Never returns unless
 * aborted via the signal.
 */
export async function runLeaderElection(
	onBecomeLeader: (cursor: number | undefined, stepDown: () => void) => void,
	onLoseLeadership: () => void,
	signal: AbortSignal,
	initialService: string,
): Promise<void> {
	logger.info(`[Leader] Starting election loop (instance: ${instanceId})`)

	const MAX_RENEWAL_FAILURES = 3
	let isLeader = false
	let renewalTimer: ReturnType<typeof setTimeout> | null = null
	let renewalFailures = 0

	const clearRenewal = () => {
		if (renewalTimer) clearTimeout(renewalTimer)
		renewalTimer = null
	}

	const stepDown = () => {
		if (!isLeader) return

		logger.warn('[Leader] Stepping down voluntarily')
		clearRenewal()
		isLeader = false
		renewalFailures = 0
		onLoseLeadership()
		releaseLeadership().catch((err) => logger.warn('[Leader] Failed to release leadership while stepping down', err))
	}

	signal.addEventListener('abort', () => {
		clearRenewal()
		if (isLeader) onLoseLeadership()
	})

	const scheduleRenew = () => {
		renewalTimer = setTimeout(async () => {
			if (signal.aborted || !isLeader) return

			const renewed = await renewLeadership().catch((err) => {
				logger.error('[Leader] Renewal error', err)
				return false
			})

			if (renewed) {
				renewalFailures = 0
				scheduleRenew()
				return
			}

			renewalFailures++
			logger.warn(`[Leader] Renewal failed (${renewalFailures}/${MAX_RENEWAL_FAILURES})`)

			if (renewalFailures >= MAX_RENEWAL_FAILURES) {
				logger.warn('[Leader] Lost leadership (renewal failed), stepping down')
				clearRenewal()
				isLeader = false
				renewalFailures = 0
				onLoseLeadership()
				return
			}

			scheduleRenew()
		}, config.leaderRenewIntervalMs)
	}

	while (!signal.aborted) {
		if (!isLeader) {
			const won = await tryBecomeLeader().catch((err) => {
				logger.error('[Leader] Election attempt failed', err)
				return false
			})

			if (!won) {
				await sleep(config.leaderPollIntervalMs)
				continue
			}

			isLeader = true
			renewalFailures = 0
			const cursor = await readCursor(initialService)
			logger.info(`[Leader] Won leadership, cursor for ${initialService}: ${cursor ?? 'none (starting from head)'}`)
			onBecomeLeader(cursor, stepDown)
			scheduleRenew()
		}

		await sleep(config.leaderPollIntervalMs)
	}
}

export async function closeLeaderRedis(): Promise<void> {
	if (redis) {
		const toClose = redis
		redis = null
		await toClose.quit().catch(() => undefined)
	}
}
