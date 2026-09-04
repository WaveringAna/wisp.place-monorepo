import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import { createLogger } from '@wispplace/observability'
import { config } from '../config'
import type { PriorReferenceWrite, WebhookEntry } from './db'
import * as database from './db'
import * as delivery from './delivery'
import {
	buildJetstreamSubscriptionUrl,
	JetstreamClient,
	type JetstreamEvent,
	type JetstreamOptions,
	normalizeRelayIdentity,
} from './jetstream'
import {
	collectAtUriReferences,
	collectRelevantAtUriReferences,
	type EventKind,
	isDid,
	matchWebhooks,
	parseAtUri,
	scopeDid,
	validateWebhookRecord,
} from './matcher'
import {
	BACKLINK_CACHE_KEY,
	clearRegistryCache,
	getCached,
	getCacheGeneration,
	invalidate,
	invalidateMany,
	setCachedIfCurrent,
} from './registry'
import { assertSafeWebhookUrlSyntax } from './webhook-url'

const logger = createLogger('webhook-service:firehose')

const WH_COLLECTION = 'place.wisp.v2.wh'
const MAX_RELEVANT_REFERENCES =
	typeof database.MAX_BACKLINK_REFERENCES_PER_EVENT === 'number' && database.MAX_BACKLINK_REFERENCES_PER_EVENT > 0
		? database.MAX_BACKLINK_REFERENCES_PER_EVENT
		: 100
const DIRECT_STREAM = 'direct'
const BACKLINK_STREAM = 'backlink'
const REGISTRY_STREAM = 'registry'
type StreamName = typeof DIRECT_STREAM | typeof BACKLINK_STREAM | typeof REGISTRY_STREAM

export interface CursorRepository {
	load(stream: StreamName, relay: string): Promise<number | undefined>
	save(stream: StreamName, cursor: number, relay: string): Promise<void>
}

interface PriorReferenceSnapshot {
	references: readonly string[]
	timeUs?: number
	rev?: string
}

/** Durable, bounded backlink state. It deliberately stores references, never whole records. */
export interface PriorReferenceRepository {
	load(eventAtUri: string): Promise<PriorReferenceSnapshot | undefined>
	save(eventAtUri: string, references: readonly string[], timeUs: number, rev: string): Promise<PriorReferenceWrite>
	/** True only when this event removed the durable row. */
	delete(eventAtUri: string, timeUs: number, rev: string): Promise<boolean>
	/** Bounded hydration of the keys that own durable references, when available. */
	keys?(): Promise<{ keys: readonly string[]; complete: boolean }>
}

interface DurableDeliveryEvent {
	relay: string
	timeUs: number
	rev: string
	operation: EventKind
	did: string
	collection: string
	rkey: string
	cid?: string
	record?: unknown
}

type EnqueueWebhookDeliveries = (
	entries: readonly WebhookEntry[],
	event: DurableDeliveryEvent,
) => Promise<{ enqueued: number; deduplicated: number }>

interface FirehoseStartOptions {
	/** Test seam. Production uses the durable DB cursor repository. */
	cursorRepository?: CursorRepository
	/** Test seam. Production requires the durable DB prior-reference repository. */
	referenceRepository?: PriorReferenceRepository
	enqueueWebhookDeliveries?: EnqueueWebhookDeliveries
	/** Test seam. Production writes an idempotent redacted intake quarantine row. */
	recordWebhookIntakeQuarantine?: typeof database.recordWebhookIntakeQuarantine
	createJetstreamClient?: (options: JetstreamOptions) => JetstreamClient
	/** Compatibility seam for tests; each stream remains independent in production. */
	cursors?: Partial<Record<StreamName, number>>
	/** Capture relay events without invoking handlers until startup reconciliation finishes. */
	paused?: boolean
}

interface RuntimeDependencies {
	cursorRepository: CursorRepository
	referenceRepository: PriorReferenceRepository
	enqueueWebhookDeliveries: EnqueueWebhookDeliveries
	recordWebhookIntakeQuarantine: typeof database.recordWebhookIntakeQuarantine
	createJetstreamClient: (options: JetstreamOptions) => JetstreamClient
}

interface WhMutationResult {
	deliveryRecord?: WhRecord
	selfKey: string
	/** Deterministic malformed/unsafe registration: revoke and acknowledge, never replay forever. */
	ackableInvalid?: true
}

let lastEventTime = 0
let totalEvents = 0
let totalMatched = 0
let tooComplexBacklinkEvents = 0
let invalidRegistryRecords = 0
let invalidDeliveryInputEvents = 0
let rejectedSubscriptionAdmissions = 0
let registrySnapshotOverflow = false
let firehoseStarted = false
let stopping = false
let reconfigureScheduled = false
let reconfiguring: Promise<void> | null = null
let directRestartCursorHint: number | undefined
let backlinkRestartCursorHint: number | undefined
let forceStreamRestart = false
let refreshRegistryPromise: Promise<void> | null = null
let intakePaused = false
const CURSOR_SAFETY_REWIND_US = 2_000_000
let dependencies: RuntimeDependencies | null = null

let scopeDids = new Set<string>()
let ownerDids = new Set<string>()
let backlinkScopeDids = new Set<string>()
let directWantedDids = new Set<string>()

let directJetstream: JetstreamClient | null = null
let backlinkJetstream: JetstreamClient | null = null
// Always-on, collection-filtered discovery stream. It is the sole mutation path
// for webhook registrations, including an owner's first-ever record.
let registryJetstream: JetstreamClient | null = null
const allClients = new Set<JetstreamClient>()

const cursorWriteTails = new Map<StreamName, Promise<void>>()

function safeError(stream: StreamName): void {
	logger.warn(`[${stream}] intake event failed; cursor was not advanced`)
}

function sortedDids(values: ReadonlySet<string>): string[] {
	return [...values].sort()
}

function eventAtUri(did: string, collection: string, rkey: string): string {
	return `at://${did}/${collection}/${rkey}`
}

function normalizeReferences(references: readonly string[]): string[] {
	const result = new Set<string>()
	for (const reference of references) {
		const parsed = parseAtUri(reference)
		if (!parsed || !backlinkScopeDids.has(parsed.did)) continue
		result.add(
			`at://${parsed.did}${parsed.collection ? `/${parsed.collection}` : ''}${parsed.rkey ? `/${parsed.rkey}` : ''}`,
		)
		if (result.size >= 256) break
	}
	return [...result]
}

function currentReferences(record: unknown): { references: string[]; tooComplex: boolean } {
	const collected = collectRelevantAtUriReferences(
		record,
		(reference) => {
			const parsed = parseAtUri(reference)
			return parsed !== null && backlinkScopeDids.has(parsed.did)
		},
		MAX_RELEVANT_REFERENCES,
	)
	return { references: normalizeReferences(collected.references), tooComplex: collected.tooComplex }
}

function referencesIntersectActiveScopes(references: readonly string[]): boolean {
	for (const reference of references) {
		const parsed = parseAtUri(reference)
		if (parsed && backlinkScopeDids.has(parsed.did)) return true
	}
	return false
}

