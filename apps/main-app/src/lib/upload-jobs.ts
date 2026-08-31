import { createLogger } from '@wispplace/observability'

const logger = createLogger('main-app')

export const MAX_UPLOAD_JOBS = 256
// Retained multipart bodies are governed by the weighted request lease; keep
// the task count small as a second line of defense.
export const MAX_ACTIVE_UPLOAD_JOBS = 2
export const MAX_ACTIVE_UPLOAD_JOBS_PER_DID = 1
export const MAX_UPLOAD_JOB_LISTENERS_PER_JOB = 4
export const MAX_UPLOAD_JOB_LISTENERS_PER_DID = 8
export const MAX_UPLOAD_JOB_LISTENERS_TOTAL = 128
export const UPLOAD_JOB_TTL = 60 * 60 * 1000
const UPLOAD_JOB_CLEANUP_INTERVAL = 60 * 1000

export type UploadJobStatus = 'pending' | 'processing' | 'uploading' | 'completed' | 'failed'

export interface UploadProgress {
	filesProcessed: number
	totalFiles: number
	filesUploaded: number
	filesReused: number
	currentFile?: string
	currentFileStatus?: 'checking' | 'uploading' | 'uploaded' | 'reused' | 'failed'
	phase: 'validating' | 'compressing' | 'uploading' | 'creating_manifest' | 'finalizing' | 'done'
}

export interface UploadJob {
	id: string
	did: string
	siteName: string
	status: UploadJobStatus
	progress: UploadProgress
	result?: {
		success: boolean
		uri?: string
		cid?: string
		fileCount?: number
		siteName?: string
		skippedFiles?: Array<{ name: string; reason: string }>
		failedFiles?: Array<{ name: string; index: number; error: string; size: number }>
		uploadedCount?: number
		hasFailures?: boolean
	}
	error?: string
	errorStatus?: number
	createdAt: number
	updatedAt: number
}

export class UploadJobCapacityError extends Error {
	constructor() {
		super('Upload capacity reached')
		this.name = 'UploadJobCapacityError'
	}
}

type JobListener = (event: string, data: unknown) => void

const jobs = new Map<string, UploadJob>()
const jobListeners = new Map<string, Set<JobListener>>()
const listenerCountByDid = new Map<string, number>()
let listenerCount = 0
let progressStreamTimerCount = 0
let cleanupTimer: ReturnType<typeof setInterval> | undefined

function isTerminal(status: UploadJobStatus): boolean {
	return status === 'completed' || status === 'failed'
}

function isActive(status: UploadJobStatus): boolean {
	return !isTerminal(status)
}

function removeAllListeners(jobId: string): void {
	const listeners = jobListeners.get(jobId)
	if (!listeners) return

	const did = jobs.get(jobId)?.did
	listenerCount -= listeners.size
	if (did) {
		const next = (listenerCountByDid.get(did) ?? 0) - listeners.size
		if (next > 0) listenerCountByDid.set(did, next)
		else listenerCountByDid.delete(did)
	}
	jobListeners.delete(jobId)
}

function deleteJob(jobId: string): void {
	removeAllListeners(jobId)
	jobs.delete(jobId)
}

export function pruneExpiredUploadJobs(now = Date.now()): void {
	for (const [id, job] of jobs) {
		// Active work owns buffers and may still hold a PDS/cluster lock. Never
		// free its capacity until it completes, fails, or the process restarts.
		if (isTerminal(job.status) && now - job.updatedAt >= UPLOAD_JOB_TTL) deleteJob(id)
	}
}

function ensureCleanupScheduler(): void {
	if (cleanupTimer) return
	cleanupTimer = setInterval(() => pruneExpiredUploadJobs(), UPLOAD_JOB_CLEANUP_INTERVAL)
	cleanupTimer.unref?.()
}

function evictOldestTerminalJob(): boolean {
	let oldest: UploadJob | undefined
	for (const job of jobs.values()) {
		if (isTerminal(job.status) && (!oldest || job.updatedAt < oldest.updatedAt)) oldest = job
	}
	if (!oldest) return false
	deleteJob(oldest.id)
	return true
}

