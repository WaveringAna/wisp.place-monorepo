import { expect, test } from 'bun:test'
import { MAX_PRIVATE_UPLOAD_REQUEST_SIZE, MAX_PUBLIC_UPLOAD_REQUEST_SIZE } from '@wispplace/constants'
import { MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES } from './public-upload-gate'
import { RequestBodyAdmission } from './request-body-admission'

const requestFor = (path: string, contentLength: string | undefined, ip: string) =>
	new Request(`http://localhost${path}`, {
		method: 'POST',
		headers: {
			...(contentLength === undefined ? {} : { 'content-length': contentLength }),
			'x-forwarded-for': ip,
		},
	})

test('holds only bounded concurrent multipart admissions and releases slow-request leases', () => {
	const admission = new RequestBodyAdmission()
	const first = requestFor('/wisp/upload-files', '1', '198.51.100.1')
	const sameSource = requestFor('/wisp/upload-files', '1', '198.51.100.1')
	const second = requestFor('/api/user/private-sites', '1', '198.51.100.2')
	const third = requestFor('/wisp/upload-files', '1', '198.51.100.3')

	expect(admission.admit(first)).toBeUndefined()
	expect(admission.admit(sameSource)?.status).toBe(429)
	expect(admission.admit(second)).toBeUndefined()
	expect(admission.admit(third)?.status).toBe(429)

	admission.release(first)
	expect(admission.admit(sameSource)).toBeUndefined()
	admission.release(sameSource)
	admission.release(second)
	expect(admission.stats()).toMatchObject({ active: 0, reservedBytes: 0 })
})

test('enforces one weighted public/private retained-body budget', () => {
	const admission = new RequestBodyAdmission()
	const nearlyFull = requestFor(
		'/wisp/upload-files',
		String(MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES - 8),
		'198.51.100.20',
	)
	const exactFit = requestFor('/api/user/private-sites', '8', '198.51.100.21')
	const overBudget = requestFor('/api/user/private-sites', '9', '198.51.100.22')

	expect(admission.admit(nearlyFull)).toBeUndefined()
	expect(admission.stats()).toMatchObject({ active: 1, reservedBytes: MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES - 8 })
	expect(admission.admit(exactFit)).toBeUndefined()
	expect(admission.stats()).toMatchObject({ active: 2, reservedBytes: MAX_RETAINED_PUBLIC_UPLOAD_BODY_BYTES })
	admission.release(exactFit)
	expect(admission.admit(overBudget)?.status).toBe(429)
	admission.release(nearlyFull)

	const smallPublic = requestFor('/wisp/upload-files', '1024', '198.51.100.23')
	const smallPrivate = requestFor('/api/user/private-sites', '2048', '198.51.100.24')
	expect(admission.admit(smallPublic)).toBeUndefined()
	expect(admission.admit(smallPrivate)).toBeUndefined()
	expect(admission.stats()).toMatchObject({ active: 2, reservedBytes: 3072 })
	admission.release(smallPublic)
	admission.release(smallPrivate)
})

test('applies the multipart admission inventory to every buffered upload endpoint', () => {
	const admission = new RequestBodyAdmission()
	const paths = [
		'/wisp/upload-files',
		'/api/user/private-sites',
		'/api/user/private-sites/',
		'/xrpc/place.wisp.v2.privateSite.create',
	]
	for (const [index, path] of paths.entries()) {
		const request = requestFor(path, '1', `198.51.100.${70 + index}`)
		expect(admission.admit(request)).toBeUndefined()
		admission.release(request)
	}
})

test('caps declared public/private multipart and webhook JSON bodies before parsing', () => {
	const admission = new RequestBodyAdmission()
	const publicOversize = requestFor('/wisp/upload-files', String(MAX_PUBLIC_UPLOAD_REQUEST_SIZE + 1), '198.51.100.4')
	const privateOversize = requestFor(
		'/api/user/private-sites',
		String(MAX_PRIVATE_UPLOAD_REQUEST_SIZE + 1),
		'198.51.100.5',
	)
	const webhookOversize = new Request('http://localhost/api/webhook/events', {
		method: 'POST',
		headers: { 'content-length': String(64 * 1024 + 1), 'content-type': 'application/json' },
	})

	expect(admission.admit(publicOversize)?.status).toBe(413)
	expect(admission.admit(privateOversize)?.status).toBe(413)
	expect(admission.admit(webhookOversize)?.status).toBe(413)
})

test('requires a valid declared length outside explicit development or test mode', () => {
	const originalNodeEnv = process.env.NODE_ENV
	try {
		for (const environment of ['production', 'staging', undefined]) {
			if (environment === undefined) delete process.env.NODE_ENV
			else process.env.NODE_ENV = environment
			const admission = new RequestBodyAdmission()
			expect(admission.admit(requestFor('/wisp/upload-files', undefined, '198.51.100.6'))?.status).toBe(400)
		}
		const admission = new RequestBodyAdmission()
		expect(admission.admit(requestFor('/api/user/private-sites', '1, 2', '198.51.100.7'))?.status).toBe(400)
	} finally {
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV
		else process.env.NODE_ENV = originalNodeEnv
	}
})

test('fails closed when local development omits Content-Length beyond the configured memory budget', () => {
	const originalNodeEnv = process.env.NODE_ENV
	try {
		process.env.NODE_ENV = 'test'
		const admission = new RequestBodyAdmission()
		const unknownLength = requestFor('/wisp/upload-files', undefined, '198.51.100.30')
		expect(admission.admit(unknownLength)?.status).toBe(413)
		expect(admission.stats()).toMatchObject({ active: 0, reservedBytes: 0 })
	} finally {
		if (originalNodeEnv === undefined) delete process.env.NODE_ENV
		else process.env.NODE_ENV = originalNodeEnv
	}
})

test('does not auto-release a slow admitted multipart request', async () => {
	const admission = new RequestBodyAdmission()
	const first = requestFor('/wisp/upload-files', '1', '198.51.100.8')
	const second = requestFor('/wisp/upload-files', '1', '198.51.100.8')

	expect(admission.admit(first)).toBeUndefined()
	await new Promise<void>((resolve) => setTimeout(resolve, 20))
	expect(admission.admit(second)?.status).toBe(429)
	admission.release(first)
	expect(admission.admit(second)).toBeUndefined()
	admission.release(second)
})

test('releases an admitted multipart lease when the client request aborts', async () => {
	const admission = new RequestBodyAdmission()
	const controller = new AbortController()
	const first = new Request('http://localhost/wisp/upload-files', {
		method: 'POST',
		headers: { 'content-length': '1', 'x-forwarded-for': '198.51.100.9' },
		signal: controller.signal,
	})
	const second = requestFor('/wisp/upload-files', '1', '198.51.100.9')

	expect(admission.admit(first)).toBeUndefined()
	controller.abort()
	await Promise.resolve()
	expect(admission.admit(second)).toBeUndefined()
	admission.release(second)
})