function mergeEntries(direct: readonly WebhookEntry[], backlink: readonly WebhookEntry[]): WebhookEntry[] {
	const result = [...direct]
	const seen = new Set(result.map((entry) => `${entry.ownerDid}/${entry.rkey}`))
	for (const entry of backlink) {
		const key = `${entry.ownerDid}/${entry.rkey}`
		if (seen.has(key)) continue
		seen.add(key)
		result.push(entry)
	}
	return result
}

function entriesForTrackedKeys(keys: Iterable<string> | undefined): WebhookEntry[] {
	if (!keys) return []
	const entries: WebhookEntry[] = []
	for (const key of keys) {
		const tracked = trackedWebhooks.get(key)
		if (!tracked) continue
		entries.push({ ownerDid: tracked.ownerDid, rkey: tracked.rkey, record: tracked.record })
	}
	return entries
}

function cachedTrackedEntries(key: string, keys: Iterable<string> | undefined): readonly WebhookEntry[] {
	const cached = getCached(key)
	if (cached !== undefined) return cached
	const generation = getCacheGeneration(key)
	const entries = entriesForTrackedKeys(keys)
	// This is synchronous today, but retain the generation fence so future async
	// candidate sources cannot repopulate a mutation-invalidated entry.
	if (setCachedIfCurrent(key, entries, generation)) return getCached(key) ?? entries
	return entriesForTrackedKeys(keys)
}

async function getWebhooksForEvent(eventDid: string, referenceRecord: unknown): Promise<WebhookEntry[]> {
	const direct = cachedTrackedEntries(eventDid, scopeWebhookKeys.get(eventDid))
	const backlink = cachedTrackedEntries(BACKLINK_CACHE_KEY, backlinkWebhookKeys)
	if (backlink.length === 0 || !referencesIntersectActiveScopes(collectAtUriReferences(referenceRecord))) {
		return [...direct]
	}
	return mergeEntries(direct, backlink)
}

function defaultCursorRepository(): CursorRepository {
	const api = database as typeof database & {
		loadCursorForStream?: (stream: string, relay: string) => Promise<number | undefined>
		saveCursorForStream?: (stream: string, cursor: number, relay: string) => Promise<void>
		saveCursor?:
			| ((cursor: number, relay: string) => Promise<void>)
			| ((stream: string, cursor: number, relay: string) => Promise<void>)
	}
	return {
		async load(stream, relay) {
			if (api.loadCursorForStream) return api.loadCursorForStream(stream, relay)
			// Legacy installs have only one cursor. Never reuse it for unrelated streams.
			if (stream === DIRECT_STREAM) return database.loadCursor(relay)
			throw new Error('Independent durable cursor storage is unavailable')
		},
		async save(stream, cursor, relay) {
			if (api.saveCursorForStream) return api.saveCursorForStream(stream, cursor, relay)
			if (api.saveCursor && api.saveCursor.length >= 3) {
				return (api.saveCursor as (stream: string, cursor: number, relay: string) => Promise<void>)(
					stream,
					cursor,
					relay,
				)
			}
			if (stream === DIRECT_STREAM) return database.saveCursor(cursor, relay)
			throw new Error('Independent durable cursor storage is unavailable')
		},
	}
}

function defaultReferenceRepository(): PriorReferenceRepository {
	const api = database as typeof database & {
		loadPriorReferenceIndex?: (eventAtUri: string) => Promise<PriorReferenceSnapshot | undefined>
		savePriorReferenceIndex?: (
			eventAtUri: string,
			references: readonly string[],
			timeUs: number,
			rev: string,
		) => Promise<PriorReferenceWrite>
		deletePriorReferenceIndex?: (eventAtUri: string, timeUs: number, rev: string) => Promise<boolean>
		loadPriorReferenceKeys?: () => Promise<{ keys: readonly string[]; complete: boolean }>
	}
	return {
		async load(key) {
			if (!api.loadPriorReferenceIndex) throw new Error('Durable prior-reference storage is unavailable')
			return api.loadPriorReferenceIndex(key)
		},
		async save(key, references, timeUs, rev) {
			if (!api.savePriorReferenceIndex) throw new Error('Durable prior-reference storage is unavailable')
			return api.savePriorReferenceIndex(key, references, timeUs, rev)
		},
		async delete(key, timeUs, rev) {
			if (!api.deletePriorReferenceIndex) throw new Error('Durable prior-reference storage is unavailable')
			return api.deletePriorReferenceIndex(key, timeUs, rev)
		},
		async keys() {
			if (!api.loadPriorReferenceKeys) throw new Error('Durable prior-reference storage is unavailable')
			return api.loadPriorReferenceKeys()
		},
	}
}

function defaultEnqueueWebhookDeliveries(): EnqueueWebhookDeliveries {
	const api = delivery as typeof delivery & { enqueueWebhookDeliveries?: EnqueueWebhookDeliveries }
	return async (entries, event) => {
		if (!api.enqueueWebhookDeliveries) throw new Error('Durable webhook delivery queue is unavailable')
		return api.enqueueWebhookDeliveries(entries, event)
	}
}

function currentDependencies(): RuntimeDependencies {
	if (!dependencies) throw new Error('Firehose was not started')
	return dependencies
}

/** A small mutex for registry-state snapshots versus live WH mutations. */
class AsyncMutex {
	private tail: Promise<void> = Promise.resolve()

	async run<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.tail
		let release: (() => void) | undefined
		this.tail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous.catch(() => undefined)
		try {
			return await operation()
		} finally {
			release?.()
		}
	}
}

const registryStateMutex = new AsyncMutex()

class KeyedSerialExecutor {
	private readonly tails = new Map<string, Promise<void>>()

	constructor(private readonly maxKeys: number) {}

	async run(key: string, task: () => Promise<void>): Promise<void> {
		const previous = this.tails.get(key)
		if (!previous && this.tails.size >= this.maxKeys) throw new Error('Intake record-key limit reached')
		const current = previous ? previous.then(task) : task()
		this.tails.set(key, current)
		try {
			await current
		} finally {
			if (this.tails.get(key) === current) this.tails.delete(key)
		}
	}

	get size(): number {
		return this.tails.size
	}
}

const recordExecutor = new KeyedSerialExecutor(config.intakeRecordKeyMax)

/**
 * Rebuild tracked owner/scope DID sets. Owner DIDs are always subscribed so a
 * webhook owned by A and scoped to B still receives A's future update/delete.
 */
interface TrackedWebhook {
	readonly ownerDid: string
	readonly rkey: string
	readonly scopeDid: string
	readonly backlinks: boolean
	readonly record: WhRecord
}

const trackedWebhooks = new Map<string, TrackedWebhook>()
const scopeWebhookKeys = new Map<string, Set<string>>()
const backlinkWebhookKeys = new Set<string>()
const ownerRefCounts = new Map<string, number>()
const scopeRefCounts = new Map<string, number>()
const backlinkScopeRefCounts = new Map<string, number>()

const DIRECT_SUBSCRIPTION_PARAMETER_BYTES = Buffer.byteLength('&wantedDids=')
const DIRECT_SUBSCRIPTION_CURSOR_RESERVE_BYTES = Buffer.byteLength(`&cursor=${Number.MAX_SAFE_INTEGER}`)
let directSubscriptionUrlBytes = Buffer.byteLength(new URL(config.jetstreamUrl).toString())

