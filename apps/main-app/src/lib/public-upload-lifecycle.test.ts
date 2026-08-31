import { expect, test } from 'bun:test'
import { MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES } from './public-upload-gate'
import { PublicUploadLifecycle } from './public-upload-lifecycle'
import { RequestBodyAdmission } from './request-body-admission'
import { completeUploadJob, createUploadJob, failUploadJob, getUploadJob, getUploadJobStats } from './upload-jobs'

const did = () => `did:example:shutdown${crypto.randomUUID().replaceAll('-', '')}`
const uploadRequest = (ip: string, bytes = '1') =>
	new Request('http://localhost/wisp/upload-files', {
		method: 'POST',
		headers: { 'content-length': bytes, 'x-forwarded-for': ip },
	})

async function settleTasks(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

test('transfers a parsed body lease through background lifetime and releases it once', async () => {
	const admission = new RequestBodyAdmission()
	const lifecycle = new PublicUploadLifecycle()
	const first = uploadRequest('198.51.100.40', String(MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES))
	const second = uploadRequest('198.51.100.41', '1')
	const jobId = createUploadJob(did(), 'site', 1)
	let finishWork: (() => void) | undefined
	const work = new Promise<void>((resolve) => {
		finishWork = resolve
	})

	expect(admission.admit(first)).toBeUndefined()
	const lease = admission.takeUploadLease(first)
	expect(lease).toBeDefined()
	expect(lifecycle.track(jobId, async () => await work, lease)).toBe(true)
	// Simulates Elysia afterResponse. It must not release the transferred lease.
	admission.release(first)
	expect(lifecycle.stats()).toEqual({ accepting: true, tasks: 1, retainedBodies: 1 })
	expect(admission.admit(second)?.status).toBe(429)

	completeUploadJob(jobId, { success: true })
	finishWork?.()
	await settleTasks()
	expect(lifecycle.stats()).toEqual({ accepting: true, tasks: 0, retainedBodies: 0 })
	expect(admission.admit(second)).toBeUndefined()
	admission.release(second)
	// Both lifecycle finalization and caller cleanup are idempotent.
	lease?.release()
	expect(admission.stats()).toMatchObject({ active: 0, reservedBytes: 0 })
})

test('handler transfer failure releases a detached request lease', () => {
	const admission = new RequestBodyAdmission()
	const first = uploadRequest('198.51.100.50')
	const second = uploadRequest('198.51.100.51')

	expect(admission.admit(first)).toBeUndefined()
	const lease = admission.takeUploadLease(first)
	lease?.release() // Lifecycle refused admission; handler performs this cleanup.
	admission.release(first)
	expect(admission.admit(second)).toBeUndefined()
	admission.release(second)
	expect(admission.stats()).toMatchObject({ active: 0, reservedBytes: 0 })
})

test('stops accepting and releases a lock-waiting body after bounded drain grace', async () => {
	const admission = new RequestBodyAdmission()
	const lifecycle = new PublicUploadLifecycle()
	const first = uploadRequest('198.51.100.60', String(MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES))
	const second = uploadRequest('198.51.100.61', '1')
	const jobId = createUploadJob(did(), 'site', 1)
	let releaseWork: (() => void) | undefined
	const work = new Promise<void>((resolve) => {
		releaseWork = resolve
	})
	let aborted = false

	expect(admission.admit(first)).toBeUndefined()
	const lease = admission.takeUploadLease(first)
	expect(
		lifecycle.track(
			jobId,
			async (signal) => {
				await work
				aborted = signal.aborted
			},
			lease,
		),
	).toBe(true)
	await lifecycle.stopAndDrain(0)

	expect(lifecycle.stats()).toEqual({ accepting: false, tasks: 1, retainedBodies: 0 })
	expect(getUploadJob(jobId)).toMatchObject({ status: 'failed', error: 'Upload failed' })
	expect(getUploadJobStats().listeners).toBe(0)
	expect(admission.admit(second)).toBeUndefined()
	admission.release(second)
	const laterJob = createUploadJob(did(), 'other-site', 1)
	expect(lifecycle.track(laterJob, async () => undefined)).toBe(false)
	failUploadJob(laterJob, 'Upload failed')

	releaseWork?.()
	await settleTasks()
	expect(aborted).toBe(true)
	expect(lifecycle.stats().tasks).toBe(0)
	expect(admission.stats()).toMatchObject({ active: 0, reservedBytes: 0 })
})
