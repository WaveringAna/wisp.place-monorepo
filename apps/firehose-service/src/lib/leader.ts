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
const CURSOR_KEY = 'wisp:firehose-cursor'

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

export async function saveCursor(seq: number): Promise<void> {
	try {
		await getRedis().set(CURSOR_KEY, String(seq))
	} catch (err) {
		logger.warn('[Leader] Failed to save cursor', { error: String(err) })
	}
}

export async function readCursor(): Promise<number | undefined> {
	try {
		const val = await getRedis().get(CURSOR_KEY)
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
	onBecomeLeader: (cursor: number | undefined) => void,
	onLoseLeadership: () => void,
	signal: AbortSignal,
): Promise<void> {
	logger.info(`[Leader] Starting election loop (instance: ${instanceId})`)

	let isLeader = false
	let renewalTimer: ReturnType<typeof setInterval> | null = null

	signal.addEventListener('abort', () => {
		if (renewalTimer) clearInterval(renewalTimer)
		if (isLeader) onLoseLeadership()
	})

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
			const cursor = await readCursor()
			logger.info(`[Leader] Won leadership, cursor: ${cursor ?? 'none (starting from head)'}`)
			onBecomeLeader(cursor)

			renewalTimer = setInterval(async () => {
				if (signal.aborted) return
				const renewed = await renewLeadership().catch((err) => {
					logger.error('[Leader] Renewal error', err)
					return false
				})

				if (!renewed) {
					logger.warn('[Leader] Lost leadership (renewal failed), stepping down')
					if (renewalTimer) clearInterval(renewalTimer)
					renewalTimer = null
					isLeader = false
					onLoseLeadership()
				}
			}, config.leaderRenewIntervalMs)
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