function wantedDidBytes(did: string): number {
	return DIRECT_SUBSCRIPTION_PARAMETER_BYTES + Buffer.byteLength(encodeURIComponent(did))
}

function projectedCount(
	counts: ReadonlyMap<string, number>,
	did: string,
	prior: TrackedWebhook | undefined,
	next: TrackedWebhook | undefined,
	field: keyof TrackedWebhook,
): number {
	let value = counts.get(did) ?? 0
	if (prior?.[field] === did) value--
	if (next?.[field] === did) value++
	return value
}

function projectedBooleanCount(
	counts: ReadonlyMap<string, number>,
	did: string,
	prior: TrackedWebhook | undefined,
	next: TrackedWebhook | undefined,
): number {
	let value = counts.get(did) ?? 0
	if (prior?.backlinks && prior.scopeDid === did) value--
	if (next?.backlinks && next.scopeDid === did) value++
	return value
}

function canAdmitTrackedWebhook(key: string, next: TrackedWebhook): boolean {
	const prior = trackedWebhooks.get(key)
	if (!prior && trackedWebhooks.size >= config.registryActiveSubscriptionsMax) return false
	if (!prior && (ownerRefCounts.get(next.ownerDid) ?? 0) >= config.registryOwnerActiveRecordsMax) return false

	const affected = affectedDids(prior, next)
	let projectedScopeDids = scopeDids.size
	let projectedBacklinkScopes = backlinkScopeDids.size
	let projectedDirectDids = directWantedDids.size
	let projectedUrlBytes = directSubscriptionUrlBytes
	for (const did of affected) {
		const oldScope = (scopeRefCounts.get(did) ?? 0) > 0
		const newScope = projectedCount(scopeRefCounts, did, prior, next, 'scopeDid') > 0
		if (!oldScope && newScope) projectedScopeDids++
		if (oldScope && !newScope) projectedScopeDids--

		const oldBacklink = (backlinkScopeRefCounts.get(did) ?? 0) > 0
		const newBacklink = projectedBooleanCount(backlinkScopeRefCounts, did, prior, next) > 0
		if (!oldBacklink && newBacklink) projectedBacklinkScopes++
		if (oldBacklink && !newBacklink) projectedBacklinkScopes--

		const oldDirect = directWantedDids.has(did)
		const newDirect =
			projectedCount(ownerRefCounts, did, prior, next, 'ownerDid') +
				projectedCount(scopeRefCounts, did, prior, next, 'scopeDid') >
			0
		if (!oldDirect && newDirect) {
			projectedDirectDids++
			projectedUrlBytes += wantedDidBytes(did)
		}
		if (oldDirect && !newDirect) {
			projectedDirectDids--
			projectedUrlBytes -= wantedDidBytes(did)
		}
	}
	return (
		projectedScopeDids <= config.registryDirectScopeDidsMax &&
		projectedBacklinkScopes <= config.registryBacklinkScopeDidsMax &&
		projectedDirectDids <= config.registryDirectScopeDidsMax &&
		projectedUrlBytes + DIRECT_SUBSCRIPTION_CURSOR_RESERVE_BYTES <= config.registrySubscriptionUrlBytesMax
	)
}

function canAdmitSubscription(ownerDid: string, rkey: string, record: WhRecord): boolean {
	const next = trackedWebhook(ownerDid, rkey, record)
	return next !== undefined && canAdmitTrackedWebhook(`${ownerDid}/${rkey}`, next)
}

function adjustCount(counts: Map<string, number>, values: Set<string>, value: string, delta: 1 | -1): void {
	const next = (counts.get(value) ?? 0) + delta
	if (next <= 0) {
		counts.delete(value)
		values.delete(value)
	} else {
		counts.set(value, next)
		values.add(value)
	}
}

function refreshDirectDid(did: string): void {
	const wasTracked = directWantedDids.has(did)
	const shouldTrack = (ownerRefCounts.get(did) ?? 0) + (scopeRefCounts.get(did) ?? 0) > 0
	if (!wasTracked && shouldTrack) {
		directWantedDids.add(did)
		directSubscriptionUrlBytes += wantedDidBytes(did)
	} else if (wasTracked && !shouldTrack) {
		directWantedDids.delete(did)
		directSubscriptionUrlBytes -= wantedDidBytes(did)
	}
}

function trackedWebhook(ownerDid: string, rkey: string, record: unknown): TrackedWebhook | undefined {
	if (!isDid(ownerDid)) {
		invalidRegistryRecords++
		return undefined
	}
	const validated = validateWebhookRecord(record)
	if (!validated) {
		invalidRegistryRecords++
		return undefined
	}
	// Disabled records remain durable state/history, but have no active scope or
	// delivery effect and therefore consume no admission/index capacity.
	if (validated.enabled === false) return undefined
	const scope = parseAtUri(validated.scope.aturi)
	if (!scope) return undefined
	return { ownerDid, rkey, scopeDid: scope.did, backlinks: validated.scope.backlinks === true, record: validated }
}

function addTrackedWebhook(key: string, entry: TrackedWebhook): void {
	trackedWebhooks.set(key, entry)
	let scoped = scopeWebhookKeys.get(entry.scopeDid)
	if (!scoped) {
		scoped = new Set<string>()
		scopeWebhookKeys.set(entry.scopeDid, scoped)
	}
	scoped.add(key)
	if (entry.backlinks) backlinkWebhookKeys.add(key)
	adjustCount(ownerRefCounts, ownerDids, entry.ownerDid, 1)
	adjustCount(scopeRefCounts, scopeDids, entry.scopeDid, 1)
	if (entry.backlinks) adjustCount(backlinkScopeRefCounts, backlinkScopeDids, entry.scopeDid, 1)
	refreshDirectDid(entry.ownerDid)
	refreshDirectDid(entry.scopeDid)
}

function removeTrackedWebhook(key: string): TrackedWebhook | undefined {
	const entry = trackedWebhooks.get(key)
	if (!entry) return undefined
	trackedWebhooks.delete(key)
	const scoped = scopeWebhookKeys.get(entry.scopeDid)
	scoped?.delete(key)
	if (scoped?.size === 0) scopeWebhookKeys.delete(entry.scopeDid)
	if (entry.backlinks) backlinkWebhookKeys.delete(key)
	adjustCount(ownerRefCounts, ownerDids, entry.ownerDid, -1)
	adjustCount(scopeRefCounts, scopeDids, entry.scopeDid, -1)
	if (entry.backlinks) adjustCount(backlinkScopeRefCounts, backlinkScopeDids, entry.scopeDid, -1)
	refreshDirectDid(entry.ownerDid)
	refreshDirectDid(entry.scopeDid)
	return entry
}

function affectedDids(...entries: Array<TrackedWebhook | undefined>): Set<string> {
	const result = new Set<string>()
	for (const entry of entries) {
		if (!entry) continue
		result.add(entry.ownerDid)
		result.add(entry.scopeDid)
	}
	return result
}

