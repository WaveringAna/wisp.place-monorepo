import { describe, expect, test } from 'bun:test'
import { config } from '../config'
import { BlobIntegrityError } from './blob-integrity'
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
import {
	VERIFIED_REPAIR_REASON,
	verifiedRepairQuarantineGenerationKey,
	verifiedRepairReceiptKey,
} from './site-repair-protocol'

interface EvalCall {
	script: string
	keyCount: number
	args: string[]
}

function fakeRedis(): {
	redis: RevalidateRedisClient
	evals: EvalCall[]
	sets: Array<[string, string, 'EX' | undefined, number | undefined]>
} {
	const evals: EvalCall[] = []
	const sets: Array<[string, string, 'EX' | undefined, number | undefined]> = []
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
		expect(call.keyCount).toBe(5)
		expect(call.args.slice(0, 7)).toEqual([
			config.revalidateStream,
			config.revalidateDlqStream,
			'wisp:revalidate:quarantine:/site',
			'wisp:revalidate:version:/site',
			verifiedRepairQuarantineGenerationKey('', 'site'),
			config.revalidateGroup,
			id,
		])
		expect(call.args.slice(7, 12)).toEqual([
			'',
			'site',
			'malformed',
			'MALFORMED_MESSAGE',
			'Revalidation failed: MALFORMED_MESSAGE',
		])
		expect(call.script.indexOf("redis.call('XADD'")).toBeLessThan(call.script.indexOf("redis.call('SET'"))
		expect(call.script.indexOf("redis.call('SET'")).toBeLessThan(call.script.indexOf("redis.call('XACK'"))
		expect(call.script.indexOf("redis.call('XACK'")).toBeLessThan(call.script.indexOf("redis.call('XDEL'"))
	})

	test('maps quarantine ARGVs to every DLQ field and MAXLEN', async () => {
		const id = '91-2'
		const { redis, evals } = fakeRedis()

		await quarantineRevalidationMessage(
			redis,
			{
				fields: {},
				did: 'did:plc:contract',
				rkey: 'docs/index.html',
				reason: 'storage-miss:docs/index.html',
				sourceVersion: '3mzzzzzzzzzzz',
			},
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
		expect(call.keyCount).toBe(5)
		expect(call.args.slice(0, 5)).toEqual([
			config.revalidateStream,
			config.revalidateDlqStream,
			'wisp:revalidate:quarantine:did%3Aplc%3Acontract/docs%2Findex.html',
			'wisp:revalidate:version:did%3Aplc%3Acontract/docs%2Findex.html',
			verifiedRepairQuarantineGenerationKey('did:plc:contract', 'docs/index.html'),
		])
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
			'3mzzzzzzzzzzz',
			'',
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
				['blobDetails', 13],
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
				blobDetails: '',
			},
		})
		expect(call.script.indexOf("redis.call('XADD'")).toBeLessThan(call.script.indexOf("redis.call('SET'"))
		expect(call.script.indexOf("redis.call('SET'")).toBeLessThan(call.script.indexOf("redis.call('XACK'"))
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

