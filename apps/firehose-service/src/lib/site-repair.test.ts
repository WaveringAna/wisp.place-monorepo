import { describe, expect, test } from 'bun:test'
import { revalidationQuarantineKey, revalidationSiteVersionKey } from '@wispplace/constants'
import { parseLexiconJson } from '@wispplace/lexicons/public-json'
import type { Directory } from '@wispplace/lexicons/types/place/wisp/fs'
import { type RepairDependencies, type RepairRedis, type RepairSiteOptions, repairSite } from './site-repair'
import { parseRepairSiteArguments } from './site-repair-cli'
import {
	fingerprintSiteManifest,
	parseVerifiedRepairRequest,
	VERIFIED_REPAIR_PROTOCOL,
	VERIFIED_REPAIR_REASON,
	type VerifiedSitePreflight,
	verifiedRepairCapabilityKey,
	verifiedRepairQuarantineGenerationKey,
	verifiedRepairReceiptKey,
} from './site-repair-protocol'

const options: RepairSiteOptions = {
	did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
	rkey: 'site',
	apply: true,
	stream: 'live',
	group: 'worker',
	maxStreamLength: 10_000,
	waitMs: 1_000,
}
const proof: VerifiedSitePreflight = {
	recordCid: 'same-root-cid',
	manifestFingerprint: 'a'.repeat(64),
	fileCount: 1,
	totalBytes: 0,
}
const signal = () => new AbortController().signal

function harness() {
	const fenceKey = revalidationQuarantineKey(options.did, options.rkey)
	const versionKey = revalidationSiteVersionKey(options.did, options.rkey)
	const otherFence = revalidationQuarantineKey(options.did, 'other-site')
	const values = new Map<string, string>([
		[fenceKey, ''],
		[versionKey, 'revision'],
		[otherFence, 'other-fence'],
		[verifiedRepairCapabilityKey(options.stream, options.group), `${VERIFIED_REPAIR_PROTOCOL}:consumer`],
	])
	const calls: Array<{ script: string; keys: string[]; argv: string[] }> = []
	const verifiedSites: Array<[string, string]> = []
	let groups: unknown = [['name', options.group]]
	let consumers: unknown = [['name', 'consumer', 'idle', 0]]
	let completion = true
	let entryPresent = true
	let beforeRelease: () => void = () => undefined
	const redis: RepairRedis = {
		get: async (key) => values.get(key) ?? null,
		mget: async (...keys) => keys.map((key) => values.get(key) ?? null),
		xinfo: async (command) => (command === 'GROUPS' ? groups : consumers),
		xrange: async () => (entryPresent ? [['123-0', []]] : []),
		eval: async (script, keyCount, ...args) => {
			const keys = args.slice(0, keyCount)
			const argv = args.slice(keyCount)
			calls.push({ script, keys, argv })
			beforeRelease()
			if ((values.get(keys[0]!) ?? null) !== (argv[13] === '0' ? null : argv[0])) return ['changed-fence', '']
			if ((values.get(keys[5]!) ?? null) !== (argv[14] === '0' ? null : argv[15])) return ['changed-generation', '']
			if ((values.get(keys[1]!) ?? null) !== (argv[1] === '0' ? null : argv[2])) return ['changed-version', '']
			values.delete(keys[0]!)
			if (completion)
				values.set(
					verifiedRepairReceiptKey(options.stream, argv[10]!),
					JSON.stringify({
						token: argv[10],
						did: argv[6],
						rkey: argv[7],
						recordCid: argv[11],
						manifestFingerprint: argv[12],
						invalidationStreamId: '456-0',
					}),
				)
			return ['enqueued', '123-0']
		},
	}
	const dependencies: RepairDependencies = {
		redis,
		preflight: async (did, rkey) => {
			verifiedSites.push([did, rkey])
			return { ...proof }
		},
	}
	return {
		dependencies,
		values,
		calls,
		verifiedSites,
		fenceKey,
		versionKey,
		otherFence,
		setGroups: (value: unknown) => {
			groups = value
		},
		setConsumers: (value: unknown) => {
			consumers = value
		},
		setCompletion: (value: boolean) => {
			completion = value
		},
		setEntryPresent: (value: boolean) => {
			entryPresent = value
		},
		beforeRelease: (callback: () => void) => {
			beforeRelease = callback
		},
	}
}

