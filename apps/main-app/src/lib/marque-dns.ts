/** marque.at's record for a domain it registered, in the owner's repo; rkey is the apex. */
export const MARQUE_DOMAIN_COLLECTION = 'at.marque.domain'

/** One resource record in an `at.marque.dns` zone. */
export interface MarqueEntry {
	name: string
	recordType: string
	value: string
	ttl: number
	priority?: number
}

/** What wisp needs in a zone for one custom domain. */
export interface WispRecords {
	/** The custom domain, lowercased. */
	domain: string
	/** The marque apex it sits in. */
	apex: string
	did: string
	/** Where the domain's CNAME points, `<id>.dns.wisp.place`. */
	target: string
}

export type ZonePlan =
	| { kind: 'unchanged' }
	| { kind: 'write'; records: MarqueEntry[] }
	| { kind: 'conflict'; conflicts: MarqueEntry[] }

const bare = (name: string) => name.toLowerCase().replace(/\.$/, '')

/** TXT values come back quoted from some zone editors. */
const unquote = (value: string) => value.replace(/^"(.*)"$/, '$1')

/** The longest apex in `owned` that `domain` is, or sits under. */
export const marqueApex = (domain: string, owned: readonly string[]): string | null =>
	owned
		.map(bare)
		.filter((apex) => domain === apex || domain.endsWith(`.${apex}`))
		.sort((a, b) => b.length - a.length)[0] ?? null

/** A name relative to its zone, as marque writes them: `@` for the apex itself. */
export const relativeName = (domain: string, apex: string): string =>
	domain === apex ? '@' : domain.slice(0, -(apex.length + 1))

/** The CNAME and ownership TXT wisp verifies, as zone entries. */
export const wispEntries = ({ domain, apex, did, target }: WispRecords): [MarqueEntry, MarqueEntry] => {
	const name = relativeName(domain, apex)
	return [
		{ name, recordType: 'CNAME', value: target, ttl: 300 },
		{ name: name === '@' ? '_wisp' : `_wisp.${name}`, recordType: 'TXT', value: did, ttl: 300 },
	]
}

const isEntry = (entry: MarqueEntry, wanted: MarqueEntry) =>
	entry.recordType === wanted.recordType &&
	bare(entry.name) === bare(wanted.name) &&
	(wanted.recordType === 'CNAME' ? bare(entry.value) === bare(wanted.value) : unquote(entry.value) === wanted.value)

/**
 * Whether `entry` would answer instead of `wanted`, or alongside it. At the
 * domain that is any address or other CNAME, and below the apex anything at
 * all, since a CNAME can not share its name. At `_wisp` it is any other TXT:
 * the verifier warns about extra ownership records.
 */
const isInTheWay = (entry: MarqueEntry, wanted: MarqueEntry) => {
	if (bare(entry.name) !== bare(wanted.name) || isEntry(entry, wanted)) return false
	if (wanted.recordType === 'TXT') return entry.recordType === 'TXT' || entry.recordType === 'CNAME'
	return wanted.name !== '@' || ['A', 'AAAA', 'CNAME'].includes(entry.recordType)
}

/**
 * Add wisp's records to a zone and leave every other record exactly as it was.
 * Records in the way stop the plan, unless `replace` is set, which drops
 * exactly those.
 */
export function planZone(records: readonly MarqueEntry[], wanted: readonly MarqueEntry[], replace = false): ZonePlan {
	const conflicts = records.filter((entry) => wanted.some((want) => isInTheWay(entry, want)))
	if (conflicts.length > 0 && !replace) return { kind: 'conflict', conflicts }
	const missing = wanted.filter((want) => !records.some((entry) => isEntry(entry, want)))
	if (conflicts.length === 0 && missing.length === 0) return { kind: 'unchanged' }
	return { kind: 'write', records: [...records.filter((entry) => !conflicts.includes(entry)), ...missing] }
}

/** A zone record as stored, with the CID a write has to swap against. */
export interface StoredZone {
	cid: string
	value: { records: MarqueEntry[] } & Record<string, unknown>
}

