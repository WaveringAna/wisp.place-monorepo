import { createLogger } from '@wispplace/observability'
import type { RetainedUploadLease } from './request-body-admission'
import { failUploadJob } from './upload-jobs'

const logger = createLogger('main-app')
const UPLOAD_SHUTDOWN_MESSAGE = 'Upload failed'

type UploadWork = (signal: AbortSignal) => Promise<void>

interface TrackedUpload {
	jobId: string
	controller: AbortController
	bodyLease?: RetainedUploadLease
	promise: Promise<void>
}

export class PublicUploadLifecycle {
	private accepting = true
	private readonly tasks = new Set<TrackedUpload>()
	private stopPromise: Promise<void> | undefined

	isAccepting(): boolean {
		return this.accepting
	}

	track(jobId: string, work: UploadWork, bodyLease?: RetainedUploadLease): boolean {
		if (!this.accepting) return false
		const controller = new AbortController()
		let tracked: TrackedUpload
		const promise = Promise.resolve()
			.then(async () => await work(controller.signal))
			.catch(() => {
				logger.error('Public upload background task failed', { errorKind: 'upload_background_failed' })
				failUploadJob(jobId, UPLOAD_SHUTDOWN_MESSAGE)
			})
			.finally(() => {
				bodyLease?.release()
				this.tasks.delete(tracked)
			})
		tracked = { jobId, controller, bodyLease, promise }
		this.tasks.add(tracked)
		return true
	}

	async stopAndDrain(graceMs: number): Promise<void> {
		this.stopPromise ??= this.stopAndDrainOnce(graceMs)
		return await this.stopPromise
	}

	stats(): { accepting: boolean; tasks: number; retainedBodies: number } {
		return {
			accepting: this.accepting,
			tasks: this.tasks.size,
			retainedBodies: Array.from(this.tasks).filter((task) => task.bodyLease).length,
		}
	}

	private async stopAndDrainOnce(graceMs: number): Promise<void> {
		this.accepting = false
		const pending = Promise.allSettled(Array.from(this.tasks, (task) => task.promise))
		if (this.tasks.size === 0 || (await settlesWithin(pending, graceMs))) return

		// Abort cooperatively before marking terminal. Pipeline checkpoints prevent
		// a timed-out task from committing a root manifest after shutdown begins.
		for (const task of this.tasks) {
			task.controller.abort()
			failUploadJob(task.jobId, UPLOAD_SHUTDOWN_MESSAGE)
			// The server is no longer accepting work. Release the budget even if a
			// non-cooperative lock/PDS call needs process shutdown to interrupt it.
			task.bodyLease?.release()
			task.bodyLease = undefined
		}
	}
}

function settlesWithin(pending: Promise<unknown>, graceMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), Math.max(0, graceMs))
		timer.unref?.()
		void pending.then(() => {
			clearTimeout(timer)
			resolve(true)
		})
	})
}

export const publicUploadLifecycle = new PublicUploadLifecycle()

export function getPublicUploadLifecycleStats(): { accepting: boolean; tasks: number; retainedBodies: number } {
	return publicUploadLifecycle.stats()
}

export function stopAndDrainPublicUploads(graceMs: number): Promise<void> {
	return publicUploadLifecycle.stopAndDrain(graceMs)
}
