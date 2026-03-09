/**
 * Bun-compatible AT Protocol Firehose
 * Uses BunSubscription with the SDK's parsing/validation logic
 */

import type { IdResolver } from '@atproto/identity'
import { type BlockMap, cborToLexRecord, formatDataKey, parseDataKey, readCar, verifyProofs } from '@atproto/repo'
import { AtUri } from '@atproto/syntax'
import type { CID } from 'multiformats/cid'
import { BunSubscription } from './subscription'

// Re-export types from @atproto/sync for compatibility
export interface CommitMeta {
	seq: number
	time: string
	commit: CID
	blocks: BlockMap
	rev: string
	uri: AtUri
	did: string
	collection: string
	rkey: string
}

export interface CommitEvt extends CommitMeta {
	event: 'create' | 'update' | 'delete'
	cid?: CID
	record?: unknown
}

export interface IdentityEvt {
	event: 'identity'
	seq: number
	time: string
	did: string
	handle?: string
}

export interface AccountEvt {
	event: 'account'
	seq: number
	time: string
	did: string
	active: boolean
	status?: string
}

export type Event = CommitEvt | IdentityEvt | AccountEvt

// Lexicon types for subscribeRepos
interface RepoOp {
	action: 'create' | 'update' | 'delete'
	path: string
	cid: CID | null
}

interface Commit {
	$type: string
	seq: number
	rebase: boolean
	tooBig: boolean
	repo: string
	commit: CID
	rev: string
	since: string | null
	blocks: Uint8Array
	ops: RepoOp[]
	blobs: CID[]
	time: string
}

interface Identity {
	$type: string
	seq: number
	did: string
	time: string
	handle?: string
}

interface Account {
	$type: string
	seq: number
	did: string
	time: string
	active: boolean
	status?: string
}

type RepoEvent = Commit | Identity | Account

function isCommit(evt: unknown): evt is Commit {
	return (evt as any)?.$type === 'com.atproto.sync.subscribeRepos#commit'
}

function isIdentity(evt: unknown): evt is Identity {
	return (evt as any)?.$type === 'com.atproto.sync.subscribeRepos#identity'
}

function isAccount(evt: unknown): evt is Account {
	return (evt as any)?.$type === 'com.atproto.sync.subscribeRepos#account'
}

function isValidRepoEvent(value: unknown): RepoEvent | undefined {
	if (!value || typeof value !== 'object') return undefined
	const $type = (value as any).$type
	if (
		$type === 'com.atproto.sync.subscribeRepos#commit' ||
		$type === 'com.atproto.sync.subscribeRepos#identity' ||
		$type === 'com.atproto.sync.subscribeRepos#account'
	) {
		return value as RepoEvent
	}
	return undefined
}

export interface BunFirehoseOptions {
	idResolver: IdResolver
	service: string
	handleEvent: (evt: Event) => Promise<void> | void
	onError: (err: Error) => void
	filterCollections?: string[]
	unauthenticatedCommits?: boolean
	getCursor?: () => number | undefined | Promise<number | undefined>
}

export class BunFirehose {
	private subscription: BunSubscription<RepoEvent> | null = null
	private abortController: AbortController
	private matchCollection: ((col: string) => boolean) | null = null

	constructor(private opts: BunFirehoseOptions) {
		this.abortController = new AbortController()

		if (opts.filterCollections) {
			const exact = new Set<string>()
			const prefixes: string[] = []

			for (const pattern of opts.filterCollections) {
				if (pattern.endsWith('.*')) {
					prefixes.push(pattern.slice(0, -2))
				} else {
					exact.add(pattern)
				}
			}

			this.matchCollection = (col: string): boolean => {
				if (exact.has(col)) return true
				for (const prefix of prefixes) {
					if (col.startsWith(prefix)) return true
				}
				return false
			}
		}
	}