function activeJobCount(did?: string): number {
	let count = 0
	for (const job of jobs.values()) {
		if (isActive(job.status) && (!did || job.did === did)) count++
	}
	return count
}

export function getUploadJobStats(): {
	jobs: number
	activeJobs: number
	listeners: number
	listenersByDid: ReadonlyMap<string, number>
	progressStreamTimers: number
	cleanupScheduled: boolean
} {
	return {
		jobs: jobs.size,
		activeJobs: activeJobCount(),
		listeners: listenerCount,
		listenersByDid: new Map(listenerCountByDid),
		progressStreamTimers: progressStreamTimerCount,
		cleanupScheduled: cleanupTimer !== undefined,
	}
}

export function createUploadJob(did: string, siteName: string, totalFiles: number): string {
	pruneExpiredUploadJobs()
	while (jobs.size >= MAX_UPLOAD_JOBS && evictOldestTerminalJob()) {
		// Make bounded space for a new job without evicting active work.
	}
	if (
		jobs.size >= MAX_UPLOAD_JOBS ||
		activeJobCount() >= MAX_ACTIVE_UPLOAD_JOBS ||
		activeJobCount(did) >= MAX_ACTIVE_UPLOAD_JOBS_PER_DID
	) {
		throw new UploadJobCapacityError()
	}

	const id = crypto.randomUUID()
	const now = Date.now()
	const job: UploadJob = {
		id,
		did,
		siteName,
		status: 'pending',
		progress: {
			filesProcessed: 0,
			totalFiles,
			filesUploaded: 0,
			filesReused: 0,
			phase: 'validating',
		},
		createdAt: now,
		updatedAt: now,
	}

	jobs.set(id, job)
	ensureCleanupScheduler()
	logger.info('Upload job created', { totalFiles })
	return id
}

export function getUploadJob(id: string): UploadJob | undefined {
	return jobs.get(id)
}

/** Remove a job that failed before its background work was admitted. */
export function discardUploadJob(id: string): void {
	deleteJob(id)
}

function notifyProgress(job: UploadJob): void {
	const listeners = jobListeners.get(job.id)
	if (!listeners?.size) return
	const eventData = {
		status: job.status,
		progress: job.progress,
		result: job.result,
		error: job.error,
		errorStatus: job.errorStatus,
	}
	for (const listener of [...listeners]) {
		try {
			listener('progress', eventData)
		} catch {
			removeJobListener(job.id, listener)
		}
	}
}

export function updateUploadJob(
	id: string,
	updates: Partial<Omit<UploadJob, 'id' | 'did' | 'siteName' | 'createdAt'>>,
): void {
	const job = jobs.get(id)
	if (!job) return

	Object.assign(job, updates, { updatedAt: Date.now() })
	notifyProgress(job)
}

function notifyTerminal(jobId: string, event: 'done' | 'error', data: unknown): void {
	const listeners = jobListeners.get(jobId)
	if (!listeners?.size) return
	for (const listener of [...listeners]) {
		try {
			listener(event, data)
		} catch {
			// Removal below is unconditional and also handles disconnected clients.
		}
	}
	removeAllListeners(jobId)
}

export function completeUploadJob(id: string, result: UploadJob['result']): void {
	const job = getUploadJob(id)
	if (!job || isTerminal(job.status)) return

	updateUploadJob(id, {
		status: 'completed',
		progress: {
			...job.progress,
			phase: 'done',
		},
		result,
	})
	notifyTerminal(id, 'done', result)
}

export function failUploadJob(id: string, error: string, errorStatus = 500): void {
	const job = getUploadJob(id)
	if (!job || isTerminal(job.status)) return
	updateUploadJob(id, { status: 'failed', error, errorStatus })
	notifyTerminal(id, 'error', { error, status: errorStatus })
}