/** What marque setup reads and writes, so the flow can be tested without a PDS or DNS. */
export interface MarquePorts {
	/** The account's `at.marque.domain` records: each apex and the nameservers marque assigned it. */
	ownedDomains(): Promise<{ domain: string; nameServers: string[] }[]>
	/** The nameservers the apex actually delegates to right now. */
	liveNameservers(apex: string): Promise<string[]>
	getZone(apex: string): Promise<StoredZone | null>
	/** Replace the zone record if it is still at `swapCid`; false when it moved on. */
	putZone(apex: string, value: StoredZone['value'], swapCid: string): Promise<boolean>
}

export type MarqueStatus =
	| { managed: false }
	| { managed: true; apex: string; state: 'ready' | 'done' | 'conflict'; conflicts: MarqueEntry[] }

/**
 * Whether marque serves this domain's dns from a zone wisp can write: the
 * account registered the apex through marque, the apex still delegates to the
 * nameservers marque assigned it, and its zone record exists.
 */
async function managedZone(ports: MarquePorts, domain: string) {
	const owned = await ports.ownedDomains()
	const apex = marqueApex(
		domain,
		owned.map((record) => record.domain),
	)
	if (!apex) return null
	const assigned = new Set(owned.find((record) => bare(record.domain) === apex)?.nameServers.map(bare))
	const live = await ports.liveNameservers(apex)
	if (live.length === 0 || !live.every((ns) => assigned.has(bare(ns)))) return null
	const zone = await ports.getZone(apex)
	return zone ? { apex, zone } : null
}

const stateOf = (plan: ZonePlan) => (plan.kind === 'write' ? 'ready' : plan.kind === 'unchanged' ? 'done' : 'conflict')

export async function marqueStatus(ports: MarquePorts, wisp: Omit<WispRecords, 'apex'>): Promise<MarqueStatus> {
	const managed = await managedZone(ports, wisp.domain)
	if (!managed) return { managed: false }
	const plan = planZone(managed.zone.value.records, wispEntries({ ...wisp, apex: managed.apex }))
	return {
		managed: true,
		apex: managed.apex,
		state: stateOf(plan),
		conflicts: plan.kind === 'conflict' ? plan.conflicts : [],
	}
}

export type MarqueApplyResult =
	| { state: 'unmanaged' }
	| { state: 'done' }
	| { state: 'conflict'; conflicts: MarqueEntry[] }

/** Something else rewrote the zone between our read and every retry of the write. */
export class MarqueZoneBusyError extends Error {
	constructor(apex: string) {
		super(`The marque zone for ${apex} kept changing; try again`)
	}
}

const WRITE_ATTEMPTS = 3

/**
 * Write wisp's records into the domain's marque zone. Each write swaps against
 * the zone it was planned from, so an edit made meanwhile (in marque's own
 * dashboard, say) is re-read and planned again rather than overwritten.
 */
export async function applyMarqueDns(
	ports: MarquePorts,
	wisp: Omit<WispRecords, 'apex'>,
	replace = false,
): Promise<MarqueApplyResult> {
	const managed = await managedZone(ports, wisp.domain)
	if (!managed) return { state: 'unmanaged' }
	const { apex } = managed
	const wanted = wispEntries({ ...wisp, apex })
	let zone: StoredZone | null = managed.zone
	for (let attempt = 0; attempt < WRITE_ATTEMPTS && zone; attempt++) {
		const plan = planZone(zone.value.records, wanted, replace)
		if (plan.kind === 'unchanged') return { state: 'done' }
		if (plan.kind === 'conflict') return { state: 'conflict', conflicts: plan.conflicts }
		const value = { ...zone.value, records: plan.records, createdAt: new Date().toISOString() }
		if (await ports.putZone(apex, value, zone.cid)) return { state: 'done' }
		zone = await ports.getZone(apex)
	}
	if (!zone) return { state: 'unmanaged' }
	throw new MarqueZoneBusyError(apex)
}
