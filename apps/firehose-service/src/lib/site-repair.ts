import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { revalidationQuarantineKey, revalidationSiteVersionKey } from '@wispplace/constants'
import {
	parseVerifiedRepairReceipt,
	VERIFIED_REPAIR_PROTOCOL,
	VERIFIED_REPAIR_REASON,
	type VerifiedRepairReceipt,
	type VerifiedRepairRequest,
	type VerifiedSitePreflight,
	verifiedRepairCapabilityKey,
	verifiedRepairQuarantineGenerationKey,
	verifiedRepairReceiptKey,
} from './site-repair-protocol'

export interface RepairSiteOptions {
	did: string
	rkey: string
	apply: boolean
	stream: string
	group: string
	maxStreamLength: number
	waitMs: number
}

export interface RepairRedis {
	get(key: string): Promise<string | null>
	mget(...keys: string[]): Promise<Array<string | null>>
	xinfo(command: 'GROUPS', stream: string): Promise<unknown>
	xinfo(command: 'CONSUMERS', stream: string, group: string): Promise<unknown>
	xrange(stream: string, start: string, end: string, count: 'COUNT', limit: number): Promise<Array<[string, string[]]>>
	eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
}

export interface RepairDependencies {
	redis: RepairRedis
	/** Canonical lookup, expanded manifest admission, and raw verification; never writes. */
	preflight(did: string, rkey: string, signal: AbortSignal): Promise<VerifiedSitePreflight>
	onEnqueued?(event: { streamId: string; request: VerifiedRepairRequest }): void
}

interface FenceSnapshot {
	quarantine: string | null
	version: string | null
	generation: string | null
}

function infoRows(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) throw new Error('Invalid Redis consumer information')
	return value.map((row) => {
		if (!Array.isArray(row) || row.length % 2) throw new Error('Invalid Redis consumer information')
		const result: Record<string, unknown> = {}
		for (let index = 0; index < row.length; index += 2) {
			if (typeof row[index] !== 'string') throw new Error('Invalid Redis consumer information')
			result[row[index]] = row[index + 1]
		}
		return result
	})
}

/** A recent consumer alone is insufficient: require the versioned worker's expiring lease. */
export async function assertVerifiedRepairWorker(redis: RepairRedis, options: RepairSiteOptions): Promise<void> {
	const groups = infoRows(await redis.xinfo('GROUPS', options.stream))
	if (groups.length !== 1 || groups[0]?.name !== options.group) {
		throw new Error('Expected exactly the configured worker group; refusing repair')
	}
	const consumers = infoRows(await redis.xinfo('CONSUMERS', options.stream, options.group))
	const active = consumers.filter((consumer) => typeof consumer.idle === 'number' && consumer.idle < 60_000)
	const capability = await redis.get(verifiedRepairCapabilityKey(options.stream, options.group))
	if (active.length !== 1 || capability !== `${VERIFIED_REPAIR_PROTOCOL}:${active[0]?.name}`) {
		throw new Error('No sole active worker with the verified-repair capability; deploy or wait for a healthy worker')
	}
}