function removeJobListener(jobId: string, listener: JobListener): void {
	const listeners = jobListeners.get(jobId)
	if (!listeners?.delete(listener)) return

	listenerCount--
	const did = jobs.get(jobId)?.did
	if (did) {
		const next = (listenerCountByDid.get(did) ?? 0) - 1
		if (next > 0) listenerCountByDid.set(did, next)
		else listenerCountByDid.delete(did)
	}
	if (listeners.size === 0) jobListeners.delete(jobId)
}

/**
 * Registers an SSE listener only while the job is live and all bounded listener
 * budgets have room. The returned cleanup is idempotent. Undefined means the
 * caller must close the stream instead of retaining another listener.
 */
export function addJobListener(jobId: string, listener: JobListener): (() => void) | undefined {
	const job = jobs.get(jobId)
	if (!job || isTerminal(job.status)) return undefined

	const listeners = jobListeners.get(jobId) ?? new Set<JobListener>()
	if (
		listeners.size >= MAX_UPLOAD_JOB_LISTENERS_PER_JOB ||
		listenerCount >= MAX_UPLOAD_JOB_LISTENERS_TOTAL ||
		(listenerCountByDid.get(job.did) ?? 0) >= MAX_UPLOAD_JOB_LISTENERS_PER_DID
	) {
		return undefined
	}

	listeners.add(listener)
	jobListeners.set(jobId, listeners)
	listenerCount++
	listenerCountByDid.set(job.did, (listenerCountByDid.get(job.did) ?? 0) + 1)

	let removed = false
	return () => {
		if (removed) return
		removed = true
		removeJobListener(jobId, listener)
	}
}

export function updateJobProgress(jobId: string, progressUpdate: Partial<UploadProgress>): void {
	const job = getUploadJob(jobId)
	if (!job || isTerminal(job.status)) return

	updateUploadJob(jobId, {
		progress: {
			...job.progress,
			...progressUpdate,
		},
	})
}

function progressEventPayload(job: UploadJob): Record<string, unknown> {
	return {
		status: job.status,
		progress: job.progress,
		result: job.result,
		error: job.error,
		errorStatus: job.errorStatus,
	}
}

/**
 * Create a bounded SSE stream for a live upload job. cancel() always removes
 * the listener and keepalive timer; terminal jobs never register listeners.
 */
export function createUploadProgressStream(jobId: string): ReadableStream<Uint8Array> | undefined {
	const job = getUploadJob(jobId)
	if (!job) return undefined

	let controller: ReadableStreamDefaultController<Uint8Array> | undefined
	let removeListener: (() => void) | undefined
	let keepalive: ReturnType<typeof setInterval> | undefined
	let closed = false
	const encoder = new TextEncoder()

	const close = () => {
		if (closed) return
		closed = true
		if (keepalive !== undefined) {
			clearInterval(keepalive)
			progressStreamTimerCount--
		}
		keepalive = undefined
		removeListener?.()
		removeListener = undefined
		try {
			controller?.close()
		} catch {
			// A client may cancel before a terminal event arrives.
		}
	}

	const sendEvent = (event: string, data: unknown) => {
		const activeController = controller
		if (closed || !activeController || activeController.desiredSize === null || activeController.desiredSize <= 0)
			return
		try {
			activeController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
		} catch {
			close()
		}
	}

	return new ReadableStream({
		start(streamController) {
			controller = streamController
			if (isTerminal(job.status)) {
				sendEvent('progress', progressEventPayload(job))
				return close()
			}
			removeListener = addJobListener(jobId, (event, data) => {
				sendEvent(event, data)
				if (event === 'done' || event === 'error') close()
			})
			if (!removeListener) {
				sendEvent('error', { error: 'Upload capacity reached' })
				return close()
			}
			sendEvent('progress', progressEventPayload(job))
			keepalive = setInterval(() => {
				if (closed || streamController.desiredSize === null || streamController.desiredSize <= 0) return
				try {
					streamController.enqueue(encoder.encode(': keepalive\n\n'))
				} catch {
					close()
				}
			}, 15_000)
			progressStreamTimerCount++
			keepalive.unref?.()
		},
		cancel: close,
	})
}