function applyTrackedWebhookMutation(
	ownerDid: string,
	rkey: string,
	newRecord: WhRecord | undefined,
	registrationCursorHint?: number,
	schedule = true,
): void {
	const key = `${ownerDid}/${rkey}`
	const prior = trackedWebhooks.get(key)
	const next = newRecord ? trackedWebhook(ownerDid, rkey, newRecord) : undefined
	const affected = affectedDids(prior, next)
	const previousDirect = new Map([...affected].map((did) => [did, directWantedDids.has(did)]))
	const previousBacklinks = new Map([...affected].map((did) => [did, backlinkScopeDids.has(did)]))
	removeTrackedWebhook(key)
	if (next) addTrackedWebhook(key, next)
	let changed = false
	for (const did of affected) {
		if (previousDirect.get(did) !== directWantedDids.has(did)) changed = true
		if (previousBacklinks.get(did) !== backlinkScopeDids.has(did)) changed = true
	}
	if (schedule && changed && firehoseStarted && !stopping) scheduleReconfigure(registrationCursorHint)
}

function sameDidSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false
	for (const did of left) {
		if (!right.has(did)) return false
	}
	return true
}

/** Rebuild the bounded in-memory subscription index from reconciliation-filtered DB rows. */
export function initScopeDids(webhooks: ReadonlyArray<{ did: string; rkey?: string; record: unknown }>): void {
	clearRegistryCache()
	trackedWebhooks.clear()
	scopeWebhookKeys.clear()
	backlinkWebhookKeys.clear()
	ownerRefCounts.clear()
	scopeRefCounts.clear()
	backlinkScopeRefCounts.clear()
	scopeDids = new Set<string>()
	ownerDids = new Set<string>()
	backlinkScopeDids = new Set<string>()
	directWantedDids = new Set<string>()
	directSubscriptionUrlBytes = Buffer.byteLength(new URL(config.jetstreamUrl).toString())
	const ordered = [...webhooks].sort((left, right) =>
		`${left.did}/${left.rkey ?? ''}`.localeCompare(`${right.did}/${right.rkey ?? ''}`),
	)
	for (const webhook of ordered) {
		if (!webhook.rkey || !isDid(webhook.did)) continue
		const entry = trackedWebhook(webhook.did, webhook.rkey, webhook.record)
		if (!entry) continue
		const key = `${webhook.did}/${webhook.rkey}`
		if (!canAdmitTrackedWebhook(key, entry)) {
			rejectedSubscriptionAdmissions++
			continue
		}
		addTrackedWebhook(key, entry)
	}
}

async function findExistingWebhook(ownerDid: string, rkey: string): Promise<WebhookEntry | undefined> {
	// This is a primary-key lookup, not a full registry scan: the global registry
	// consumer must have strictly bounded work for each WH mutation.
	return database.getWebhookRecord(ownerDid, rkey)
}

async function loadTrackableWebhooks(): Promise<database.ActiveWebhookLoadResult> {
	return database.loadActiveWebhooks()
}

function replaceTrackedOwner(
	ownerDid: string,
	rows: readonly { did: string; rkey: string; record: WhRecord }[],
	registrationCursorHint?: number,
): void {
	clearRegistryCache()
	// A reconciliation swap may remove and immediately re-add the same DID. Batch
	// those mutations so a no-op owner refresh cannot churn live subscriptions.
	const priorDirectDids = new Set(directWantedDids)
	const priorBacklinkDids = new Set(backlinkScopeDids)
	const priorKeys = [...trackedWebhooks.entries()]
		.filter(([, entry]) => entry.ownerDid === ownerDid)
		.map(([key]) => key)
		.sort()
	for (const key of priorKeys) {
		const rkey = key.slice(ownerDid.length + 1)
		applyTrackedWebhookMutation(ownerDid, rkey, undefined, undefined, false)
	}
	const ordered = rows
		.filter((row) => row.did === ownerDid)
		.slice()
		.sort((left, right) => left.rkey.localeCompare(right.rkey))
	for (const row of ordered) applyTrackedWebhookMutation(ownerDid, row.rkey, row.record, undefined, false)
	if (
		firehoseStarted &&
		!stopping &&
		(!sameDidSet(priorDirectDids, directWantedDids) || !sameDidSet(priorBacklinkDids, backlinkScopeDids))
	) {
		// Replay from the registry stream's acknowledged boundary. This closes the
		// interval between a PDS snapshot becoming active and its direct stream swap.
		scheduleReconfigure(registrationCursorHint)
	}
}

/** Incremental, bounded owner swap used for reconciliation transitions. */
export function refreshRegistryOwnerFromDatabase(ownerDid: string): Promise<void> {
	return registryStateMutex.run(async () => {
		const snapshot = await database.loadActiveWebhooksForOwner(ownerDid)
		registrySnapshotOverflow ||= snapshot.overflow
		replaceTrackedOwner(ownerDid, snapshot.rows, registryJetstream?.cursor)
	})
}

async function reloadRegistry(
	oldRecord: WhRecord | undefined,
	newRecord: WhRecord | undefined,
	ownerDid: string,
	rkey: string,
	registrationCursorHint?: number,
): Promise<void> {
	const keys = new Set<string>([ownerDid])
	const oldScope = oldRecord ? scopeDid(oldRecord.scope.aturi) : undefined
	const newScope = newRecord ? scopeDid(newRecord.scope.aturi) : undefined
	if (oldScope) keys.add(oldScope)
	if (newScope) keys.add(newScope)
	invalidateMany(keys)
	invalidate(BACKLINK_CACHE_KEY)
	// Apply just this mutation to the in-memory sets. The global registry stream
	// never performs a load-all scan per event.
	applyTrackedWebhookMutation(ownerDid, rkey, newRecord, registrationCursorHint)
}

/**
 * Coalesced reconciliation-transition hook. It clears potentially stale cached
 * candidates and reloads only status-eligible, sanitized records. A force restart
 * replays each stream from its durable cursor; no callback can restart after stop.
 */
export function refreshRegistryFromDatabase(): Promise<void> {
	if (refreshRegistryPromise) return refreshRegistryPromise
	refreshRegistryPromise = registryStateMutex
		.run(async () => {
			// Holding the mutex across this bounded status-filtered snapshot prevents a
			// live WH mutation from being overwritten by an older DB result. The
			// synchronous init swap invalidates caches only once the snapshot arrived.
			const snapshot = await loadTrackableWebhooks()
			registrySnapshotOverflow = snapshot.overflow
			initScopeDids(snapshot.rows)
			if (firehoseStarted && !stopping && !intakePaused) scheduleReconfigure(undefined, true)
		})
		.finally(() => {
			refreshRegistryPromise = null
		})
	return refreshRegistryPromise
}

async function disableInvalidWebhook(
	ownerDid: string,
	rkey: string,
	oldRecord: WhRecord | undefined,
	source: { revision: string; cid?: string; timeUs: number },
): Promise<void> {
	const applied = await database.deleteWebhookRecord(ownerDid, rkey, source)
	if (applied && oldRecord) await reloadRegistry(oldRecord, undefined, ownerDid, rkey, source.timeUs)
}

