import { describe, expect, test } from 'bun:test'
import { config } from '../config'
import { AuthoritativeSettingsRecordError } from './cache-writer'
import {
	classifyRevalidationError,
	processRevalidationMessage,
	quarantineRevalidationMessage,
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

interface DlqXaddContract {
	maxLenArgv: number
	fields: Array<readonly [string, number]>
}

function parseDlqXaddContract(script: string): DlqXaddContract {
	const xaddStart = script.indexOf("local dlqId = redis.call('XADD'")
	const ackStart = script.indexOf('\nlocal acknowledged', xaddStart)
	if (xaddStart < 0 || ackStart < 0) throw new Error('Expected a quarantine XADD followed by XACK')

	const xadd = script.slice(xaddStart, ackStart)
	const maxLenMatch = xadd.match(/'MAXLEN', '~', ARGV\[(\d+)\], '\*'/)
	if (!maxLenMatch?.[1]) throw new Error('Expected a MAXLEN ARGV reference in quarantine XADD')

	const fields = Array.from(xadd.matchAll(/'([A-Za-z][A-Za-z0-9]*)', ARGV\[(\d+)\]/g)).map((match) => {
		const [, field, argv] = match
		if (!field || !argv) throw new Error('Expected a field ARGV reference in quarantine XADD')
		return [field, Number(argv)] as const
	})

	return { maxLenArgv: Number(maxLenMatch[1]), fields }
}

function resolveDlqXaddContract(call: EvalCall): { maxLen: string; fields: Record<string, string> } {
	const contract = parseDlqXaddContract(call.script)
	const argv = call.args.slice(call.keyCount)
	const argAt = (argvIndex: number): string => {
		const value = argv[argvIndex - 1]
		if (value === undefined) throw new Error(`Missing ARGV[${argvIndex}] in quarantine call`)
		return value
	}

	return {
		maxLen: argAt(contract.maxLenArgv),
		fields: Object.fromEntries(contract.fields.map(([field, argvIndex]) => [field, argAt(argvIndex)])),
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

	test('maps quarantine ARGVs to every DLQ field and MAXLEN', async () => {
		const id = '91-2'
		const { redis, evals } = fakeRedis()

		await quarantineRevalidationMessage(
			redis,
			{ fields: {}, did: 'did:plc:contract', rkey: 'docs/index.html', reason: 'storage-miss:docs/index.html' },
			id,
			new Error('upstream timeout'),
			7,
			'transient',
			'UPSTREAM_TIMEOUT',
		)

		expect(evals).toHaveLength(1)
		const [call] = evals
		if (!call) throw new Error('Expected quarantine script call')
		const quarantinedAt = call.args[call.keyCount + 9]
		if (!quarantinedAt) throw new Error('Expected a quarantine timestamp argument')
		expect(quarantinedAt).toMatch(/^\d+$/)
		expect(call.keyCount).toBe(2)
		expect(call.args.slice(0, 2)).toEqual([config.revalidateStream, config.revalidateDlqStream])
		expect(call.args.slice(call.keyCount)).toEqual([
			config.revalidateGroup,
			id,
			'did:plc:contract',
			'docs/index.html',
			'storage-miss:docs/index.html',
			'UPSTREAM_TIMEOUT',
			'upstream timeout',
			'7',
			'transient',
			expect.any(String),
			String(config.revalidateDlqStreamMaxLen),
		])

		expect(parseDlqXaddContract(call.script)).toEqual({
			maxLenArgv: 11,
			fields: [
				['sourceId', 2],
				['did', 3],
				['rkey', 4],
				['reason', 5],
				['errorCode', 6],
				['error', 7],
				['classification', 9],
				['attempts', 8],
				['quarantinedAt', 10],
			],
		})
		expect(resolveDlqXaddContract(call)).toEqual({
			maxLen: String(config.revalidateDlqStreamMaxLen),
			fields: {
				sourceId: id,
				did: 'did:plc:contract',
				rkey: 'docs/index.html',
				reason: 'storage-miss:docs/index.html',
				errorCode: 'UPSTREAM_TIMEOUT',
				error: 'upstream timeout',
				classification: 'transient',
				attempts: '7',
				quarantinedAt,
			},
		})
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
