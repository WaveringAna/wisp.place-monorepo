import { beforeEach, describe, expect, test } from 'bun:test'
import { LeadershipSupervisor, type PrimaryAdvisorySession, type RedisLease } from './leadership-supervisor'
import type { SupervisorStateMessage } from './supervisor-protocol'
import { killWorkerOnSupervisorLoss, type SupervisorWatchdog } from './watchdog'

class SharedAuthority {
	redisOwner: string | null = null
	postgresOwner: string | null = null
	epoch = 0
	failRedisRenew = false
	failPostgresVerify = false
	readonly calls: string[] = []
}

function fakeAdapters(shared: SharedAuthority, token: string): { redis: RedisLease; postgres: PrimaryAdvisorySession } {
	return {
		redis: {
			acquire: async () => {
				shared.calls.push(`${token}:redis-acquire`)
				if (shared.redisOwner) return null
				shared.redisOwner = token
				shared.epoch++
				return shared.epoch
			},
			renew: async () => {
				shared.calls.push(`${token}:redis-renew`)
				return !shared.failRedisRenew && shared.redisOwner === token
			},
			release: async () => {
				shared.calls.push(`${token}:redis-release`)
				if (shared.redisOwner === token) {
					shared.redisOwner = null
					return true
				}
				return false
			},
			close: async () => {
				shared.calls.push(`${token}:redis-close`)
			},
		},
		postgres: {
			acquire: async () => {
				shared.calls.push(`${token}:postgres-acquire`)
				if (shared.postgresOwner) return false
				shared.postgresOwner = token
				return true
			},
			verify: async () => {
				shared.calls.push(`${token}:postgres-verify`)
				return !shared.failPostgresVerify && shared.postgresOwner === token
			},
			release: async () => {
				shared.calls.push(`${token}:postgres-release`)
				if (shared.postgresOwner === token) shared.postgresOwner = null
			},
			reset: async () => {
				shared.calls.push(`${token}:postgres-reset`)
				if (shared.postgresOwner === token) shared.postgresOwner = null
			},
			close: async () => {
				shared.calls.push(`${token}:postgres-close`)
			},
		},
	}
}

function supervisor(
	shared: SharedAuthority,
	token: string,
	states: SupervisorStateMessage[],
	kills: number[],
	options: Partial<ConstructorParameters<typeof LeadershipSupervisor>[0]> = {},
): LeadershipSupervisor {
	return new LeadershipSupervisor({
		parentPid: token === 'one' ? 101 : 102,
		redisLeaseKey: 'wisp:firehose-leader',
		redisEpochKey: 'wisp:firehose-leader-epoch',
		advisoryLockId: 42n,
		leaseTtlMs: 1000,
		renewIntervalMs: 100,
		pollIntervalMs: 100,
		commandTimeoutMs: 100,
		instanceId: token,
		...options,
		dependencies: {
			...fakeAdapters(shared, token),
			sendState: (state) => {
				states.push(state)
			},
			killParent: (pid) => kills.push(pid),
			...options.dependencies,
		},
	})
}