async function handleWhRecord(
	op: EventKind,
	ownerDid: string,
	rkey: string,
	record: unknown,
	source: { revision: string; cid?: string; timeUs: number },
): Promise<WhMutationResult> {
	const existing = await findExistingWebhook(ownerDid, rkey)
	const oldRecord = existing?.record
	const selfKey = `${ownerDid}/${rkey}`

	if (op === 'delete') {
		// Delete is source-fenced before invalidating caches or acknowledging the cursor.
		const applied = await database.deleteWebhookRecord(ownerDid, rkey, source)
		if (applied && oldRecord) await reloadRegistry(oldRecord, undefined, ownerDid, rkey, source.timeUs)
		return { selfKey }
	}

	const validated = validateWebhookRecord(record)
	if (!validated) {
		invalidRegistryRecords++
		// An invalid update must revoke an older valid endpoint rather than leave it
		// active indefinitely. The malformed record itself is never stored or used.
		await disableInvalidWebhook(ownerDid, rkey, oldRecord, source)
		return { selfKey, ackableInvalid: true }
	}
	try {
		assertSafeWebhookUrlSyntax(validated.url)
	} catch {
		invalidRegistryRecords++
		await disableInvalidWebhook(ownerDid, rkey, oldRecord, source)
		return { selfKey, ackableInvalid: true }
	}

	if (validated.enabled !== false && !canAdmitSubscription(ownerDid, rkey, validated)) {
		rejectedSubscriptionAdmissions++
		// Do not retain an old scope when a valid update cannot be admitted: that
		// would keep delivering to a stale endpoint forever. A new over-cap record
		// is omitted; an existing one is durably revoked before acknowledgement.
		if (oldRecord) await disableInvalidWebhook(ownerDid, rkey, oldRecord, source)
		await database.recordWebhookIntakeQuarantine({
			relay: normalizeRelayIdentity(config.jetstreamUrl),
			timeUs: source.timeUs,
			rev: source.revision,
			did: ownerDid,
			collection: WH_COLLECTION,
			rkey,
			reason: 'invalid_subscription',
		})
		logger.warn('[registry] active subscription admission limit reached; event quarantined')
		return { selfKey, ackableInvalid: true }
	}

	const changed = await database.upsertWebhookRecord(ownerDid, rkey, validated, source)
	if (changed) await reloadRegistry(oldRecord, validated, ownerDid, rkey, source.timeUs)
	return { deliveryRecord: validated, selfKey }
}

async function enqueueMatched(
	event: JetstreamEvent,
	backlinkRecord: unknown,
	deliveryRecord: unknown,
	excludedWebhookKey?: string,
): Promise<void> {
	if (event.kind !== 'commit' || !event.commit) return
	const { did, time_us: timeUs, commit } = event
	const candidates = await getWebhooksForEvent(did, backlinkRecord)
	let matched = matchWebhooks(
		candidates,
		did,
		commit.collection,
		commit.rkey,
		commit.operation,
		deliveryRecord,
		backlinkRecord,
	)
	// A subscription never receives the mutation of its own WH record. Other
	// subscriptions may intentionally watch place.wisp.v2.wh and still receive it.
	if (excludedWebhookKey) {
		matched = matched.filter((entry) => `${entry.ownerDid}/${entry.rkey}` !== excludedWebhookKey)
	}
	if (matched.length === 0) return

	const durableEvent: DurableDeliveryEvent = {
		relay: normalizeRelayIdentity(config.jetstreamUrl),
		timeUs,
		rev: commit.rev,
		operation: commit.operation,
		did,
		collection: commit.collection,
		rkey: commit.rkey,
		...(commit.cid ? { cid: commit.cid } : {}),
		...(deliveryRecord === undefined ? {} : { record: deliveryRecord }),
	}
	try {
		const result = await currentDependencies().enqueueWebhookDeliveries(matched, durableEvent)
		totalMatched += result.enqueued + result.deduplicated
	} catch (error) {
		if (error instanceof delivery.WebhookDeliveryInputError) {
			// Deterministic untrusted payload/subscription input is ackable. Store a
			// bounded redacted identity first; a failure to persist that row remains
			// retryable and deliberately keeps the cursor behind.
			await currentDependencies().recordWebhookIntakeQuarantine({
				relay: normalizeRelayIdentity(config.jetstreamUrl),
				timeUs,
				rev: commit.rev,
				did,
				collection: commit.collection,
				rkey: commit.rkey,
				reason: error.kind,
			})
			invalidDeliveryInputEvents++
			logger.warn('[delivery] invalid durable input; event quarantined')
			return
		}
		throw error
	}
}

interface ReferenceLifecycle {
	readonly key: string
	readonly oldReferences: readonly string[]
	readonly newReferences: readonly string[]
	readonly matchRecord: unknown
	readonly tooComplex: boolean
}

/**
 * The keys that own durable prior references. The backlink consumer reads every
 * record in the network, so without this index each irrelevant event costs a
 * database round trip and intake can never keep pace with the relay.
 *
 * `null` means the index is not trustworthy - never hydrated, hydration was
 * truncated, or it outgrew the durable bound - and every key is then loaded
 * from the database, which is slow but always correct.
 *
 * It mirrors a table this process is the only writer of. A second intake
 * replica would need its own hydration, which startup already performs.
 */
let priorReferenceKeys: Set<string> | null = null

/** Does this key possibly own durable prior state? Unknown answers "yes". */
function mayOwnPriorReferences(key: string): boolean {
	return priorReferenceKeys === null || priorReferenceKeys.has(key)
}

/** What a durable write leaves behind; `undefined` means it changed nothing. */
const PRIOR_STATE_AFTER_WRITE: Record<PriorReferenceWrite, boolean | undefined> = {
	stored: true,
	cleared: false,
	rejected: false,
	stale: undefined,
}

function trackPriorReferences(key: string, owned: boolean): void {
	if (!priorReferenceKeys) return
	if (!owned) {
		priorReferenceKeys.delete(key)
		return
	}
	if (priorReferenceKeys.size >= database.MAX_BACKLINK_REFERENCE_ROWS && !priorReferenceKeys.has(key)) {
		// Past the durable bound the set can no longer mirror the table. Loading
		// every key stays correct, so degrade instead of matching on a lie.
		priorReferenceKeys = null
		logger.warn('[backlink] prior-reference index exceeded its bound; reading durable state for every event')
		return
	}
	priorReferenceKeys.add(key)
}

async function hydratePriorReferenceKeys(): Promise<void> {
	const repository = currentDependencies().referenceRepository
	if (!repository.keys) {
		priorReferenceKeys = null
		return
	}
	try {
		const { keys, complete } = await repository.keys()
		priorReferenceKeys = complete ? new Set(keys) : null
	} catch {
		// Never fail startup over an optimization; fall back to durable reads.
		priorReferenceKeys = null
		logger.warn('[backlink] prior-reference index hydration failed; reading durable state for every event')
	}
}

/** Persist references, skipping the round trip when nothing is or becomes durable. */
async function writePriorReferences(
	key: string,
	references: readonly string[],
	timeUs: number,
	rev: string,
): Promise<void> {
	if (references.length === 0 && !mayOwnPriorReferences(key)) return
	const owned =
		PRIOR_STATE_AFTER_WRITE[await currentDependencies().referenceRepository.save(key, references, timeUs, rev)]
	if (owned !== undefined) trackPriorReferences(key, owned)
}