describe('verified exact-site repair', () => {
	test('dry-run verifies empty declared blobs without any Redis mutation', async () => {
		const h = harness()
		const result = await repairSite({ ...options, apply: false }, h.dependencies, signal())
		expect(result.status).toBe('dry-run')
		expect(h.verifiedSites).toEqual([[options.did, options.rkey]])
		expect(h.calls).toHaveLength(0)
		expect(h.values.get(h.fenceKey)).toBe('')
	})

	test('same-CID repair targets only the exact site and requires materialization proof', async () => {
		const h = harness()
		const result = await repairSite(options, h.dependencies, signal())
		expect(result.status).toBe('materialized')
		expect(h.verifiedSites).toEqual(Array.from({ length: 3 }, () => [options.did, options.rkey]))
		expect(h.calls).toHaveLength(1)
		const call = h.calls[0]!
		expect(call.keys.slice(0, 3)).toEqual([h.fenceKey, h.versionKey, options.stream])
		expect(call.argv.slice(6, 9)).toEqual([options.did, options.rkey, VERIFIED_REPAIR_REASON])
		expect(call.argv[2]).toBe('revision')
		expect(call.argv[11]).toBe(proof.recordCid)
		expect(h.values.get(h.otherFence)).toBe('other-fence')
		expect(h.values.get(h.versionKey)).toBe('revision')
		expect(h.values.has(h.fenceKey)).toBe(false)
		expect(call.script.indexOf("redis.call('XADD'")).toBeLessThan(call.script.indexOf("redis.call('DEL', KEYS[1])"))
		expect(call.script).not.toContain('XDEL')
	})

	test('unfenced bad cache still gets a full verified same-CID repair', async () => {
		const h = harness()
		h.values.delete(h.fenceKey)
		expect((await repairSite(options, h.dependencies, signal())).status).toBe('materialized')
		expect(h.calls[0]?.argv[13]).toBe('0')
		expect(h.values.get(h.otherFence)).toBe('other-fence')
	})

	test('same-value re-quarantine is detected by the generation marker', async () => {
		const h = harness()
		h.beforeRelease(() => h.values.set(verifiedRepairQuarantineGenerationKey(options.did, options.rkey), 'new-dlq-id'))
		await expect(repairSite(options, h.dependencies, signal())).rejects.toThrow('changed-generation')
		expect(h.values.get(h.fenceKey)).toBe('')
	})

	test('missing revision is preserved, never fabricated', async () => {
		const h = harness()
		h.values.delete(h.versionKey)
		await repairSite(options, h.dependencies, signal())
		expect(h.calls[0]?.argv.slice(1, 3)).toEqual(['0', ''])
	})

	for (const field of ['fence', 'version'] as const)
		test(`concurrent ${field} changes refuse release`, async () => {
			const h = harness()
			h.beforeRelease(() => h.values.set(field === 'fence' ? h.fenceKey : h.versionKey, 'newer'))
			await expect(repairSite(options, h.dependencies, signal())).rejects.toThrow(`changed-${field}`)
			expect(h.values.has(h.fenceKey)).toBe(true)
		})

	test('failed raw verification never releases or enqueues', async () => {
		const h = harness()
		h.dependencies.preflight = async () => {
			throw new Error('BLOB_CID_MISMATCH')
		}
		await expect(repairSite(options, h.dependencies, signal())).rejects.toThrow('BLOB_CID_MISMATCH')
		expect(h.calls).toHaveLength(0)
		expect(h.values.get(h.fenceKey)).toBe('')
	})

	test('root or expanded SubFS manifest changes never release', async () => {
		for (const change of [{ recordCid: 'new-root' }, { manifestFingerprint: 'b'.repeat(64) }]) {
			const h = harness()
			let reads = 0
			h.dependencies.preflight = async () => ({ ...proof, ...(reads++ ? change : {}) })
			await expect(repairSite(options, h.dependencies, signal())).rejects.toThrow('Source manifest changed')
			expect(h.calls).toHaveLength(0)
		}
	})

	test('wrong group, additional group, stale consumers and old workers refuse before preflight', async () => {
		for (const mutate of [
			(h: ReturnType<typeof harness>) => h.setGroups([]),
			(h: ReturnType<typeof harness>) => h.setGroups([['name', 'wrong']]),
			(h: ReturnType<typeof harness>) =>
				h.setGroups([
					['name', options.group],
					['name', 'extra'],
				]),
			(h: ReturnType<typeof harness>) => h.setConsumers([['name', 'consumer', 'idle', 60_001]]),
			(h: ReturnType<typeof harness>) => h.values.delete(verifiedRepairCapabilityKey(options.stream, options.group)),
		]) {
			const h = harness()
			mutate(h)
			await expect(repairSite(options, h.dependencies, signal())).rejects.toThrow()
			expect(h.calls).toHaveLength(0)
			expect(h.verifiedSites).toHaveLength(0)
		}
	})

	test('lost enqueue response reports unknown outcome with the durable receipt key', async () => {
		const h = harness()
		const commit = h.dependencies.redis.eval
		h.dependencies.redis.eval = async (...args) => {
			await commit(...args)
			throw new Error('connection lost')
		}
		await expect(repairSite(options, h.dependencies, signal())).rejects.toThrow('outcome is unknown; token=')
		expect(h.values.has(h.fenceKey)).toBe(false)
	})

	test('ACK or queue disappearance is not success', async () => {
		const h = harness()
		h.setCompletion(false)
		h.setEntryPresent(false)
		await expect(repairSite(options, h.dependencies, signal())).rejects.toThrow('without materialization proof')
	})

	test('timeout after enqueue reports unconfirmed, not success', async () => {
		const h = harness()
		h.setCompletion(false)
		await expect(repairSite({ ...options, waitMs: 10 }, h.dependencies, signal())).rejects.toThrow('unconfirmed')
	})

	test('post-enqueue source changes cannot report success', async () => {
		const h = harness()
		let reads = 0
		h.dependencies.preflight = async () => ({ ...proof, recordCid: ++reads === 3 ? 'new-root' : proof.recordCid })
		await expect(repairSite(options, h.dependencies, signal())).rejects.toThrow('Source changed after enqueue')
	})

	test('cancelled work cannot write', async () => {
		const h = harness()
		const controller = new AbortController()
		controller.abort()
		await expect(repairSite(options, h.dependencies, controller.signal)).rejects.toThrow()
		expect(h.calls).toHaveLength(0)
	})
})

