import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { revalidationQuarantineKey } from '@wispplace/constants'
import Redis from 'ioredis'
import { config } from '../config'
import {
	processRevalidationMessage,
	type RevalidateRedisClient,
	type RevalidateWorkerDependencies,
} from './revalidate-worker'
import { RELEASE_AND_ENQUEUE_VERIFIED_REPAIR_SCRIPT } from './site-repair'
import { VERIFIED_REPAIR_PROTOCOL, VERIFIED_REPAIR_REASON, verifiedRepairReceiptKey } from './site-repair-protocol'

// No TCP listener and no environment-derived Redis config: this suite cannot touch a live database.
const executable = Bun.which('redis-server') ?? Bun.which('valkey-server')
const integration = executable ? describe : describe.skip

integration('verified repair Lua on isolated Redis', () => {
	let directory: string
	let server: ReturnType<typeof Bun.spawn>
	let redis: Redis
	const keys = ['fence', 'revision', 'live', 'capability', 'dedupe', 'generation']
	const baseArgs = [
		'',
		'1',
		'revision',
		'worker',
		VERIFIED_REPAIR_PROTOCOL,
		'100',
		'did:plc:exact',
		'site',
		VERIFIED_REPAIR_REASON,
		'1',
		'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
		'root-cid',
		'a'.repeat(64),
		'1',
		'0',
		'',
	]

	beforeAll(async () => {
		directory = mkdtempSync('/tmp/wisp-repair-')
		const socket = `${directory}/redis.sock`
		server = Bun.spawn(
			[
				executable!,
				'--port',
				'0',
				'--unixsocket',
				socket,
				'--unixsocketperm',
				'700',
				'--save',
				'',
				'--appendonly',
				'no',
				'--dir',
				directory,
			],
			{ stdout: 'ignore', stderr: 'ignore' },
		)
		const deadline = Date.now() + 5_000
		while (!existsSync(socket)) {
			if (Date.now() >= deadline || server.exitCode !== null) throw new Error('Isolated Redis failed to start')
			await delay(10)
		}
		redis = new Redis({
			path: socket,
			lazyConnect: true,
			maxRetriesPerRequest: 0,
			connectTimeout: 1000,
			commandTimeout: 1000,
			retryStrategy: () => null,
		})
		await redis.connect()
	})

	afterAll(async () => {
		redis?.disconnect()
		if (server) {
			server.kill()
			await server.exited
		}
		if (directory) rmSync(directory, { recursive: true, force: true })
	})

	beforeEach(async () => {
		await redis.flushdb()
		await redis.xgroup('CREATE', 'live', 'worker', '0', 'MKSTREAM')
		await redis.xgroup('CREATECONSUMER', 'live', 'worker', 'consumer')
		await redis.mset('fence', '', 'revision', 'revision', 'other-site-fence', 'untouched')
		await redis.set('capability', `${VERIFIED_REPAIR_PROTOCOL}:consumer`, 'EX', 30)
	})

	const evaluate = (overrides: Record<number, string> = {}) =>
		redis.eval(
			RELEASE_AND_ENQUEUE_VERIFIED_REPAIR_SCRIPT,
			keys.length,
			...keys,
			...baseArgs.map((value, index) => overrides[index] ?? value),
		)
	const unchanged = async (fence: string | null = '') => {
		expect(await redis.get('fence')).toBe(fence)
		expect(await redis.get('other-site-fence')).toBe('untouched')
		expect(await redis.xlen('live')).toBe(0)
	}

	test('enqueues exact full repair before releasing empty fence, retaining evidence and version', async () => {
		await redis.xadd('dlq', '*', 'evidence', 'original')
		const result = await evaluate()
		expect(result).toEqual(['enqueued', expect.any(String)])
		expect(await redis.get('fence')).toBeNull()
		expect(await redis.get('revision')).toBe('revision')
		expect(await redis.get('other-site-fence')).toBe('untouched')
		expect(await redis.xlen('dlq')).toBe(1)
		const entries = await redis.xrange('live', '-', '+')
		expect(entries).toHaveLength(1)
		const fields = entries[0]![1]
		expect(fields).toContain('storage-miss:verified-repair')
		expect(fields).toContain('did:plc:exact')
		expect(fields).toContain('root-cid')
		expect(await redis.get('dedupe')).toBe(entries[0]![0])
	})

	test('absent fence is distinct from empty and permits explicitly unfenced bad-cache repair', async () => {
		await redis.del('fence')
		expect(await evaluate()).toEqual(['changed-fence', ''])
		await unchanged(null)
		expect(await evaluate({ 13: '0' })).toEqual(['enqueued', expect.any(String)])
	})

	test('refuses a newly present empty fence when snapshot was absent', async () => {
		expect(await evaluate({ 13: '0' })).toEqual(['changed-fence', ''])
		await unchanged()
	})

	test('refuses changed fence, revision, and same-value quarantine generation ABA', async () => {
		await redis.set('fence', 'new')
		expect(await evaluate()).toEqual(['changed-fence', ''])
		await unchanged('new')
		await redis.set('fence', '')
		await redis.set('revision', 'newer')
		expect(await evaluate()).toEqual(['changed-version', ''])
		await unchanged()
		await redis.set('revision', 'revision')
		await redis.set('generation', 'new-dlq-id')
		expect(await evaluate()).toEqual(['changed-generation', ''])
		await unchanged()
		expect(await evaluate({ 14: '1', 15: 'old-dlq-id' })).toEqual(['changed-generation', ''])
		await unchanged()
	})

	test('refuses absent, wrong and additional groups', async () => {
		expect(await evaluate({ 3: 'wrong' })).toEqual(['refused-group', ''])
		await unchanged()
		await redis.xgroup('CREATE', 'live', 'extra', '0')
		expect(await evaluate()).toEqual(['refused-group', ''])
		await unchanged()
		await redis.xgroup('DESTROY', 'live', 'extra')
		await redis.xgroup('DESTROY', 'live', 'worker')
		expect(await evaluate()).toEqual(['refused-group', ''])
		await unchanged()
	})

	test('refuses missing capability, wrong worker and extra active consumers', async () => {
		await redis.del('capability')
		expect(await evaluate()).toEqual(['refused-worker', ''])
		await unchanged()
		await redis.set('capability', `${VERIFIED_REPAIR_PROTOCOL}:other`)
		expect(await evaluate()).toEqual(['refused-worker', ''])
		await unchanged()
		await redis.set('capability', `${VERIFIED_REPAIR_PROTOCOL}:consumer`)
		await redis.xgroup('CREATECONSUMER', 'live', 'worker', 'other')
		expect(await evaluate()).toEqual(['refused-worker', ''])
		await unchanged()
	})

	test('capacity and existing storage-miss retain the fence without adding work', async () => {
		const existing = await redis.xadd('live', '*', 'did', 'other')
		expect(await evaluate({ 5: '1' })).toEqual(['capacity', ''])
		expect(await redis.get('fence')).toBe('')
		expect(await redis.xlen('live')).toBe(1)
		await redis.set('dedupe', existing!)
		expect(await evaluate()).toEqual(['already-pending', ''])
		expect(await redis.get('fence')).toBe('')
		expect(await redis.xlen('live')).toBe(1)
	})

	test('receipted replay ACKs the real PEL before attempt policy and preserves a newer fence', async () => {
		const stream = config.revalidateStream
		const group = config.revalidateGroup
		if (stream !== 'live' || group !== 'worker') await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
		const did = 'did:plc:completed-site'
		const rkey = 'completed'
		const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
		const recordCid = 'completed-root-cid'
		const manifestFingerprint = 'a'.repeat(64)
		const fields = [
			'did',
			did,
			'rkey',
			rkey,
			'reason',
			VERIFIED_REPAIR_REASON,
			'sourceVersion',
			'old-revision',
			'repairProtocol',
			VERIFIED_REPAIR_PROTOCOL,
			'repairToken',
			token,
			'repairRecordCid',
			recordCid,
			'repairManifestFingerprint',
			manifestFingerprint,
		]
		const id = await redis.xadd(stream, '*', ...fields)
		if (!id) throw new Error('Failed to seed isolated repair entry')
		await redis.xreadgroup('GROUP', group, 'consumer', 'COUNT', 1, 'STREAMS', stream, '>')
		const receiptKey = verifiedRepairReceiptKey(stream, token)
		const receipt = JSON.stringify({ token, did, rkey, recordCid, manifestFingerprint, invalidationStreamId: '123-0' })
		await redis.set(receiptKey, receipt)
		const fenceKey = revalidationQuarantineKey(did, rkey)
		await redis.set(fenceKey, 'newer-fence')
		expect(await redis.ttl(receiptKey)).toBe(-1)
		let workCalls = 0
		const unexpectedWork = async (): Promise<never> => {
			workCalls++
			throw new Error('Completed repair must not fetch or materialize anything')
		}
		const dependencies: RevalidateWorkerDependencies = {
			fetchSiteRecord: unexpectedWork,
			fetchSiteRecordOutcome: unexpectedWork,
			fetchSettingsRecord: unexpectedWork,
			fetchSettingsRecordOutcome: unexpectedWork,
			handleSiteCreateOrUpdate: unexpectedWork,
			handleSiteDelete: unexpectedWork,
			handleSettingsUpdate: unexpectedWork,
			handleSettingsDelete: unexpectedWork,
		}
		await processRevalidationMessage(id, fields, redis as unknown as RevalidateRedisClient, dependencies, {
			deliveryAttempt: 100,
			enforceAttemptPolicy: true,
		})
		expect(workCalls).toBe(0)
		expect(await redis.xrange(stream, id, id)).toEqual([])
		const pending = await redis.xpending(stream, group)
		expect(Array.isArray(pending) && pending[0]).toBe(0)
		expect(await redis.get(fenceKey)).toBe('newer-fence')
		expect(await redis.get(receiptKey)).toBe(receipt)
		const ttl = await redis.ttl(receiptKey)
		expect(ttl).toBeGreaterThanOrEqual(86_395)
		expect(ttl).toBeLessThanOrEqual(86_400)
		expect(await redis.xlen(config.revalidateDlqStream)).toBe(0)
	})

	test('wrong key type fails before releasing fence or enqueuing', async () => {
		await redis.lpush('generation', 'wrong-type')
		await expect(evaluate()).rejects.toThrow('WRONGTYPE')
		await unchanged()
	})
})
