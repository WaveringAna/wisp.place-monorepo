import { describe, expect, test } from 'bun:test'
import { assertSignallableWorkerPid, resolveSupervisorConfig, supervisorAdvisoryLockId } from './supervisor-config'

describe('resolveSupervisorConfig', () => {
	const environment = {
		REDIS_URL: 'rediss://redis.example.invalid:6379/0',
		DATABASE_URL: 'postgres://user:password@db.example.invalid:5432/wisp?sslmode=require',
		SUPERVISOR_PARENT_PID: '1234',
		NODE_ENV: 'production',
	}

	test('keeps the primary/read-write authority settings independent of worker config', () => {
		const config = resolveSupervisorConfig(environment, ['supervisor', '--parent-pid=1234'])
		expect(config.parentPid).toBe(1234)
		expect(config.redisUrl).toContain('rediss://')
		expect(config.databaseUrl).toContain('sslmode=require')
		expect(config.commandTimeoutMs).toBeLessThan(config.leaseTtlMs)
		expect(config.advisoryLockId).toBe(supervisorAdvisoryLockId(config.advisoryLockKey))
	})

	test('rejects a namespace-init worker that in-container watchdogs cannot kill', () => {
		expect(() => assertSignallableWorkerPid(1)).toThrow('must run below a real init process')
		expect(() => assertSignallableWorkerPid(0)).toThrow()
		expect(() => assertSignallableWorkerPid(Number.NaN)).toThrow()
		expect(() => assertSignallableWorkerPid(2)).not.toThrow()
	})

	test('requires a validated parent PID and rejects colliding Redis keys', () => {
		expect(() => resolveSupervisorConfig({ ...environment, SUPERVISOR_PARENT_PID: undefined })).toThrow(
			'SUPERVISOR_PARENT_PID is required',
		)
		expect(() =>
			resolveSupervisorConfig({
				...environment,
				SUPERVISOR_REDIS_EPOCH_KEY: 'same',
				SUPERVISOR_REDIS_LEASE_KEY: 'same',
			}),
		).toThrow('must differ')
	})
})