describe('repair command boundary', () => {
	const env = { REDIS_URL: 'redis://localhost:6379', WISP_REVALIDATE_STREAM: 'live', WISP_REVALIDATE_GROUP: 'worker' }
	test('requires exact DID and rkey; dry-run is the default', () => {
		expect(parseRepairSiteArguments(['--did', options.did, '--rkey', options.rkey], env).apply).toBe(false)
		for (const args of [
			[],
			['--did', options.did],
			['--rkey', options.rkey],
			['--did', `${options.did},did:plc:other`, '--rkey', 'site'],
			['--did', options.did, '--rkey', '*'],
			['--did', options.did, '--rkey', 'site', '--apply', '--apply'],
		]) {
			expect(() => parseRepairSiteArguments(args, env)).toThrow()
		}
	})
	test('apply requires explicit fleet-rollout acknowledgement', () => {
		const args = ['--did', options.did, '--rkey', options.rkey, '--apply']
		expect(() => parseRepairSiteArguments(args, env)).toThrow('--confirm-worker-rollout')
		expect(parseRepairSiteArguments([...args, '--confirm-worker-rollout'], env).apply).toBe(true)
	})
	test('requires explicit Redis, stream and group even for dry-run', () => {
		for (const key of Object.keys(env))
			expect(() =>
				parseRepairSiteArguments(['--did', options.did, '--rkey', 'site'], { ...env, [key]: undefined }),
			).toThrow()
	})
})

describe('repair manifest binding', () => {
	const root = (size = 0): Directory =>
		parseLexiconJson<Directory>({
			type: 'directory',
			entries: [
				{
					name: 'empty',
					node: {
						type: 'file',
						blob: {
							$type: 'blob',
							ref: { $link: 'bafkreie56uer6qjm7mqckb52xtd3mecy77t5axnumzdcnhjzpcwiin6zue' },
							mimeType: 'text/plain',
							size,
						},
					},
				},
			],
		})
	test('binds empty files, declared size, source owner and root CID', () => {
		const owners = new Map([['empty', options.did]])
		const fingerprint = fingerprintSiteManifest('cid', root(), owners)
		expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
		expect(fingerprintSiteManifest('cid', root(1), owners)).not.toBe(fingerprint)
		expect(fingerprintSiteManifest('cid', root(), new Map([['empty', 'did:plc:other']]))).not.toBe(fingerprint)
		expect(fingerprintSiteManifest('new-cid', root(), owners)).not.toBe(fingerprint)
		expect(() => fingerprintSiteManifest('cid', root(), new Map())).toThrow('unbound')
	})
	test('rejects unsupported targeted worker protocol', () => {
		expect(() => parseVerifiedRepairRequest({ reason: VERIFIED_REPAIR_REASON })).toThrow()
		expect(parseVerifiedRepairRequest({ reason: 'storage-miss' })).toBeUndefined()
	})
})