describe('broken blob quarantine and verified repair proof', () => {
	const broken = new BlobIntegrityError('BLOB_CID_MISMATCH', {
		pds: 'https://pds.example',
		recordCid: 'record-cid',
		path: 'assets/app.js',
		blobCid: 'blob-cid',
		ownerDid: 'did:plc:owner',
		expectedSize: 42,
		actualSize: 42,
	})
	const site = {
		record: {
			$type: 'place.wisp.fs' as const,
			site: 'site',
			root: { type: 'directory' as const, entries: [] },
			createdAt: '2024-01-01T00:00:00.000Z',
		},
		cid: 'record-cid',
	}
	const request = {
		token: '12345678-1234-1234-1234-123456789abc',
		recordCid: site.cid,
		manifestFingerprint: 'a'.repeat(64),
	}
	const fields = [
		'did',
		'did:plc:test',
		'rkey',
		'site',
		'reason',
		VERIFIED_REPAIR_REASON,
		'repairProtocol',
		'1',
		'repairToken',
		request.token,
		'repairRecordCid',
		request.recordCid,
		'repairManifestFingerprint',
		request.manifestFingerprint,
	]

	test('persists integrity details in atomic DLQ quarantine, not transient retry', async () => {
		const { redis, evals, sets } = fakeRedis()
		expect(classifyRevalidationError(broken)).toEqual({ classification: 'permanent', code: 'BLOB_CID_MISMATCH' })
		await processRevalidationMessage(
			'broken-1',
			['did', 'did:plc:test', 'rkey', 'site'],
			redis,
			dependencies({
				fetchSiteRecord: async () => site,
				handleSiteCreateOrUpdate: async () => {
					throw broken
				},
			}),
			{ deliveryAttempt: 1, runtimeConfig: runtime() },
		)
		expect(sets).toHaveLength(0)
		expect(evals).toHaveLength(1)
		const call = evals[0]
		if (!call) throw new Error('missing quarantine')
		const dlq = resolveDlqXaddContract(call)
		expect(dlq.fields.errorCode).toBe('BLOB_CID_MISMATCH')
		expect(JSON.parse(dlq.fields.blobDetails!)).toEqual(broken.details)
	})

	test('quarantines an absent verified-repair source instead of ordinary success ACK', async () => {
		const { redis, evals, sets } = fakeRedis()
		await processRevalidationMessage('repair-absent', fields, redis, dependencies(), {
			deliveryAttempt: 1,
			runtimeConfig: runtime(),
		})
		expect(sets).toHaveLength(0)
		expect(evals).toHaveLength(1)
		const call = evals[0]
		if (!call) throw new Error('expected quarantine')
		expect(resolveDlqXaddContract(call).fields.errorCode).toBe('REPAIR_SOURCE_ABSENT')
	})

	test('does not ACK or report completion on a writer no-op', async () => {
		const { redis, evals, sets } = fakeRedis()
		await processRevalidationMessage(
			'repair-noop',
			fields,
			redis,
			dependencies({ fetchSiteRecord: async () => site }),
			{ deliveryAttempt: 1, runtimeConfig: runtime() },
		)
		expect(evals).toHaveLength(0)
		expect(sets.map(([key]) => key)).toEqual(['revalidate:retry:repair-noop'])
	})

	test('replays a durable receipt after failed ACK without re-reading changed PDS or applying max attempts', async () => {
		const { redis, evals, sets } = fakeRedis()
		const stored = new Map<string, string>()
		const getKeys: string[] = []
		redis.get = async (key) => {
			getKeys.push(key)
			return stored.get(key) ?? null
		}
		const save = redis.set.bind(redis)
		redis.set = async (key, value, mode, ttl) => {
			stored.set(key, value)
			return save(key, value, mode, ttl)
		}
		const evaluate = redis.eval.bind(redis)
		let failAck = true
		redis.eval = async (script, keyCount, ...args) => {
			await evaluate(script, keyCount, ...args)
			if (failAck) throw new Error('lost ACK response')
			return [1, 1]
		}
		let materializations = 0
		const deps = dependencies({
			fetchSiteRecord: async () => site,
			handleSiteCreateOrUpdate: async (_did, _rkey, _record, _cid, options) => {
				materializations++
				await options?.onVerifiedRepairComplete?.({
					recordCid: request.recordCid,
					manifestFingerprint: request.manifestFingerprint,
					invalidationStreamId: '123-0',
				})
			},
		})
		await expect(
			processRevalidationMessage('repair-replay', fields, redis, deps, {
				deliveryAttempt: 3,
				runtimeConfig: runtime(),
			}),
		).rejects.toThrow('acknowledgement remains pending')
		expect(sets).toHaveLength(1)
		expect(sets[0]?.slice(2)).toEqual([undefined, undefined])
		expect(evals).toHaveLength(1)
		expect(evals[0]?.script).not.toContain("redis.call('XADD'")
		getKeys.length = 0
		deps.fetchSiteRecord = async () => {
			throw new Error('source has changed; must not be read')
		}
		await expect(
			processRevalidationMessage('repair-replay', fields, redis, deps, {
				deliveryAttempt: 99,
				runtimeConfig: runtime(),
			}),
		).rejects.toThrow('lost ACK response')
		expect(evals).toHaveLength(2)
		expect(materializations).toBe(1)
		failAck = false
		await processRevalidationMessage('repair-replay', fields, redis, deps, {
			deliveryAttempt: 100,
			runtimeConfig: runtime(),
		})
		expect(materializations).toBe(1)
		expect(sets).toHaveLength(1)
		expect(getKeys).toEqual(Array(2).fill(verifiedRepairReceiptKey(config.revalidateStream, request.token)))
		const completion = evals[2]
		expect(completion?.keyCount).toBe(2)
		expect(completion?.args).toEqual([
			config.revalidateStream,
			verifiedRepairReceiptKey(config.revalidateStream, request.token),
			config.revalidateGroup,
			'repair-replay',
			'86400',
		])
		expect(completion?.script).toContain("if deleted == 1 and KEYS[2] then redis.call('EXPIRE', KEYS[2], ARGV[3]) end")
	})

	test('does not quarantine after an ambiguous receipt SET response', async () => {
		const { redis, evals } = fakeRedis()
		let receipt: string | null = null
		redis.get = async () => receipt
		redis.set = async (_key, value) => {
			receipt = value
			throw new Error('lost SET response')
		}
		const deps = dependencies({
			fetchSiteRecord: async () => site,
			handleSiteCreateOrUpdate: async (_did, _rkey, _record, _cid, options) => {
				await options?.onVerifiedRepairComplete?.({
					recordCid: request.recordCid,
					manifestFingerprint: request.manifestFingerprint,
					invalidationStreamId: '123-0',
				})
			},
		})
		await expect(
			processRevalidationMessage('receipt-set-unknown', fields, redis, deps, {
				deliveryAttempt: 3,
				runtimeConfig: runtime(),
			}),
		).rejects.toThrow('acknowledgement remains pending')
		expect(evals).toEqual([])
		await processRevalidationMessage('receipt-set-unknown', fields, redis, dependencies(), {
			deliveryAttempt: 99,
			runtimeConfig: runtime(),
		})
		expect(evals).toHaveLength(1)
		expect(evals[0]?.script).not.toContain("redis.call('XADD'")
	})

	test('receipt lookup failures leave even over-limit deliveries pending without quarantine', async () => {
		const { redis, evals, sets } = fakeRedis()
		redis.get = async () => {
			throw new Error('redis read unavailable')
		}
		await expect(
			processRevalidationMessage('repair-read-failure', fields, redis, dependencies(), {
				deliveryAttempt: 99,
				runtimeConfig: runtime(),
			}),
		).rejects.toThrow('redis read unavailable')
		expect(evals).toEqual([])
		expect(sets).toEqual([])
	})

	test('requires the complete receipt identity before replay ACK and honors lifecycle cancellation', async () => {
		const receipt = { ...request, did: 'did:plc:test', rkey: 'site', invalidationStreamId: '123-0' }
		for (const field of ['token', 'did', 'rkey', 'recordCid', 'manifestFingerprint', 'invalidationStreamId']) {
			const { redis, evals, sets } = fakeRedis()
			redis.get = async () => JSON.stringify({ ...receipt, [field]: 'mismatch' })
			await expect(
				processRevalidationMessage(`receipt-mismatch-${field}`, fields, redis, dependencies(), {
					deliveryAttempt: 99,
					runtimeConfig: runtime(),
				}),
			).rejects.toThrow('does not match')
			expect(evals).toEqual([])
			expect(sets).toEqual([])
		}
		const controller = new AbortController()
		const { redis, evals } = fakeRedis()
		redis.get = async () => {
			controller.abort()
			return JSON.stringify(receipt)
		}
		await processRevalidationMessage('repair-replay-abort', fields, redis, dependencies(), {
			upstreamSignal: controller.signal,
			deliveryAttempt: 99,
			runtimeConfig: runtime(),
		})
		expect(evals).toEqual([])
	})

	test('persists token proof before ACK only after writer completion callback', async () => {
		const { redis, evals, sets } = fakeRedis()
		await processRevalidationMessage(
			'repair-proof',
			fields,
			redis,
			dependencies({
				fetchSiteRecord: async () => site,
				handleSiteCreateOrUpdate: async (_did, _rkey, _record, _cid, options) => {
					expect(options?.forceDownload).toBe(true)
					expect(options?.verifiedRepair).toEqual(request)
					expect(evals).toHaveLength(0)
					await options?.onVerifiedRepairComplete?.({
						recordCid: request.recordCid,
						manifestFingerprint: request.manifestFingerprint,
						invalidationStreamId: '123-0',
					})
					expect(sets).toHaveLength(1)
				},
			}),
			{ deliveryAttempt: 1, runtimeConfig: runtime() },
		)
		expect(sets[0]?.[0]).toBe(verifiedRepairReceiptKey(config.revalidateStream, request.token))
		expect(JSON.parse(sets[0]?.[1] ?? '')).toMatchObject({
			...request,
			invalidationStreamId: '123-0',
			did: 'did:plc:test',
			rkey: 'site',
		})
		expect(evals).toHaveLength(1)
		expect(evals[0]?.script).not.toContain("redis.call('XADD'")
	})
})