describe('LeadershipSupervisor', () => {
	let shared: SharedAuthority
	beforeEach(() => {
		shared = new SharedAuthority()
	})

	test('acquires Redis before the primary Postgres session and reports an epoch', async () => {
		const states: SupervisorStateMessage[] = []
		const guardian = supervisor(shared, 'one', states, [])
		await guardian.tick()
		expect(guardian.currentState).toBe('acquired')
		expect(guardian.currentEpoch).toBe(1)
		expect(states[states.length - 1]?.state).toBe('acquired')
		expect(shared.calls.slice(0, 2)).toEqual(['one:redis-acquire', 'one:postgres-acquire'])
	})

	test('two instances cannot acquire both authorities at once', async () => {
		const firstStates: SupervisorStateMessage[] = []
		const secondStates: SupervisorStateMessage[] = []
		const first = supervisor(shared, 'one', firstStates, [])
		const second = supervisor(shared, 'two', secondStates, [])
		await Promise.all([first.tick(), second.tick()])
		expect(first.ownsAuthority).toBe(true)
		expect(second.ownsAuthority).toBe(false)
		expect(secondStates[secondStates.length - 1]?.state).toBe('standby')
	})

	test('keeps ticking independently while a parent callback is blocked', async () => {
		const states: SupervisorStateMessage[] = []
		const kills: number[] = []
		const guardian = supervisor(shared, 'one', states, kills)
		await guardian.tick()
		let callbackFinished = false
		const blockedParentCallback = new Promise<void>(() => undefined).then(() => {
			callbackFinished = true
		})
		shared.failRedisRenew = true
		await guardian.tick()
		expect(callbackFinished).toBe(false)
		expect(kills).toEqual([101])
		expect(guardian.currentState).toBe('fatal')
		void blockedParentCallback
	})

	test('kills before releasing authority after Redis lease loss', async () => {
		const states: SupervisorStateMessage[] = []
		const kills: number[] = []
		const guardian = supervisor(shared, 'one', states, kills)
		await guardian.tick()
		shared.redisOwner = 'another-supervisor'
		await guardian.tick()
		expect(kills).toEqual([101])
		expect(shared.calls.slice(-4)).toEqual([
			'one:postgres-release',
			'one:redis-release',
			'one:redis-close',
			'one:postgres-close',
		])
		expect(shared.calls[shared.calls.length - 1]).toBe('one:postgres-close')
	})

	test('kills before releasing authority after Postgres session loss', async () => {
		const kills: number[] = []
		const guardian = supervisor(shared, 'one', [], kills)
		await guardian.tick()
		shared.failPostgresVerify = true
		await guardian.tick()
		expect(kills).toEqual([101])
		expect(guardian.currentState).toBe('fatal')
		expect(shared.calls.indexOf('one:postgres-release')).toBeGreaterThan(shared.calls.indexOf('one:redis-renew'))
	})

	test('the independent watchdog kills the worker when the supervisor pipe reaches EOF', () => {
		const killed: number[] = []
		killWorkerOnSupervisorLoss(101, (pid) => killed.push(pid))
		expect(killed).toEqual([101])
	})

	test('a standby releases its watchdog explicitly instead of simulating supervisor loss', async () => {
		let stopped = 0
		let closed = 0
		const watchdog: SupervisorWatchdog = {
			start: async () => undefined,
			stop: async () => {
				stopped++
			},
			close: async () => {
				closed++
			},
		}
		const states: SupervisorStateMessage[] = []
		// Keep Redis occupied so this process remains a standby.
		shared.redisOwner = 'existing-leader'
		const guardian = supervisor(shared, 'one', states, [], { watchdog })
		await guardian.handleCommand({ version: 1, type: 'hello', parentPid: 101 })
		await guardian.handleCommand({ version: 1, type: 'release' })
		const result = await guardian.run()
		expect(result.state).toBe('released')
		expect(stopped).toBe(1)
		expect(closed).toBe(0)
		expect(states.map(({ state }) => state)).toEqual(['standby', 'released'])
	})

	test('a watchdog exit makes the supervisor kill the worker before releasing locks', async () => {
		let onFailure: ((error: Error) => void) | undefined
		const watchdog: SupervisorWatchdog = {
			start: async () => undefined,
			stop: async () => undefined,
			close: async () => undefined,
			onFailure: (handler) => {
				onFailure = handler
			},
		}
		const kills: number[] = []
		const guardian = supervisor(shared, 'one', [], kills, { watchdog })
		await guardian.tick()
		const failure = new Promise<void>((resolve) => {
			const original = onFailure
			onFailure = (error) => {
				void original?.(error)
				resolve()
			}
		})
		onFailure?.(new Error('watchdog exited'))
		await failure
		// fail() is asynchronous; wait for the authority close calls as well.
		await guardian.failClosed('watchdog exited')
		expect(kills).toEqual([101])
		expect(guardian.currentState).toBe('fatal')
		expect(shared.calls.indexOf('one:postgres-release')).toBeGreaterThan(-1)
	})

	test('graceful release drains in reverse lock order and acknowledges after close', async () => {
		const states: SupervisorStateMessage[] = []
		const guardian = supervisor(shared, 'one', states, [])
		await guardian.tick()
		await guardian.handleCommand({ version: 1, type: 'hello', parentPid: 101 })
		await guardian.handleCommand({ version: 1, type: 'release' })
		await guardian.tick()
		expect(guardian.currentState).toBe('released')
		expect(states.map(({ state }) => state)).toEqual(['acquired', 'releasing', 'released'])
		expect(shared.calls.slice(-4)).toEqual([
			'one:postgres-release',
			'one:redis-release',
			'one:redis-close',
			'one:postgres-close',
		])
	})

	test('fails closed when graceful Redis release is not confirmed', async () => {
		const kills: number[] = []
		const guardian = supervisor(shared, 'one', [], kills, {
			dependencies: {
				...fakeAdapters(shared, 'one'),
				redis: {
					...fakeAdapters(shared, 'one').redis,
					release: async () => false,
				},
			},
		})
		await guardian.tick()
		await guardian.handleCommand({ version: 1, type: 'hello', parentPid: 101 })
		await guardian.handleCommand({ version: 1, type: 'release' })
		await guardian.tick()
		expect(kills).toEqual([101])
		expect(guardian.currentState).toBe('fatal')
	})

	test('bounds a hung authority command with a monotonic deadline', async () => {
		let resolve!: () => void
		const hung = new Promise<void>((done) => {
			resolve = done
		})
		const states: SupervisorStateMessage[] = []
		const kills: number[] = []
		const guardian = supervisor(shared, 'one', states, kills, {
			dependencies: {
				...fakeAdapters(shared, 'one'),
				redis: {
					...fakeAdapters(shared, 'one').redis,
					renew: async () => {
						await hung
						return false
					},
				},
			},
		})
		await guardian.tick()
		await expect(guardian.tick()).resolves.toBeUndefined()
		expect(kills).toEqual([101])
		resolve()
	})
})
