import { assertExactSite, type RepairSiteOptions } from './site-repair'

export function parseRepairSiteArguments(
	argv: string[],
	environment: Readonly<Record<string, string | undefined>>,
): RepairSiteOptions {
	let did = ''
	let rkey = ''
	let apply = false
	let confirmedWorkerRollout = false
	let waitMs = 600_000
	const seen = new Set<string>()
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index]!
		if (seen.has(flag)) throw new Error(`Repeated argument: ${flag}`)
		seen.add(flag)
		if (flag === '--confirm-worker-rollout') {
			confirmedWorkerRollout = true
			continue
		}
		if (flag === '--apply') {
			apply = true
			continue
		}
		if (!['--did', '--rkey', '--wait-ms'].includes(flag)) throw new Error(`Unknown argument: ${flag}`)
		const value = argv[++index]
		if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
		if (flag === '--did') did = value
		else if (flag === '--rkey') rkey = value
		else waitMs = Number(value)
	}
	assertExactSite(did, rkey)
	if (apply && !confirmedWorkerRollout) {
		throw new Error(
			'--apply requires --confirm-worker-rollout: all possible workers, including standby workers, must be upgraded',
		)
	}
	if (!Number.isSafeInteger(waitMs) || waitMs < 1_000 || waitMs > 1_800_000) {
		throw new Error('--wait-ms must be an integer in [1000, 1800000]')
	}
	const redisUrl = environment.REDIS_URL
	if (!redisUrl) throw new Error('REDIS_URL must be set explicitly')
	const url = new URL(redisUrl)
	if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('Invalid REDIS_URL')
	const stream = environment.WISP_REVALIDATE_STREAM
	const group = environment.WISP_REVALIDATE_GROUP
	if (!stream || !group || !/^[A-Za-z0-9:_-]{1,128}$/.test(stream) || !/^[A-Za-z0-9:_-]{1,128}$/.test(group)) {
		throw new Error('WISP_REVALIDATE_STREAM and WISP_REVALIDATE_GROUP must be set explicitly')
	}
	const maxStreamLength = Number(environment.WISP_REVALIDATE_STREAM_MAXLEN ?? '10000')
	if (!Number.isSafeInteger(maxStreamLength) || maxStreamLength < 1 || maxStreamLength > 1_000_000) {
		throw new Error('WISP_REVALIDATE_STREAM_MAXLEN must be an integer in [1, 1000000]')
	}
	return { did, rkey, apply, waitMs, stream, group, maxStreamLength }
}
