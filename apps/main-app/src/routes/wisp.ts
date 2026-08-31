import { Agent } from '@atproto/api'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { MAX_SITE_SIZE, MAX_SITE_SIZE_SUPPORTER } from '@wispplace/constants'
import { createLogger } from '@wispplace/observability'
import { Elysia } from 'elysia'
import { isSupporter } from '../lib/db'
import {
	commitPublicUploadManifest,
	INVALID_UPLOAD_MESSAGE,
	loadExistingUploadState,
	PublicUploadError,
	processUploadInBackground,
	selectPublicUploadFiles,
	UPLOAD_BUSY_MESSAGE,
	UPLOAD_FAILED_MESSAGE,
	UPLOAD_UNAVAILABLE_MESSAGE,
	validatePublicUploadFiles,
} from '../lib/public-upload'
import { publicUploadLifecycle } from '../lib/public-upload-lifecycle'
import { type RetainedUploadLease, requestBodyAdmission } from '../lib/request-body-admission'
import { withSiteUploadLock } from '../lib/site-upload-lock'
import {
	createUploadJob,
	createUploadProgressStream,
	discardUploadJob,
	failUploadJob,
	getUploadJob,
	UploadJobCapacityError,
} from '../lib/upload-jobs'
import { requireAuth, SESSION_COOKIE_NAME } from '../lib/wisp-auth'

const logger = createLogger('main-app')

export function isValidSiteName(siteName: string): boolean {
	if (!siteName || typeof siteName !== 'string') return false
	if (siteName.length < 1 || siteName.length > 512) return false
	if (siteName === '.' || siteName === '..') return false
	if (siteName.includes('/') || siteName.includes('\\') || siteName.includes('\0')) return false
	return /^[a-zA-Z0-9._~:-]+$/.test(siteName)
}

function earlyWispRequest({ request }: { request: Request }): Response | undefined {
	return requestBodyAdmission.admit(request)
}

function publicUploadError(error: unknown): PublicUploadError {
	return error instanceof PublicUploadError ? error : new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
}

async function maxLogicalUploadBytes(did: string): Promise<number> {
	try {
		return (await isSupporter(did)) ? MAX_SITE_SIZE_SUPPORTER : MAX_SITE_SIZE
	} catch {
		logger.error('Unable to determine public upload quota', { errorKind: 'supporter_lookup_failed' })
		throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
	}
}

async function putEmptySite(agent: Agent, did: string, siteName: string) {
	return await withSiteUploadLock(did, siteName, async () => {
		const existingState = await loadExistingUploadState(agent, did, siteName)
		return await commitPublicUploadManifest(
			agent,
			did,
			siteName,
			{ type: 'directory', entries: [] },
			0,
			undefined,
			undefined,
			existingState.rootCid,
		)
	})
}

function startLockedUpload(
	jobId: string,
	agent: Agent,
	did: string,
	siteName: string,
	files: Awaited<ReturnType<typeof selectPublicUploadFiles>>['files'],
	skippedFiles: Awaited<ReturnType<typeof selectPublicUploadFiles>>['skippedFiles'],
	bodyLease: RetainedUploadLease,
): boolean {
	return publicUploadLifecycle.track(
		jobId,
		async (signal) => {
			try {
				await withSiteUploadLock(did, siteName, async () => {
					await processUploadInBackground(jobId, agent, did, siteName, files, skippedFiles, signal)
				})
			} catch {
				logger.error('Public upload lock acquisition failed', { errorKind: 'site_upload_lock_failed' })
				failUploadJob(jobId, UPLOAD_FAILED_MESSAGE)
			}
		},
		bodyLease,
	)
}

function assertUploadAdmissionOpen(): void {
	if (!publicUploadLifecycle.isAccepting()) {
		throw new PublicUploadError(503, UPLOAD_UNAVAILABLE_MESSAGE)
	}
}