async function loadReferenceLifecycle(
	event: JetstreamEvent,
	deliveryRecord: unknown,
): Promise<ReferenceLifecycle | undefined> {
	if (event.kind !== 'commit' || !event.commit || backlinkScopeDids.size === 0) return undefined
	const { did, commit } = event
	const key = eventAtUri(did, commit.collection, commit.rkey)
	if (commit.operation !== 'delete' && deliveryRecord === undefined) {
		throw new Error('Non-delete commit has no validated record')
	}
	const current =
		commit.operation === 'delete' ? { references: [], tooComplex: false } : currentReferences(deliveryRecord)
	// Only a key that may own durable state is worth reading it.
	const snapshot = mayOwnPriorReferences(key) ? await currentDependencies().referenceRepository.load(key) : undefined
	const oldReferences = normalizeReferences(snapshot?.references ?? [])
	const combined = [...new Set([...oldReferences, ...current.references])]
	return {
		key,
		oldReferences,
		newReferences: current.references,
		matchRecord: current.tooComplex ? [] : combined,
		tooComplex: current.tooComplex,
	}
}

async function commitReferenceLifecycle(
	event: JetstreamEvent,
	lifecycle: ReferenceLifecycle | undefined,
): Promise<void> {
	if (!lifecycle || event.kind !== 'commit' || !event.commit) return
	const { time_us: timeUs, commit } = event
	if (lifecycle.tooComplex) {
		// Preserve a monotonic empty tombstone at this event version. A later delete
		// therefore cannot resurrect stale references from an earlier known state.
		await writePriorReferences(lifecycle.key, [], timeUs, commit.rev)
		return
	}
	if (commit.operation === 'delete') {
		// Delete only after all deliveries using the old durable snapshot are enqueued.
		if (!mayOwnPriorReferences(lifecycle.key)) return
		if (await currentDependencies().referenceRepository.delete(lifecycle.key, timeUs, commit.rev)) {
			trackPriorReferences(lifecycle.key, false)
		}
	} else {
		await writePriorReferences(lifecycle.key, lifecycle.newReferences, timeUs, commit.rev)
	}
}

async function clearPriorReferenceState(event: JetstreamEvent): Promise<void> {
	if (event.kind !== 'commit' || !event.commit) return
	await writePriorReferences(
		eventAtUri(event.did, event.commit.collection, event.commit.rkey),
		[],
		event.time_us,
		event.commit.rev,
	)
}

async function processCommit(stream: StreamName, event: JetstreamEvent): Promise<void> {
	if (event.kind !== 'commit' || !event.commit) return
	const { did, commit } = event
	if (commit.operation !== 'create' && commit.operation !== 'update' && commit.operation !== 'delete') return

	const isWebhookRegistration = commit.collection === WH_COLLECTION
	// The dedicated registry stream is the only mutator for WH records. Direct
	// and backlink consumers still acknowledge their duplicate WH copies, while
	// registry delivers the WH event to legitimate non-self subscriptions.
	if (isWebhookRegistration && stream !== REGISTRY_STREAM) return
	if (!isWebhookRegistration && stream === REGISTRY_STREAM) return

	// The backlink consumer sees the full relay. Directly subscribed owners/scopes
	// are handled by the direct stream so identical events do not race each other.
	if (stream === BACKLINK_STREAM && directWantedDids.has(did)) return
	if (stream === BACKLINK_STREAM && backlinkScopeDids.size === 0) return

	let deliveryRecord = commit.record
	let selfKey: string | undefined
	let ackableInvalid = false
	if (isWebhookRegistration) {
		const mutation = await registryStateMutex.run(() =>
			handleWhRecord(commit.operation, did, commit.rkey, commit.record, {
				revision: commit.rev,
				timeUs: event.time_us,
				...(commit.cid ? { cid: commit.cid } : {}),
			}),
		)
		deliveryRecord = mutation.deliveryRecord
		selfKey = mutation.selfKey
		ackableInvalid = mutation.ackableInvalid === true
	}
	if (ackableInvalid) {
		await clearPriorReferenceState(event)
		totalEvents++
		return
	}

	const lifecycle = await loadReferenceLifecycle(event, deliveryRecord)
	if (lifecycle?.tooComplex) {
		tooComplexBacklinkEvents++
		logger.warn('[backlink] record references too complex; backlink matching skipped')
		// Passing an empty backlink snapshot preserves direct matching while ensuring
		// no truncated backlink result is ever partially delivered or indexed.
		await enqueueMatched(event, [], deliveryRecord, selfKey)
		await commitReferenceLifecycle(event, lifecycle)
		totalEvents++
		return
	}
	// A full-backlink relay event with neither prior nor current relevant reference
	// cannot match any backlink subscription. Direct candidates still matter only
	// when this event came from a direct subscription, which was handled above.
	if (
		stream === BACKLINK_STREAM &&
		lifecycle &&
		lifecycle.oldReferences.length === 0 &&
		lifecycle.newReferences.length === 0
	) {
		await commitReferenceLifecycle(event, lifecycle)
		return
	}

	await enqueueMatched(event, lifecycle?.matchRecord ?? deliveryRecord, deliveryRecord, selfKey)
	await commitReferenceLifecycle(event, lifecycle)
	totalEvents++
}

async function handleStreamEvent(stream: StreamName, event: JetstreamEvent): Promise<void> {
	lastEventTime = Date.now()
	if (event.kind !== 'commit' || !event.commit) return
	const key = `${event.did}/${event.commit.collection}/${event.commit.rkey}`
	try {
		await recordExecutor.run(key, () => processCommit(stream, event))
	} catch {
		safeError(stream)
		throw new Error('Intake event processing failed')
	}
}

async function persistCursor(stream: StreamName, event: JetstreamEvent): Promise<void> {
	const relay = normalizeRelayIdentity(config.jetstreamUrl)
	const previous = cursorWriteTails.get(stream) ?? Promise.resolve()
	const current = previous
		.catch(() => undefined)
		.then(() => currentDependencies().cursorRepository.save(stream, event.time_us, relay))
	cursorWriteTails.set(stream, current)
	try {
		await current
	} finally {
		if (cursorWriteTails.get(stream) === current) cursorWriteTails.delete(stream)
	}
}

function createClient(
	stream: StreamName,
	cursor: number | undefined,
	wantedDids?: readonly string[],
	wantedCollections?: readonly string[],
): JetstreamClient {
	const client = currentDependencies().createJetstreamClient({
		url: config.jetstreamUrl,
		...(wantedDids ? { wantedDids } : {}),
		...(wantedCollections ? { wantedCollections } : {}),
		cursor,
		maxQueue: config.intakeQueueMax,
		concurrency: config.intakeConcurrency,
		maxEventBytes: config.intakeEventMaxBytes,
		reconnectMinMs: config.jetstreamReconnectMinMs,
		reconnectMaxMs: config.jetstreamReconnectMaxMs,
		reconnectMaxExponent: config.jetstreamReconnectMaxExponent,
		onEvent: (event) => handleStreamEvent(stream, event),
		onAcknowledged: (event) => persistCursor(stream, event),
		onConnect: () => logger.info(`[${stream}] Jetstream connected`),
		onDisconnect: () => logger.warn(`[${stream}] Jetstream disconnected`),
		onError: () => safeError(stream),
	})
	if (intakePaused) client.pause()
	allClients.add(client)
	return client
}

