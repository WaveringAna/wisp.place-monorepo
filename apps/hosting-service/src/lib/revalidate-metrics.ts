type EnqueueResult = 'enqueued' | 'deduped' | 'quarantined' | 'disabled' | 'error'

interface RevalidateMetrics {
	storageMissExpected: number
	revalidateEnqueued: number
	revalidateDeduped: number
	revalidateQuarantined: number
	revalidateDisabled: number
	revalidateErrors: number
	lastStorageMissAt: number | null
	lastStorageMissPath: string | null
}

const metrics: RevalidateMetrics = {
	storageMissExpected: 0,
	revalidateEnqueued: 0,
	revalidateDeduped: 0,
	revalidateQuarantined: 0,
	revalidateDisabled: 0,
	revalidateErrors: 0,
	lastStorageMissAt: null,
	lastStorageMissPath: null,
}

export function recordStorageMiss(path: string): void {
	metrics.storageMissExpected += 1
	metrics.lastStorageMissAt = Date.now()
	metrics.lastStorageMissPath = path
}

export function recordRevalidateResult(result: EnqueueResult): void {
	if (result === 'enqueued') {
		metrics.revalidateEnqueued += 1
		return
	}
	if (result === 'deduped') {
		metrics.revalidateDeduped += 1
		return
	}
	if (result === 'quarantined') {
		metrics.revalidateQuarantined += 1
		return
	}
	if (result === 'disabled') {
		metrics.revalidateDisabled += 1
		return
	}
	if (result === 'error') {
		metrics.revalidateErrors += 1
	}
}

export function getRevalidateMetrics(): RevalidateMetrics {
	return { ...metrics }
}