async function startPublicUpload(body: unknown, auth: any, request: Request) {
	assertUploadAdmissionOpen()
	const input = (body ?? {}) as { siteName?: unknown; files?: unknown }
	if (typeof input.siteName !== 'string' || !isValidSiteName(input.siteName)) {
		throw new PublicUploadError(400, INVALID_UPLOAD_MESSAGE)
	}

	const rawFiles = input.files === undefined ? [] : Array.isArray(input.files) ? input.files : [input.files]
	const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
	if (rawFiles.length === 0) return await createEmptySiteResponse(agent, auth.did, input.siteName)

	const validatedFiles = validatePublicUploadFiles(rawFiles, await maxLogicalUploadBytes(auth.did))
	const jobId = reserveUploadJob(auth.did, input.siteName, validatedFiles.length)
	let retainedLease: RetainedUploadLease | undefined
	try {
		const selected = await selectPublicUploadFiles(validatedFiles)
		// This synchronous handoff keeps the weighted preparse reservation alive
		// until PublicUploadLifecycle owns the parsed File[] lifetime.
		retainedLease = requestBodyAdmission.takeUploadLease(request)
		if (!retainedLease) throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
		if (
			!startLockedUpload(jobId, agent, auth.did, input.siteName, selected.files, selected.skippedFiles, retainedLease)
		) {
			throw new PublicUploadError(503, UPLOAD_UNAVAILABLE_MESSAGE)
		}
		retainedLease = undefined // Lifecycle now owns and releases it.
		return uploadStartedResponse(jobId)
	} catch (error) {
		retainedLease?.release()
		discardUploadJob(jobId)
		throw error
	}
}

async function createEmptySiteResponse(
	agent: Agent,
	did: string,
	siteName: string,
): Promise<{
	success: true
	uri: string
	cid: string
	fileCount: 0
	siteName: string
}> {
	const committed = await putEmptySite(agent, did, siteName)
	return { success: true, uri: committed.record.data.uri, cid: committed.record.data.cid, fileCount: 0, siteName }
}

function reserveUploadJob(did: string, siteName: string, fileCount: number): string {
	assertUploadAdmissionOpen()
	try {
		return createUploadJob(did, siteName, fileCount)
	} catch (error) {
		if (error instanceof UploadJobCapacityError) throw new PublicUploadError(429, UPLOAD_BUSY_MESSAGE)
		throw error
	}
}

function uploadStartedResponse(jobId: string): { success: true; jobId: string; message: string } {
	return {
		success: true,
		jobId,
		message: `Upload started. Connect to /wisp/upload-progress/${jobId} for progress updates.`,
	}
}

async function uploadFilesHandler({ body, auth, request, set }: any) {
	try {
		return await startPublicUpload(body, auth, request)
	} catch (error) {
		const response = publicUploadError(error)
		logger.error('Public upload request failed', { errorKind: 'upload_request_failed' })
		set.status = response.status
		return { success: false, error: response.message }
	}
}

async function uploadProgressHandler({ params: { jobId }, auth, set }: any) {
	const job = getUploadJob(jobId)
	if (!job) return progressError(set, 404, 'Job not found')
	if (job.did !== auth.did) return progressError(set, 403, 'Unauthorized')
	const stream = createUploadProgressStream(jobId)
	if (!stream) return progressError(set, 404, 'Job not found')
	set.headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
	return new Response(stream)
}

function progressError(set: { status?: number }, status: number, error: string) {
	set.status = status
	return { error }
}

export const wispRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/wisp',
		cookie: { secrets: cookieSecret, sign: [SESSION_COOKIE_NAME] },
	})
		// Bun's server cap protects chunked requests. Production also requires a
		// declared length so Caddy and Bun can reject oversized multipart bodies
		// before Elysia parses them; proxy body/rate limits remain outer defense.
		.onRequest(earlyWispRequest)
		.onAfterResponse(({ request }) => {
			requestBodyAdmission.release(request)
		})
		.onError(({ request }) => {
			requestBodyAdmission.release(request)
		})
		.derive(async ({ cookie, request }) => ({ auth: await requireAuth(client, cookie, request.headers.get('cookie')) }))
		.get('/upload-progress/:jobId', uploadProgressHandler)
		.post('/upload-files', uploadFilesHandler)
