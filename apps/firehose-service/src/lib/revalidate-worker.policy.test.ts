import { describe, expect, test } from 'bun:test'
import { config } from '../config'
import { AuthoritativeSettingsRecordError } from './cache-writer'
import {
	classifyRevalidationError,
	processRevalidationMessage,
	type RevalidateRedisClient,
	type RevalidateWorkerDependencies,
	type RevalidateWorkerRuntimeConfig,
	resolveRevalidateWorkerRuntimeConfig,
} from './revalidate-worker'

interface EvalCall {
	script: string
	keyCount: number
	args: string[]
}

function fakeRedis(): {
	redis: RevalidateRedisClient
	evals: EvalCall[]
	sets: Array<[string, string, 'EX', number]>
} {
	const evals: EvalCall[] = []
	const sets: Array<[string, string, 'EX', number]> = []
	return {
		redis: {
			ttl: async () => -1,
			set: async (key, value, mode, seconds) => {
				sets.push([key, value, mode, seconds])
				return 'OK'
			},
			eval: async (script, keyCount, ...args) => {
				evals.push({ script, keyCount, args })
				return script.includes("redis.call('XADD'") ? [1, 'dlq-1', 1] : [1, 1]
			},
		},
		evals,
		sets,
	}
}

function runtime(): RevalidateWorkerRuntimeConfig {
	return resolveRevalidateWorkerRuntimeConfig({
		WISP_REVALIDATE_MAX_ATTEMPTS: '3',
		WISP_REVALIDATE_DEADLINE_MS: '1000',
		WISP_REVALIDATE_TRANSFER_BUDGET_BYTES: '1024',
		WISP_REVALIDATE_RETRY_BACKOFF_BASE_MS: '100',
		WISP_REVALIDATE_RETRY_BACKOFF_MAX_MS: '100',
	})
}

function dependencies(overrides: Partial<RevalidateWorkerDependencies> = {}): RevalidateWorkerDependencies {
	return {
		fetchSettingsRecord: async () => null,
		fetchSiteRecord: async () => null,
		handleSettingsDelete: async () => undefined,
		handleSettingsUpdate: async () => undefined,
		handleSiteCreateOrUpdate: async () => undefined,
		handleSiteDelete: async () => undefined,
		...overrides,
	}
}

describe('revalidation error classification', () => {
	test('classifies authoritative settings outcomes explicitly', () => {
		expect(classifyRevalidationError(new AuthoritativeSettingsRecordError('INVALID_RECORD'))).toEqual({
			classification: 'permanent',
			code: 'INVALID_RECORD',
		})
		expect(classifyRevalidationError(new AuthoritativeSettingsRecordError('FETCH_FAILED'))).toEqual({
			classification: 'transient',
			code: 'FETCH_FAILED',
		})
	})
})

describe('strict revalidation poison handling', () => {
	test('writes permanent poison to the DLQ before atomic source ACK/delete', async () => {
		const id = '91-0'
		const { redis, evals } = fakeRedis()

		await processRevalidationMessage(id, ['rkey', 'site', 'reason', 'malformed'], redis, dependencies(), {
			deliveryAttempt: 1,
			runtimeConfig: runtime(),
			enforceAttemptPolicy: true,
		})

		expect(evals).toHaveLength(1)
		const [call] = evals
		if (!call) throw new Error('Expected quarantine script call')
		expect(call.keyCount).toBe(2)
		expect(call.args.slice(0, 4)).toEqual([
			config.revalidateStream,
			config.revalidateDlqStream,
			config.revalidateGroup,
			id,
		])
		expect(call.args.slice(4, 9)).toEqual([
			'',
			'site',
			'malformed',
			'MALFORMED_MESSAGE',
			'Revalidation failed: MALFORMED_MESSAGE',
		])
		expect(call.script.indexOf("redis.call('XADD'")).toBeLessThan(call.script.indexOf("redis.call('XACK'"))
		expect(call.script.indexOf("redis.call('XACK'")).toBeLessThan(call.script.indexOf("redis.call('XDEL'"))
	})

	test('quarantines a transient failure at the attempt bound without materializing later', async () => {
		const id = '91-1'
		const { redis, evals, sets } = fakeRedis()
		let materializations = 0
		const deps = dependencies({
			fetchSiteRecordOutcome: async () => ({ kind: 'retryable' as const, error: 'FETCH_FAILED' as const }),
			handleSiteCreateOrUpdate: async () => {
				materializations++
			},
		})

		for (const deliveryAttempt of [1, 2, 3]) {
			await processRevalidationMessage(
				id,
				['did', 'did:plc:test', 'rkey', 'site', 'reason', 'storage-miss:x'],
				redis,
				deps,
				{
					deliveryAttempt,
					runtimeConfig: runtime(),
					enforceAttemptPolicy: true,
				},
			)
		}

		expect(materializations).toBe(0)
		expect(sets.map(([key]) => key)).toEqual([`revalidate:retry:${id}`, `revalidate:retry:${id}`])
		expect(evals).toHaveLength(1)
		expect(evals[0]?.script).toContain("redis.call('XADD'")
	})
})