function safelyRewoundCursor(cursor: number | undefined): number | undefined {
	if (cursor === undefined || !Number.isSafeInteger(cursor) || cursor < 0) return undefined
	return Math.max(0, cursor - CURSOR_SAFETY_REWIND_US)
}

function earliestCursor(...cursors: Array<number | undefined>): number | undefined {
	let earliest: number | undefined
	for (const cursor of cursors) {
		if (cursor === undefined) continue
		earliest = earliest === undefined ? cursor : Math.min(earliest, cursor)
	}
	return earliest
}

async function streamCursor(
	stream: StreamName,
	initialCursor?: number,
	registrationHint?: number,
): Promise<number | undefined> {
	const durable =
		initialCursor ??
		(await currentDependencies().cursorRepository.load(stream, normalizeRelayIdentity(config.jetstreamUrl)))
	return earliestCursor(durable, safelyRewoundCursor(registrationHint))
}

interface StreamPlan {
	readonly cursor: number | undefined
	readonly wantedDids?: readonly string[]
	readonly wantedCollections?: readonly string[]
}

function assertPlanUrl(plan: StreamPlan): void {
	buildJetstreamSubscriptionUrl(
		{
			url: config.jetstreamUrl,
			...(plan.wantedDids ? { wantedDids: plan.wantedDids } : {}),
			...(plan.wantedCollections ? { wantedCollections: plan.wantedCollections } : {}),
		},
		plan.cursor,
	)
}

async function planRegistry(initialCursor?: number): Promise<StreamPlan> {
	const durable =
		initialCursor ??
		(await currentDependencies().cursorRepository.load(REGISTRY_STREAM, normalizeRelayIdentity(config.jetstreamUrl)))
	// A fresh registry cursor begins at zero. Jetstream clamps it to retained
	// history, avoiding any correctness decision based on local wall-clock skew.
	const plan: StreamPlan = { cursor: durable ?? 0, wantedCollections: [WH_COLLECTION] }
	assertPlanUrl(plan)
	return plan
}

async function planDirect(initialCursor?: number, registrationHint?: number): Promise<StreamPlan | undefined> {
	if (directWantedDids.size === 0) return undefined
	const plan: StreamPlan = {
		cursor: await streamCursor(DIRECT_STREAM, initialCursor, registrationHint),
		wantedDids: sortedDids(directWantedDids),
	}
	assertPlanUrl(plan)
	return plan
}

async function planBacklink(initialCursor?: number, registrationHint?: number): Promise<StreamPlan | undefined> {
	if (backlinkScopeDids.size === 0) return undefined
	const plan: StreamPlan = { cursor: await streamCursor(BACKLINK_STREAM, initialCursor, registrationHint) }
	assertPlanUrl(plan)
	return plan
}

function startPlanned(stream: StreamName, plan: StreamPlan): JetstreamClient {
	const client = createClient(stream, plan.cursor, plan.wantedDids, plan.wantedCollections)
	client.start()
	return client
}

async function startRegistry(initialCursor?: number): Promise<void> {
	if (!firehoseStarted || stopping || registryJetstream) return
	registryJetstream = startPlanned(REGISTRY_STREAM, await planRegistry(initialCursor))
}

async function startDirect(initialCursor?: number, registrationHint?: number): Promise<void> {
	if (!firehoseStarted || stopping || directJetstream) return
	const plan = await planDirect(initialCursor, registrationHint)
	if (plan) directJetstream = startPlanned(DIRECT_STREAM, plan)
}

async function startBacklink(initialCursor?: number, registrationHint?: number): Promise<void> {
	if (!firehoseStarted || stopping || backlinkJetstream) return
	const plan = await planBacklink(initialCursor, registrationHint)
	if (plan) backlinkJetstream = startPlanned(BACKLINK_STREAM, plan)
}

async function retireClient(client: JetstreamClient): Promise<void> {
	client.stopAccepting()
	await client.drain()
	client.destroy()
	allClients.delete(client)
}

function scheduleReconfigure(registrationCursorHint?: number, force = false): void {
	const rewound = safelyRewoundCursor(registrationCursorHint)
	if (rewound !== undefined) {
		directRestartCursorHint = earliestCursor(directRestartCursorHint, rewound)
		backlinkRestartCursorHint = earliestCursor(backlinkRestartCursorHint, rewound)
	}
	if (force) forceStreamRestart = true
	if (reconfigureScheduled || stopping || !firehoseStarted) return
	reconfigureScheduled = true
	queueMicrotask(() => {
		reconfigureScheduled = false
		if (stopping || !firehoseStarted) return
		if (!reconfiguring) {
			reconfiguring = reconfigure()
				.catch(() => {
					// Plans are validated before retiring active clients. Keep the old
					// subscription alive and avoid exposing configuration details.
					logger.warn('[registry] subscription reconfiguration was rejected')
				})
				.finally(() => {
					reconfiguring = null
					// Hints arriving while a prior reconfiguration drained are serviced
					// afterwards, still from durable/rewound cursors.
					if (
						firehoseStarted &&
						!stopping &&
						(directRestartCursorHint !== undefined || backlinkRestartCursorHint !== undefined || forceStreamRestart)
					) {
						scheduleReconfigure()
					}
				})
		}
	})
}

async function reconfigure(): Promise<void> {
	if (!firehoseStarted || stopping) return
	const force = forceStreamRestart
	forceStreamRestart = false
	const directHint = directRestartCursorHint
	const backlinkHint = backlinkRestartCursorHint
	directRestartCursorHint = undefined
	backlinkRestartCursorHint = undefined

	// Validate/load every replacement before touching an active subscription. A
	// config/admission error leaves the old direct stream serving safely.
	const nextRegistry = force && registryJetstream ? await planRegistry() : undefined
	const nextDirect = await planDirect(undefined, directHint)
	const nextBacklink =
		backlinkScopeDids.size > 0 && (force || !backlinkJetstream)
			? await planBacklink(undefined, backlinkHint)
			: undefined

	if (force && registryJetstream) {
		const oldRegistry = registryJetstream
		registryJetstream = null
		await retireClient(oldRegistry)
		if (!stopping && nextRegistry) registryJetstream = startPlanned(REGISTRY_STREAM, nextRegistry)
	}

	const oldDirect = directJetstream
	if (oldDirect) {
		directJetstream = null
		await retireClient(oldDirect)
	}
	if (!stopping && nextDirect) directJetstream = startPlanned(DIRECT_STREAM, nextDirect)

	if (backlinkScopeDids.size === 0) {
		const oldBacklink = backlinkJetstream
		backlinkJetstream = null
		if (oldBacklink) await retireClient(oldBacklink)
	} else if (force && backlinkJetstream) {
		const oldBacklink = backlinkJetstream
		backlinkJetstream = null
		await retireClient(oldBacklink)
		if (!stopping && nextBacklink) backlinkJetstream = startPlanned(BACKLINK_STREAM, nextBacklink)
	} else if (!backlinkJetstream && !stopping && nextBacklink) {
		backlinkJetstream = startPlanned(BACKLINK_STREAM, nextBacklink)
	}
}

