import { MAX_PRIVATE_UPLOAD_REQUEST_SIZE, MAX_PUBLIC_UPLOAD_REQUEST_SIZE } from '@wispplace/constants'
import {
	MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES,
	type PublicUploadRequestLease,
	publicUploadRequestGate,
	publicUploadSourceKey,
} from './public-upload-gate'

const MAX_WEBHOOK_JSON_BYTES = 64 * 1024
const MAX_NORMAL_JSON_BYTES = 1024 * 1024

interface RequestLease {
	lease: PublicUploadRequestLease
	abortHandler: () => void
}

/** A weighted body reservation detached from its HTTP request for upload work. */
export interface RetainedUploadLease {
	release(): void
}

export class RequestBodyAdmission {
	private readonly leases = new WeakMap<Request, RequestLease>()

	admit(request: Request): Response | undefined {
		const policy = bodyPolicy(request)
		if (!policy) return undefined
		const declaredBytes = parseContentLength(request.headers.get('content-length'))
		const error = contentLengthError(declaredBytes, policy)
		if (error) return error
		if (!policy.reserveUploadSlot || this.leases.has(request)) return undefined
		const reservedBytes = declaredBytes ?? policy.maxBytes
		if (reservedBytes > MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES) return jsonError(413, 'Request body too large')
		return this.acquireUploadLease(request, reservedBytes)
	}

	release(request: Request): void {
		const requestLease = this.leases.get(request)
		if (!requestLease) return
		request.signal.removeEventListener('abort', requestLease.abortHandler)
		publicUploadRequestGate.release(requestLease.lease)
		this.leases.delete(request)
	}

	/**
	 * Move the weighted reservation to a background upload. This is synchronous
	 * so afterResponse cannot release it between detaching and lifecycle tracking.
	 */
	takeUploadLease(request: Request): RetainedUploadLease | undefined {
		const requestLease = this.leases.get(request)
		if (!requestLease) return undefined
		request.signal.removeEventListener('abort', requestLease.abortHandler)
		this.leases.delete(request)
		let released = false
		return {
			release: () => {
				if (released) return
				released = true
				publicUploadRequestGate.release(requestLease.lease)
			},
		}
	}

	stats(): ReturnType<typeof publicUploadRequestGate.stats> {
		return publicUploadRequestGate.stats()
	}

	private acquireUploadLease(request: Request, reservedBytes: number): Response | undefined {
		const lease = publicUploadRequestGate.tryAcquire(publicUploadSourceKey(request), reservedBytes)
		if (!lease) return jsonError(429, 'Upload capacity reached')
		// Do not auto-release this lease: a slow request may still be inside the
		// multipart parser. Elysia afterResponse/onError or Request.signal abort
		// owns it until takeUploadLease transfers it to background work.
		const requestLease: RequestLease = {
			lease,
			abortHandler: () => this.release(request),
		}
		this.leases.set(request, requestLease)
		if (request.signal.aborted) this.release(request)
		else request.signal.addEventListener('abort', requestLease.abortHandler, { once: true })
		return undefined
	}
}

interface BodyPolicy {
	maxBytes: number
	requireLengthInProduction: boolean
	reserveUploadSlot: boolean
}

function bodyPolicy(request: Request): BodyPolicy | null {
	const path = new URL(request.url).pathname
	const multipartLimit = multipartRequestLimit(request.method, path)
	if (multipartLimit) return { maxBytes: multipartLimit, requireLengthInProduction: true, reserveUploadSlot: true }
	if (isWebhookMutation(request.method, path))
		return { maxBytes: MAX_WEBHOOK_JSON_BYTES, requireLengthInProduction: true, reserveUploadSlot: false }
	if (isJsonMutation(request))
		return { maxBytes: MAX_NORMAL_JSON_BYTES, requireLengthInProduction: true, reserveUploadSlot: false }
	return null
}

function multipartRequestLimit(method: string, path: string): number | null {
	if (method !== 'POST') return null
	if (path === '/wisp/upload-files') return MAX_PUBLIC_UPLOAD_REQUEST_SIZE
	if (path === '/api/user/private-sites' || path === '/api/user/private-sites/') return MAX_PRIVATE_UPLOAD_REQUEST_SIZE
	if (path === '/xrpc/place.wisp.v2.privateSite.create') return MAX_PRIVATE_UPLOAD_REQUEST_SIZE
	return null
}

function isWebhookMutation(method: string, path: string): boolean {
	return method !== 'GET' && method !== 'HEAD' && (path === '/api/webhook' || path.startsWith('/api/webhook/'))
}

function isJsonMutation(request: Request): boolean {
	if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false
	return request.headers.get('content-type')?.toLowerCase().includes('application/json') ?? false
}

function contentLengthError(length: number | null | undefined, policy: BodyPolicy): Response | undefined {
	if (length === undefined) return jsonError(400, 'Invalid request body')
	if (length === null && policy.requireLengthInProduction && !isExplicitLocalEnvironment()) {
		return jsonError(400, 'Invalid request body')
	}
	if (length !== null && length > policy.maxBytes) return jsonError(413, 'Request body too large')
	return undefined
}

function isExplicitLocalEnvironment(): boolean {
	return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'
}

function parseContentLength(value: string | null): number | null | undefined {
	if (value === null) return null
	if (!/^\d+$/.test(value)) return undefined
	const length = Number(value)
	return Number.isSafeInteger(length) ? length : undefined
}

function jsonError(status: number, error: string): Response {
	return new Response(JSON.stringify({ success: false, error }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

export const requestBodyAdmission = new RequestBodyAdmission()
