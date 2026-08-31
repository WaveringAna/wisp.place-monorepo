/**
 * Bounded, cancellation-aware control flow for firehose backfills.
 *
 * Network/storage operations still need to observe the supplied AbortSignal.
 * These helpers guarantee that cancellation admits no new pages or items and
 * that a broken upstream cursor cannot create an infinite scan.
 */

export type HydrantRepoRow = { did?: string }

export type HydrantPageFetcher = (
	cursor: string | undefined,
	limit: number,
	signal: AbortSignal,
) => Promise<HydrantRepoRow[]>

export interface HydrantScanOptions {
	pageSize?: number
	maxPages?: number
	maxDids?: number
	signal: AbortSignal
}

export class BackfillAbortedError extends Error {
	constructor() {
		super('Backfill cancelled')
		this.name = 'BackfillAbortedError'
	}
}

export class HydrantPaginationError extends Error {
	constructor(readonly code: 'INVALID_PAGE' | 'REPEATED_CURSOR' | 'PAGE_LIMIT' | 'DID_LIMIT') {
		super(`Hydrant pagination failed: ${code}`)
		this.name = 'HydrantPaginationError'
	}
}

export function throwIfBackfillAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new BackfillAbortedError()
}

export async function scanHydrantDids(fetchPage: HydrantPageFetcher, options: HydrantScanOptions): Promise<string[]> {
	const pageSize = options.pageSize ?? 1000
	const maxPages = options.maxPages ?? 10_000
	const maxDids = options.maxDids ?? 5_000_000
	if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer')
	if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError('maxPages must be a positive integer')
	if (!Number.isSafeInteger(maxDids) || maxDids < 1) throw new RangeError('maxDids must be a positive integer')

	const dids = new Set<string>()
	let cursor: string | undefined

	for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
		throwIfBackfillAborted(options.signal)
		let rows: HydrantRepoRow[]
		try {
			rows = await fetchPage(cursor, pageSize, options.signal)
		} catch (error) {
			if (options.signal.aborted) throw new BackfillAbortedError()
			throw error
		}
		throwIfBackfillAborted(options.signal)
		if (!Array.isArray(rows)) throw new HydrantPaginationError('INVALID_PAGE')
		if (rows.length === 0) return [...dids]

		for (const row of rows) {
			if (typeof row?.did !== 'string' || row.did.length === 0) continue
			dids.add(row.did)
			if (dids.size > maxDids) throw new HydrantPaginationError('DID_LIMIT')
		}

		const lastDid = rows[rows.length - 1]?.did
		if (!lastDid || rows.length < pageSize) return [...dids]
		if (lastDid === cursor) throw new HydrantPaginationError('REPEATED_CURSOR')
		cursor = lastDid
	}

	throw new HydrantPaginationError('PAGE_LIMIT')
}

/**
 * Run a fixed worker pool. Aborting admits no new items and waits for already
 * admitted work to settle, so shutdown can safely close shared dependencies.
 */
export async function runCancellableWindow<T>(
	items: readonly T[],
	concurrency: number,
	signal: AbortSignal,
	worker: (item: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new RangeError('concurrency must be a positive integer')
	}

	let nextIndex = 0
	const runWorker = async () => {
		while (!signal.aborted) {
			const index = nextIndex
			if (index >= items.length) return
			nextIndex++
			await worker(items[index] as T, signal)
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
	const results = await Promise.allSettled(workers)
	const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
	if (failed) throw failed.reason
}
