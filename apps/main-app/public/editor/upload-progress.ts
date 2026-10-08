import { useEffect, useEffectEvent, useReducer, useState } from 'react'
import { api, errorText } from './api'

export type FileStatus = 'checking' | 'uploading' | 'uploaded' | 'reused' | 'failed'

export interface UploadProgress {
	phase?: string
	filesProcessed?: number
	filesUploaded?: number
	filesReused?: number
	totalFiles?: number
	currentFile?: string
	currentFileStatus?: FileStatus
}

export interface UploadResult {
	/** The manifest record a public upload wrote. */
	uri?: string
	cid?: string
	uploadedCount?: number
	fileCount?: number
	skippedFiles?: { name: string; reason: string }[]
	failedFiles?: { name: string; error: string; size?: number }[]
}

export interface UploadState {
	title: string | null
	status: string
	running: boolean
	/** The last few files the server reported, newest last: a tail, not the whole manifest. */
	recent: { name: string; status: FileStatus }[]
	result: UploadResult | null
	error: string | null
}

export type UploadEvent =
	| { type: 'start'; title: string }
	| { type: 'progress'; progress: UploadProgress }
	| { type: 'done'; result: UploadResult }
	| { type: 'fail'; error: string }

export const RECENT_FILES = 8

export const idleUpload: UploadState = {
	title: null,
	status: '',
	running: false,
	recent: [],
	result: null,
	error: null,
}

export function phaseText(progress: UploadProgress): string {
	const total = progress.totalFiles ?? 0
	switch (progress.phase) {
		case 'validating':
			return 'validating files'
		case 'compressing':
			return `compressing ${progress.filesProcessed ?? 0}/${total}`
		case 'uploading':
			return `uploading to your pds ${(progress.filesUploaded ?? 0) + (progress.filesReused ?? 0)}/${total}`
		case 'creating_manifest':
			return 'writing the manifest'
		case 'finalizing':
			return 'finalizing'
		default:
			return 'working'
	}
}

const withFile = (recent: UploadState['recent'], name: string, status: FileStatus) =>
	[...recent.filter((file) => file.name !== name), { name, status }].slice(-RECENT_FILES)

export function uploadReducer(state: UploadState, event: UploadEvent): UploadState {
	switch (event.type) {
		case 'start':
			return { ...idleUpload, title: event.title, status: 'sending files', running: true }
		case 'progress': {
			const { currentFile, currentFileStatus } = event.progress
			return {
				...state,
				status: phaseText(event.progress),
				recent:
					currentFile && currentFileStatus ? withFile(state.recent, currentFile, currentFileStatus) : state.recent,
			}
		}
		case 'done':
			return { ...state, running: false, result: event.result }
		case 'fail':
			return { ...state, running: false, error: event.error }
	}
}

/** PDS hosts behind small proxies reject big blobs; the server reports it in the file error text. */
export const hitPdsSizeLimit = (result: UploadResult) =>
	(result.failedFiles ?? []).some(({ error }) => /pds is not allowing|request entity too large/i.test(error ?? ''))

const eventData = (event: Event): Record<string, unknown> | null => {
	if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return null
	try {
		return JSON.parse(event.data)
	} catch {
		return null
	}
}

interface UploadRequest {
	title: string
	body: FormData
	isPrivate: boolean
}

/**
 * Sends an upload and follows its server-sent progress stream. The stream is
 * tied to the job id, so it closes on unmount or when another upload starts.
 */
export function useUpload(onFinished: (result: UploadResult) => void) {
	const [state, dispatch] = useReducer(uploadReducer, idleUpload)
	const [jobId, setJobId] = useState<string | null>(null)
	const finishStream = useEffectEvent(onFinished)

	useEffect(() => {
		if (!jobId) return
		const source = new EventSource(`/wisp/upload-progress/${encodeURIComponent(jobId)}`)
		source.addEventListener('progress', (event) =>
			dispatch({ type: 'progress', progress: (eventData(event)?.progress ?? {}) as UploadProgress }),
		)
		source.addEventListener('done', (event) => {
			source.close()
			const result = (eventData(event) ?? {}) as UploadResult
			dispatch({ type: 'done', result })
			finishStream(result)
		})
		// Fires both for an `error` event from the server and for a dropped connection.
		source.addEventListener('error', (event) => {
			source.close()
			const message = eventData(event)?.error
			dispatch({
				type: 'fail',
				error: typeof message === 'string' ? message : 'lost the progress stream, the upload may still finish',
			})
		})
		return () => source.close()
	}, [jobId])

	const start = async ({ title, body, isPrivate }: UploadRequest) => {
		dispatch({ type: 'start', title })
		try {
			const { jobId, uri, cid } = await (isPrivate ? api.uploadPrivateSite(body) : api.uploadSite(body))
			if (jobId) {
				setJobId(jobId)
				return
			}
			const result = { uri, cid }
			dispatch({ type: 'done', result })
			onFinished(result)
		} catch (error) {
			dispatch({ type: 'fail', error: errorText(error) })
		}
	}

	return { state, start }
}
