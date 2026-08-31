import { describe, expect, test } from 'bun:test'
import {
	addJobListener,
	completeUploadJob,
	createUploadJob,
	createUploadProgressStream,
	failUploadJob,
	getUploadJob,
	getUploadJobStats,
	MAX_ACTIVE_UPLOAD_JOBS,
	MAX_UPLOAD_JOB_LISTENERS_PER_JOB,
	pruneExpiredUploadJobs,
} from './upload-jobs'

const did = (suffix: string) => `did:example:${suffix}${crypto.randomUUID().replaceAll('-', '')}`

describe('upload job lifecycle bounds', () => {
	test('uses one unref cleanup scheduler and cleans cancelled listeners', () => {
		const jobId = createUploadJob(did('listeners'), 'site', 1)
		const cleanup = addJobListener(jobId, () => undefined)
		expect(cleanup).toBeTypeOf('function')
		expect(getUploadJobStats()).toMatchObject({ listeners: 1, cleanupScheduled: true })

		cleanup?.()
		cleanup?.()
		expect(getUploadJobStats().listeners).toBe(0)
		completeUploadJob(jobId, { success: true })
		expect(getUploadJobStats().activeJobs).toBe(0)
	})

	test('cancels many SSE streams without retaining listeners or keepalives', async () => {
		const jobId = createUploadJob(did('streams'), 'site', 1)
		const streams = Array.from({ length: MAX_UPLOAD_JOB_LISTENERS_PER_JOB }, () => createUploadProgressStream(jobId))
		expect(streams.every(Boolean)).toBe(true)
		expect(getUploadJobStats()).toMatchObject({
			listeners: MAX_UPLOAD_JOB_LISTENERS_PER_JOB,
			progressStreamTimers: MAX_UPLOAD_JOB_LISTENERS_PER_JOB,
		})

		await Promise.all(streams.map((stream) => stream?.cancel()))
		expect(getUploadJobStats()).toMatchObject({ listeners: 0, progressStreamTimers: 0 })
		completeUploadJob(jobId, { success: true })
	})

	test('never prunes stale active jobs or frees their global capacity', () => {
		const jobs = Array.from({ length: MAX_ACTIVE_UPLOAD_JOBS }, (_, index) =>
			createUploadJob(did(`hung${index}`), 'site', 1),
		)
		for (const jobId of jobs) getUploadJob(jobId)!.updatedAt = 0
		pruneExpiredUploadJobs(Date.now())
		expect(jobs.every((jobId) => getUploadJob(jobId)?.status === 'pending')).toBe(true)
		expect(() => createUploadJob(did('overflow'), 'site', 1)).toThrow()
		for (const jobId of jobs) failUploadJob(jobId, 'Upload failed')
	})

	test('caps listeners and does not register them for completed jobs', async () => {
		const jobId = createUploadJob(did('cap'), 'site', 1)
		const cleanups = Array.from({ length: MAX_UPLOAD_JOB_LISTENERS_PER_JOB }, () =>
			addJobListener(jobId, () => undefined),
		)
		expect(cleanups.every(Boolean)).toBe(true)
		expect(addJobListener(jobId, () => undefined)).toBeUndefined()

		completeUploadJob(jobId, { success: true })
		expect(getUploadJobStats()).toMatchObject({ listeners: 0, progressStreamTimers: 0 })
		expect(addJobListener(jobId, () => undefined)).toBeUndefined()
		const completedStream = createUploadProgressStream(jobId)
		expect(completedStream).toBeDefined()
		expect(getUploadJobStats()).toMatchObject({ listeners: 0, progressStreamTimers: 0 })
		await completedStream?.cancel()
	})
})