/** All checks precede the first mutation. Enqueue first; release the exact fence last. */
export const RELEASE_AND_ENQUEUE_VERIFIED_REPAIR_SCRIPT = `
local groups = redis.call('XINFO', 'GROUPS', KEYS[3])
if #groups ~= 1 then return {'refused-group', ''} end
local groupName = nil
for i = 1, #groups[1], 2 do
  if groups[1][i] == 'name' then groupName = groups[1][i+1] end
end
if groupName ~= ARGV[4] then return {'refused-group', ''} end
local consumers = redis.call('XINFO', 'CONSUMERS', KEYS[3], ARGV[4])
local active = 0
local activeName = nil
for _, consumer in ipairs(consumers) do
  local name = nil
  local idle = nil
  for i = 1, #consumer, 2 do
    if consumer[i] == 'name' then name = consumer[i+1] end
    if consumer[i] == 'idle' then idle = tonumber(consumer[i+1]) end
  end
  if idle and idle < 60000 then active = active + 1; activeName = name end
end
if active ~= 1 or redis.call('GET', KEYS[4]) ~= ARGV[5] .. ':' .. activeName then
  return {'refused-worker', ''}
end
local fence = redis.call('GET', KEYS[1])
local version = redis.call('GET', KEYS[2])
if (ARGV[14] == '0' and fence ~= false) or (ARGV[14] == '1' and fence ~= ARGV[1]) then return {'changed-fence', ''} end
local generation = redis.call('GET', KEYS[6])
if (ARGV[15] == '0' and generation ~= false) or (ARGV[15] == '1' and generation ~= ARGV[16]) then
  return {'changed-generation', ''}
end
if (ARGV[2] == '0' and version ~= false) or (ARGV[2] == '1' and version ~= ARGV[3]) then
  return {'changed-version', ''}
end
local existing = redis.call('GET', KEYS[5])
if existing then
  local found = redis.call('XRANGE', KEYS[3], existing, existing, 'COUNT', 1)
  if #found > 0 then return {'already-pending', ''} end
end
if redis.call('XLEN', KEYS[3]) >= tonumber(ARGV[6]) then return {'capacity', ''} end
local id = redis.call('XADD', KEYS[3], '*',
  'did', ARGV[7], 'rkey', ARGV[8], 'reason', ARGV[9], 'ts', ARGV[10],
  'sourceVersion', ARGV[3], 'repairProtocol', ARGV[5], 'repairToken', ARGV[11],
  'repairRecordCid', ARGV[12], 'repairManifestFingerprint', ARGV[13])
redis.call('SET', KEYS[5], id, 'EX', 86400)
if ARGV[14] == '1' then redis.call('DEL', KEYS[1]) end
return {'enqueued', id}
`

export function assertExactSite(did: string, rkey: string): void {
	if (did.length > 2048 || !/^did:[a-z]+:(?:[a-zA-Z0-9._:-]|%[0-9A-F]{2})*[a-zA-Z0-9._-]$/.test(did)) {
		throw new Error('--did must name exactly one DID, not a handle, list, or prefix')
	}
	if (!/^[a-zA-Z0-9_~.:-]{1,512}$/.test(rkey) || rkey === '.' || rkey === '..') {
		throw new Error('--rkey must name exactly one record key, not a list or prefix')
	}
}

function sameManifest(left: VerifiedSitePreflight, right: VerifiedSitePreflight): boolean {
	return left.recordCid === right.recordCid && left.manifestFingerprint === right.manifestFingerprint
}

async function awaitRepairProof(
	options: RepairSiteOptions,
	dependencies: RepairDependencies,
	request: VerifiedRepairRequest,
	streamId: string,
	signal: AbortSignal,
): Promise<VerifiedRepairReceipt> {
	const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(options.waitMs)])
	try {
		while (true) {
			waitSignal.throwIfAborted()
			const receipt = await dependencies.redis.get(verifiedRepairReceiptKey(options.stream, request.token))
			if (receipt !== null) return parseVerifiedRepairReceipt(receipt, request, options)
			const fence = await dependencies.redis.get(revalidationQuarantineKey(options.did, options.rkey))
			if (fence !== null) throw new Error('Repair was quarantined again; preserve DLQ evidence and inspect the worker')
			const entry = await dependencies.redis.xrange(options.stream, streamId, streamId, 'COUNT', 1)
			if (entry.length === 0) {
				// The receipt is written before ACK; re-read to close the race between the two reads.
				const completed = await dependencies.redis.get(verifiedRepairReceiptKey(options.stream, request.token))
				if (completed !== null) return parseVerifiedRepairReceipt(completed, request, options)
				throw new Error('Repair entry disappeared without materialization proof; outcome is unconfirmed')
			}
			await delay(250, undefined, { signal: waitSignal })
		}
	} catch (error) {
		if (waitSignal.aborted)
			throw new Error(`Repair ${streamId} remains unconfirmed; timeout or cancellation is not success`)
		throw error
	}
}

export type RepairSiteResult =
	| { status: 'dry-run'; did: string; rkey: string; snapshot: FenceSnapshot; verified: VerifiedSitePreflight }
	| { status: 'materialized'; streamId: string; receipt: VerifiedRepairReceipt }