export async function startFirehose(options: FirehoseStartOptions = {}): Promise<void> {
	if (firehoseStarted) return
	stopping = false
	intakePaused = options.paused === true
	dependencies = {
		cursorRepository: options.cursorRepository ?? defaultCursorRepository(),
		referenceRepository: options.referenceRepository ?? defaultReferenceRepository(),
		enqueueWebhookDeliveries: options.enqueueWebhookDeliveries ?? defaultEnqueueWebhookDeliveries(),
		recordWebhookIntakeQuarantine: options.recordWebhookIntakeQuarantine ?? database.recordWebhookIntakeQuarantine,
		createJetstreamClient: options.createJetstreamClient ?? ((clientOptions) => new JetstreamClient(clientOptions)),
	}
	firehoseStarted = true
	try {
		await hydratePriorReferenceKeys()
		await startRegistry(options.cursors?.[REGISTRY_STREAM])
		await startDirect(options.cursors?.[DIRECT_STREAM])
		await startBacklink(options.cursors?.[BACKLINK_STREAM])
	} catch (error) {
		firehoseStarted = false
		stopping = true
		for (const client of allClients) client.destroy()
		allClients.clear()
		directJetstream = null
		backlinkJetstream = null
		registryJetstream = null
		throw error
	}
}

/** Stop accepting new socket messages. Call drainFirehose before closing the DB. */
export function stopFirehose(): void {
	if (!firehoseStarted && stopping) return
	firehoseStarted = false
	stopping = true
	intakePaused = false
	reconfigureScheduled = false
	for (const client of allClients) client.stopAccepting()
}

export async function drainFirehose(timeoutMs = config.shutdownTimeoutMs): Promise<boolean> {
	const clients = [...allClients]
	// A subscription reconfiguration can be awaiting a cursor query or retiring
	// a previous client while shutdown begins. It is intake work too: do not let
	// callers close DB/Redis until it settles or this bounded drain expires.
	const pendingReconfigure = reconfiguring
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const completed = await Promise.race([
			Promise.all([
				...clients.map((client) => client.drain()),
				...(pendingReconfigure ? [pendingReconfigure] : []),
			]).then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs)
			}),
		])
		return completed
	} finally {
		if (timer) clearTimeout(timer)
		for (const client of clients) {
			client.destroy()
			allClients.delete(client)
		}
		directJetstream = null
		backlinkJetstream = null
		registryJetstream = null
		dependencies = null
	}
}

export function getFirehoseHealth() {
	const directRequired = directWantedDids.size > 0
	const backlinkRequired = backlinkScopeDids.size > 0
	const directConnected = !directRequired || directJetstream?.isConnected === true
	const backlinkConnected = !backlinkRequired || backlinkJetstream?.isConnected === true
	const registryConnected = registryJetstream?.isConnected === true
	const connected = registryConnected && directConnected && backlinkConnected
	// Readiness follows durable progress, not socket state. A stream draining its
	// bounded queue after backpressure is serving; one that acknowledges nothing
	// is not. Both are reported so the socket view stays visible.
	const directProgressing = !directRequired || directJetstream?.isProgressing === true
	const backlinkProgressing = !backlinkRequired || backlinkJetstream?.isProgressing === true
	const registryProgressing = registryJetstream?.isProgressing === true
	return {
		connected,
		directConnected,
		backlinkConnected,
		registryConnected,
		directProgressing,
		backlinkProgressing,
		registryProgressing,
		started: firehoseStarted,
		paused: intakePaused,
		queued: (directJetstream?.queued ?? 0) + (backlinkJetstream?.queued ?? 0) + (registryJetstream?.queued ?? 0),
		activeRecordKeys: recordExecutor.size,
		tooComplexBacklinkEvents,
		invalidRegistryRecords,
		invalidDeliveryInputEvents,
		rejectedSubscriptionAdmissions,
		registrySnapshotOverflow,
		admissionLimits: {
			activeSubscriptions: config.registryActiveSubscriptionsMax,
			wantedDids: config.registryDirectScopeDidsMax,
			subscriptionUrlBytes: config.registrySubscriptionUrlBytesMax,
		},
		lastEventTime: lastEventTime || undefined,
		timeSinceLastEvent: lastEventTime ? Date.now() - lastEventTime : undefined,
		streamFailures: {
			direct: {
				quarantined: directJetstream?.isQuarantined ?? false,
				protocolFailures: directJetstream?.protocolFailureCount ?? 0,
				failureKind: directJetstream?.failureKind,
				lastProgressAt: directJetstream?.lastProgressTime,
			},
			backlink: {
				quarantined: backlinkJetstream?.isQuarantined ?? false,
				protocolFailures: backlinkJetstream?.protocolFailureCount ?? 0,
				failureKind: backlinkJetstream?.failureKind,
				lastProgressAt: backlinkJetstream?.lastProgressTime,
			},
			registry: {
				quarantined: registryJetstream?.isQuarantined ?? false,
				protocolFailures: registryJetstream?.protocolFailureCount ?? 0,
				failureKind: registryJetstream?.failureKind,
				lastProgressAt: registryJetstream?.lastProgressTime,
			},
		},
		healthy:
			firehoseStarted && registryProgressing && directProgressing && backlinkProgressing && !registrySnapshotOverflow,
	}
}

export function getEventStats() {
	return {
		events: totalEvents,
		matched: totalMatched,
		tooComplexBacklinkEvents,
		invalidRegistryRecords,
		invalidDeliveryInputEvents,
		rejectedSubscriptionAdmissions,
	}
}

/** Test-only reset after a fully stopped client set. */
export function resetFirehoseForTests(): void {
	stopFirehose()
	for (const client of allClients) client.destroy()
	allClients.clear()
	directJetstream = null
	backlinkJetstream = null
	registryJetstream = null
	dependencies = null
	priorReferenceKeys = null
	stopping = false
	intakePaused = false
	lastEventTime = 0
	totalEvents = 0
	totalMatched = 0
	tooComplexBacklinkEvents = 0
	invalidRegistryRecords = 0
	invalidDeliveryInputEvents = 0
	rejectedSubscriptionAdmissions = 0
	registrySnapshotOverflow = false
	trackedWebhooks.clear()
	scopeWebhookKeys.clear()
	backlinkWebhookKeys.clear()
	ownerRefCounts.clear()
	scopeRefCounts.clear()
	backlinkScopeRefCounts.clear()
	scopeDids = new Set<string>()
	ownerDids = new Set<string>()
	backlinkScopeDids = new Set<string>()
	directWantedDids = new Set<string>()
	directSubscriptionUrlBytes = Buffer.byteLength(new URL(config.jetstreamUrl).toString())
	clearRegistryCache()
	cursorWriteTails.clear()
}
