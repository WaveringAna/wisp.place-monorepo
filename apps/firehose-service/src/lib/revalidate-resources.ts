/**
 * Resource admission shared by one revalidation.
 *
 * The byte budget is deliberately a real admission counter, not a timeout
 * wrapper. Consumers charge each response chunk before it is accepted. When a
 * charge would exceed the budget the budget aborts its signal, which tears
 * down the active HTTP reader/socket.
 */

export interface TransferByteBudgetLike {
	readonly maxBytes: number
	readonly consumedBytes: number
	readonly remainingBytes: number
	consume(bytes: number): void
}

export class TransferBudgetExceededError extends Error {
	readonly code = 'TRANSFER_BUDGET_EXCEEDED' as const

	constructor(
		readonly maxBytes: number,
		readonly consumedBytes: number,
		readonly attemptedBytes: number,
	) {
		super('Revalidation transfer byte budget exceeded')
		this.name = 'TransferBudgetExceededError'
	}
}

export class RevalidationDeadlineError extends Error {
	readonly code = 'REVALIDATION_DEADLINE' as const

	constructor(readonly deadlineAt: number) {
		super('Revalidation wall deadline exceeded')
		this.name = 'RevalidationDeadlineError'
	}
}

/** A synchronous, aborting byte counter. */
export class TransferByteBudget implements TransferByteBudgetLike {
	private consumed = 0
	readonly controller = new AbortController()

	constructor(readonly maxBytes: number) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
			throw new RangeError('Transfer byte budget must be a positive safe integer')
		}
	}

	get signal(): AbortSignal {
		return this.controller.signal
	}

	get consumedBytes(): number {
		return this.consumed
	}

	get remainingBytes(): number {
		return this.maxBytes - this.consumed
	}

	consume(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Transfer byte charge must be non-negative')
		if (bytes > this.maxBytes - this.consumed) {
			const error = new TransferBudgetExceededError(this.maxBytes, this.consumed, bytes)
			if (!this.controller.signal.aborted) this.controller.abort(error)
			throw error
		}
		this.consumed += bytes
	}
}

export interface RevalidationResourceContext {
	readonly signal: AbortSignal
	/** Null for filesystem work, which is bounded per request and by lifecycle rather than wall time. */
	readonly deadlineAt: number | null
	readonly transferBudget: TransferByteBudgetLike
	close(): void
}

/** Counts transfer bytes without treating retries as quota consumption. */
class UnboundedTransferByteBudget implements TransferByteBudgetLike {
	readonly maxBytes = Number.POSITIVE_INFINITY
	private consumed = 0

	get consumedBytes(): number {
		return this.consumed
	}

	get remainingBytes(): number {
		return Number.POSITIVE_INFINITY
	}

	consume(bytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Transfer byte charge must be non-negative')
		this.consumed = Math.min(Number.MAX_SAFE_INTEGER, this.consumed + bytes)
	}
}

function abortReason(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason
	return new Error(signal.reason ? String(signal.reason) : 'Revalidation aborted')
}

/**
 * Create one deadline and one shared transfer budget for a revalidation. The
 * returned close method is idempotent and must be called by the message
 * boundary after all work has stopped.
 */
export function createRevalidationResourceContext(
	deadlineMs: number | null,
	transferBudgetBytes: number | null,
	upstreamSignal?: AbortSignal,
): RevalidationResourceContext {
	if (deadlineMs !== null && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)) {
		throw new RangeError('Revalidation deadline must be null or a positive safe integer')
	}
	if (transferBudgetBytes !== null && (!Number.isSafeInteger(transferBudgetBytes) || transferBudgetBytes < 1)) {
		throw new RangeError('Revalidation transfer budget must be null or a positive safe integer')
	}

	const deadlineAt = deadlineMs === null ? null : Date.now() + deadlineMs
	const controller = new AbortController()
	const boundedBudget = transferBudgetBytes === null ? null : new TransferByteBudget(transferBudgetBytes)
	const budget: TransferByteBudgetLike = boundedBudget ?? new UnboundedTransferByteBudget()
	let closed = false
	const timer =
		deadlineAt === null
			? undefined
			: setTimeout(() => controller.abort(new RevalidationDeadlineError(deadlineAt)), deadlineMs as number)
	const abortFromUpstream = () => controller.abort(abortReason(upstreamSignal as AbortSignal))
	const abortFromBudget = () => controller.abort(abortReason(boundedBudget!.signal))

	if (upstreamSignal) {
		if (upstreamSignal.aborted) abortFromUpstream()
		else upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true })
	}
	boundedBudget?.signal.addEventListener('abort', abortFromBudget, { once: true })

	return {
		signal: controller.signal,
		deadlineAt,
		transferBudget: budget,
		close: () => {
			if (closed) return
			closed = true
			if (timer !== undefined) clearTimeout(timer)
			upstreamSignal?.removeEventListener('abort', abortFromUpstream)
			boundedBudget?.signal.removeEventListener('abort', abortFromBudget)
		},
	}
}

export function assertRevalidationActive(resources?: Pick<RevalidationResourceContext, 'signal'>): void {
	if (resources?.signal.aborted) {
		const reason = resources.signal.reason
		if (reason instanceof Error) throw reason
		throw new Error('Revalidation aborted')
	}
}

/** A real event-loop yield. Promise.resolve() is intentionally not used. */
export function yieldRevalidationMacrotask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}