	async start(): Promise<void> {
		this.subscription = new BunSubscription<RepoEvent>({
			service: this.opts.service,
			method: 'com.atproto.sync.subscribeRepos',
			signal: this.abortController.signal,
			validate: isValidRepoEvent,
			getParams: async () => {
				const cursor = await this.opts.getCursor?.()
				return cursor !== undefined ? { cursor } : undefined
			},
			onReconnectError: (err, n) => {
				this.opts.onError(new Error(`Reconnect attempt ${n}: ${err}`))
			},
		})

		try {
			for await (const evt of this.subscription) {
				try {
					const events = await this.parseEvent(evt)
					for (const event of events) {
						try {
							await this.opts.handleEvent(event)
						} catch (err) {
							this.opts.onError(err instanceof Error ? err : new Error(String(err)))
						}
					}
				} catch (err) {
					this.opts.onError(err instanceof Error ? err : new Error(String(err)))
				}
			}
		} catch (err) {
			if ((err as any)?.name !== 'AbortError') {
				this.opts.onError(err instanceof Error ? err : new Error(String(err)))
			}
		}
	}

	private async parseEvent(evt: RepoEvent): Promise<Event[]> {
		if (isCommit(evt)) {
			return this.opts.unauthenticatedCommits
				? await this.parseCommitUnauthenticated(evt)
				: await this.parseCommitAuthenticated(evt)
		} else if (isIdentity(evt)) {
			return [
				{
					event: 'identity',
					seq: evt.seq,
					time: evt.time,
					did: evt.did,
					handle: evt.handle,
				},
			]
		} else if (isAccount(evt)) {
			return [
				{
					event: 'account',
					seq: evt.seq,
					time: evt.time,
					did: evt.did,
					active: evt.active,
					status: evt.status,
				},
			]
		}
		return []
	}

	private filterOps(ops: RepoOp[]): RepoOp[] {
		if (!this.matchCollection) return ops
		return ops.filter((op) => {
			const { collection } = parseDataKey(op.path)
			return this.matchCollection!(collection)
		})
	}

	private async parseCommitAuthenticated(evt: Commit, forceKeyRefresh = false): Promise<CommitEvt[]> {
		const did = evt.repo
		const ops = this.filterOps(evt.ops)
		if (ops.length === 0) return []

		const claims = ops.map((op) => {
			const { collection, rkey } = parseDataKey(op.path)
			return {
				collection,
				rkey,
				cid: op.action === 'delete' ? null : op.cid,
			}
		})

		try {
			const key = await this.opts.idResolver.did.resolveAtprotoKey(did, forceKeyRefresh)
			const verifiedCids: Record<string, CID | null> = {}

			const results = await verifyProofs(evt.blocks, claims, did, key)
			results.verified.forEach((op) => {
				const path = formatDataKey(op.collection, op.rkey)
				verifiedCids[path] = op.cid
			})

			const verifiedOps = ops.filter((op) => {
				if (op.action === 'delete') {
					return verifiedCids[op.path] === null
				}
				return op.cid?.equals(verifiedCids[op.path])
			})

			return this.formatCommitOps(evt, verifiedOps, { skipCidVerification: true })
		} catch (err) {
			// Retry with key refresh on verification error
			if (!forceKeyRefresh && (err as any)?.name === 'RepoVerificationError') {
				return this.parseCommitAuthenticated(evt, true)
			}
			throw err
		}
	}

	private async parseCommitUnauthenticated(evt: Commit): Promise<CommitEvt[]> {
		const ops = this.filterOps(evt.ops)
		return this.formatCommitOps(evt, ops)
	}

	private async formatCommitOps(
		evt: Commit,
		ops: RepoOp[],
		options?: { skipCidVerification: boolean },
	): Promise<CommitEvt[]> {
		const car = await readCar(evt.blocks, options)
		const events: CommitEvt[] = []

		for (const op of ops) {
			const uri = AtUri.make(evt.repo, op.path)

			const meta: CommitMeta = {
				seq: evt.seq,
				time: evt.time,
				commit: evt.commit,
				blocks: car.blocks,
				rev: evt.rev,
				uri,
				did: uri.host,
				collection: uri.collection,
				rkey: uri.rkey,
			}

			if (op.action === 'create' || op.action === 'update') {
				if (!op.cid) continue
				const recordBytes = car.blocks.get(op.cid)
				if (!recordBytes) continue
				const record = cborToLexRecord(recordBytes)
				events.push({
					...meta,
					event: op.action,
					cid: op.cid,
					record,
				})
			}

			if (op.action === 'delete') {
				events.push({
					...meta,
					event: 'delete',
				})
			}
		}

		return events
	}

	destroy(): void {
		this.abortController.abort()
		this.subscription?.close()
	}
}