export async function repairSite(
	options: RepairSiteOptions,
	dependencies: RepairDependencies,
	signal: AbortSignal,
): Promise<RepairSiteResult> {
	assertExactSite(options.did, options.rkey)
	if (!/^[A-Za-z0-9:_-]{1,128}$/.test(options.stream) || !/^[A-Za-z0-9:_-]{1,128}$/.test(options.group)) {
		throw new Error('Explicit live stream and worker group are required')
	}
	if (
		!Number.isSafeInteger(options.maxStreamLength) ||
		options.maxStreamLength < 1 ||
		options.maxStreamLength > 1_000_000 ||
		!Number.isSafeInteger(options.waitMs) ||
		options.waitMs < 1 ||
		options.waitMs > 1_800_000
	) {
		throw new Error('Invalid repair queue or wait bound')
	}
	signal.throwIfAborted()
	await assertVerifiedRepairWorker(dependencies.redis, options)
	const keys = [
		revalidationQuarantineKey(options.did, options.rkey),
		revalidationSiteVersionKey(options.did, options.rkey),
	]
	const generationKey = verifiedRepairQuarantineGenerationKey(options.did, options.rkey)
	const [quarantine, version, generation] = await dependencies.redis.mget(...keys, generationKey)
	if ([quarantine, version, generation].some((value) => value !== null && typeof value !== 'string')) {
		throw new Error('Invalid site fence/version/generation snapshot')
	}
	const snapshot = { quarantine: quarantine!, version: version!, generation: generation! }
	const verified = await dependencies.preflight(options.did, options.rkey, signal)
	signal.throwIfAborted()
	if (!options.apply) return { status: 'dry-run', did: options.did, rkey: options.rkey, snapshot, verified }
	// Re-read and verify the complete source, including mutable cross-repository SubFS records.
	const current = await dependencies.preflight(options.did, options.rkey, signal)
	if (!sameManifest(verified, current)) throw new Error('Source manifest changed during preflight; no fence released')
	signal.throwIfAborted()
	const request: VerifiedRepairRequest = {
		token: randomUUID(),
		recordCid: verified.recordCid,
		manifestFingerprint: verified.manifestFingerprint,
	}
	let result: unknown
	try {
		result = await dependencies.redis.eval(
			RELEASE_AND_ENQUEUE_VERIFIED_REPAIR_SCRIPT,
			6,
			...keys,
			options.stream,
			verifiedRepairCapabilityKey(options.stream, options.group),
			`revalidate:site:storage-miss:${options.did}:${options.rkey}`,
			generationKey,
			snapshot.quarantine ?? '',
			snapshot.version === null ? '0' : '1',
			snapshot.version ?? '',
			options.group,
			VERIFIED_REPAIR_PROTOCOL,
			String(options.maxStreamLength),
			options.did,
			options.rkey,
			VERIFIED_REPAIR_REASON,
			String(Date.now()),
			request.token,
			request.recordCid,
			request.manifestFingerprint,
			snapshot.quarantine === null ? '0' : '1',
			snapshot.generation === null ? '0' : '1',
			snapshot.generation ?? '',
		)
	} catch (error) {
		throw new Error(
			`Repair enqueue outcome is unknown; token=${request.token} receipt=${verifiedRepairReceiptKey(options.stream, request.token)}. Inspect before retrying.`,
			{ cause: error },
		)
	}
	if (!Array.isArray(result) || result[0] !== 'enqueued' || typeof result[1] !== 'string') {
		throw new Error(`Repair release refused: ${Array.isArray(result) ? result[0] : 'invalid response'}`)
	}
	const streamId = result[1]
	dependencies.onEnqueued?.({ streamId, request })
	const receipt = await awaitRepairProof(options, dependencies, request, streamId, signal)
	const final = await dependencies.preflight(options.did, options.rkey, signal)
	if (!sameManifest(verified, final))
		throw new Error('Source changed after enqueue; requested repair cannot be confirmed')
	const [finalFence, finalVersion, finalGeneration] = await dependencies.redis.mget(...keys, generationKey)
	if (finalFence !== null || finalVersion !== snapshot.version || finalGeneration !== snapshot.generation)
		throw new Error('Site fence/version changed after enqueue; repair cannot be confirmed')
	signal.throwIfAborted()
	return { status: 'materialized', streamId, receipt }
}
