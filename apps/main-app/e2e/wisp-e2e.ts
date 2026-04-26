import { setTimeout as delay } from 'node:timers/promises'
import { type Browser, chromium, type Page } from 'playwright'

type JsonResponse<T = unknown> = {
	ok: boolean
	status: number
	data: T | null
	text: string
}

type UploadStartResponse = {
	success?: boolean
	jobId?: string
	error?: string
}

type UploadDoneResponse = {
	success?: boolean
	fileCount?: number
	uploadedCount?: number
	hasFailures?: boolean
	failedFiles?: Array<{ name: string; error: string }>
}

const requiredEnv = (name: string): string => {
	const value = process.env[name]
	if (!value) {
		throw new Error(`${name} is required`)
	}
	return value
}

const env = (name: string, fallback: string): string => process.env[name] || fallback

const appUrl = env('E2E_APP_URL', 'http://127.0.0.1:8000').replace(/\/$/, '')
const appUpstream = env('E2E_APP_UPSTREAM', 'http://main-app:8000').replace(/\/$/, '')
const hostingUrl = env('E2E_HOSTING_URL', 'http://hosting-service:3001').replace(/\/$/, '')
const firehoseUrl = env('E2E_FIREHOSE_URL', 'http://firehose-service:3001').replace(/\/$/, '')
const atprotoHandle = requiredEnv('E2E_ATPROTO_HANDLE')
const atprotoPassword = requiredEnv('E2E_ATPROTO_PASSWORD')
const timeoutMs = Number.parseInt(env('E2E_TIMEOUT_MS', '180000'), 10)
const cleanupEnabled = env('E2E_CLEANUP', 'true') !== 'false'
const headless = env('E2E_HEADLESS', 'true') !== 'false'
const chromiumExecutable = process.env.E2E_CHROMIUM_EXECUTABLE || undefined

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const domainHandle = env('E2E_DOMAIN_HANDLE', `e2e-${runId}`).toLowerCase()
const domain = `${domainHandle}.wisp.place`
const siteName = env('E2E_SITE_RKEY', `e2e-${runId}`).toLowerCase()
const marker = `wisp-e2e-${runId}`

function startLoopbackProxy() {
	const listenUrl = new URL(appUrl)
	const upstreamUrl = new URL(appUpstream)

	const server = Bun.serve({
		hostname: listenUrl.hostname,
		port: Number(listenUrl.port || '80'),
		async fetch(request) {
			const incomingUrl = new URL(request.url)
			const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, upstreamUrl)
			const headers = new Headers(request.headers)
			headers.delete('host')
			headers.set('x-forwarded-host', listenUrl.host)
			headers.set('x-forwarded-proto', listenUrl.protocol.replace(':', ''))

			return fetch(target, {
				method: request.method,
				headers,
				body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
				redirect: 'manual',
			})
		},
	})

	console.log(`[e2e] Loopback proxy listening on ${appUrl} -> ${appUpstream}`)
	return server
}

async function waitForHttpOk(url: string, label: string): Promise<void> {
	await poll(
		async () => {
			try {
				const response = await fetch(url)
				return response.ok
			} catch {
				return false
			}
		},
		{ label, timeout: timeoutMs, interval: 1000 },
	)
}

async function poll(
	check: () => Promise<boolean>,
	options: { label: string; timeout: number; interval?: number },
): Promise<void> {
	const started = Date.now()
	const interval = options.interval ?? 1000
	let attempts = 0

	while (Date.now() - started < options.timeout) {
		attempts++
		if (await check()) return
		if (attempts % 10 === 0) {
			console.log(`[e2e] Still waiting for ${options.label} (${Math.round((Date.now() - started) / 1000)}s)`)
		}
		await delay(interval)
	}

	throw new Error(`Timed out waiting for ${options.label}`)
}

async function maybeFill(page: Page, selectors: string[], value: string): Promise<boolean> {
	for (const selector of selectors) {
		const locator = page.locator(selector).first()
		if ((await locator.count()) === 0) continue
		if (!(await locator.isVisible().catch(() => false))) continue
		if (!(await locator.isEnabled().catch(() => false))) continue

		const current = await locator.inputValue().catch(() => '')
		if (current !== value) {
			await locator.fill(value)
		}
		return true
	}
	return false
}

async function clickFirstButton(page: Page, names: RegExp[]): Promise<boolean> {
	for (const name of names) {
		const button = page.getByRole('button', { name }).first()
		if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
			if (await button.isEnabled().catch(() => false)) {
				await button.click()
				return true
			}
		}
	}

	const submit = page.locator('button[type="submit"], input[type="submit"]').first()
	if ((await submit.count()) > 0 && (await submit.isVisible().catch(() => false))) {
		if (await submit.isEnabled().catch(() => false)) {
			await submit.click()
			return true
		}
	}

	return false
}

async function appAuthStatus(page: Page): Promise<{ authenticated: boolean; did?: string }> {
	return await page.evaluate(async () => {
		const response = await fetch('/api/auth/status', { credentials: 'include' })
		return response.json()
	})
}

async function completeAtprotoLogin(page: Page): Promise<string> {
	const loginUrl = `${appUrl}/api/auth/login?login_hint=${encodeURIComponent(atprotoHandle)}`
	await page.goto(loginUrl, { waitUntil: 'domcontentloaded' })

	const started = Date.now()
	let lastLoggedUrl = ''

	while (Date.now() - started < timeoutMs) {
		const currentUrl = page.url()
		if (currentUrl !== lastLoggedUrl) {
			console.log(`[e2e] Auth flow at ${currentUrl}`)
			lastLoggedUrl = currentUrl
		}

		if (currentUrl.startsWith(appUrl)) {
			const status: { authenticated: boolean; did?: string } = await appAuthStatus(page).catch(() => ({
				authenticated: false,
			}))
			if (status.authenticated && status.did) {
				console.log(`[e2e] Signed in as ${status.did}`)
				return status.did
			}
		}

		const twoFactorInput = page
			.locator('input[name*="code" i], input[autocomplete="one-time-code"], input[inputmode="numeric"]')
			.first()
		if ((await twoFactorInput.count()) > 0 && (await twoFactorInput.isVisible().catch(() => false))) {
			throw new Error('Two-factor auth is not supported by this harness; use a dedicated test account without 2FA')
		}

		const filledIdentifier = await maybeFill(
			page,
			[
				'input[name="identifier"]',
				'input[name="handle"]',
				'input[name="login"]',
				'input[autocomplete="username"]',
				'input[type="email"]',
				'input[placeholder*="handle" i]',
				'input[placeholder*="email" i]',
			],
			atprotoHandle,
		)

		const filledPassword = await maybeFill(
			page,
			['input[type="password"]', 'input[name="password"]', 'input[autocomplete="current-password"]'],
			atprotoPassword,
		)

		const clicked = await clickFirstButton(
			page,
			filledPassword
				? [/log in/i, /sign in/i, /continue/i, /authorize/i, /allow/i, /accept/i]
				: filledIdentifier
					? [/next/i, /continue/i, /log in/i, /sign in/i]
					: [/authorize/i, /allow/i, /accept/i, /continue/i, /yes/i],
		)

		if (!clicked) {
			await page.keyboard.press('Enter').catch(() => undefined)
		}

		await Promise.race([page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined), delay(750)])
	}

	throw new Error('Timed out completing ATProto OAuth login')
}

async function appJson<T>(page: Page, path: string, init?: RequestInit): Promise<JsonResponse<T>> {
	return (await page.evaluate(
		async ({ path, init }) => {
			const response = await fetch(path, { credentials: 'include', ...init })
			const text = await response.text()
			let data: unknown = null
			try {
				data = text ? JSON.parse(text) : null
			} catch {
				data = null
			}
			return {
				ok: response.ok,
				status: response.status,
				data,
				text,
			}
		},
		{ path, init },
	)) as JsonResponse<T>
}

async function claimDomain(page: Page): Promise<void> {
	const response = await appJson<{ success?: boolean; domain?: string; error?: string }>(page, '/api/domain/claim', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ handle: domainHandle }),
	})

	if (!response.ok || !response.data?.success) {
		throw new Error(`Domain claim failed (${response.status}): ${response.text}`)
	}

	console.log(`[e2e] Claimed ${response.data.domain}`)
}

async function uploadSite(page: Page): Promise<UploadDoneResponse> {
	const html = `<!doctype html>
<html>
	<head>
		<meta charset="utf-8">
		<title>wisp e2e</title>
		<link rel="stylesheet" href="/style.css">
	</head>
	<body data-marker="${marker}">
		<h1>${marker}</h1>
	</body>
</html>`
	const css = `body { font-family: monospace; color: #123; }`

	const started = await page.evaluate(
		async ({ siteName, html, css }) => {
			const formData = new FormData()
			formData.append('siteName', siteName)
			formData.append('files', new File([html], 'index.html', { type: 'text/html' }))
			formData.append('files', new File([css], 'style.css', { type: 'text/css' }))

			const response = await fetch('/wisp/upload-files', {
				method: 'POST',
				body: formData,
				credentials: 'include',
			})
			const text = await response.text()
			let data: unknown
			try {
				data = JSON.parse(text)
			} catch {
				data = { error: text }
			}

			return { ok: response.ok, status: response.status, data, text }
		},
		{ siteName, html, css },
	)

	const data = started.data as UploadStartResponse
	if (!started.ok || !data.success || !data.jobId) {
		throw new Error(`Upload did not start (${started.status}): ${started.text}`)
	}

	console.log(`[e2e] Upload job ${data.jobId} started`)

	const done = await page.evaluate(
		async ({ jobId, timeoutMs }) => {
			return await new Promise<UploadDoneResponse>((resolve, reject) => {
				const eventSource = new EventSource(`/wisp/upload-progress/${jobId}`)
				const timeout = setTimeout(() => {
					eventSource.close()
					reject(new Error('Timed out waiting for upload SSE'))
				}, timeoutMs)

				const finish = (result: UploadDoneResponse) => {
					clearTimeout(timeout)
					eventSource.close()
					resolve(result)
				}

				eventSource.addEventListener('progress', (event) => {
					const payload = JSON.parse(event.data)
					if (payload.status === 'completed') finish(payload.result || {})
					if (payload.status === 'failed') reject(new Error(payload.error || 'Upload failed'))
				})

				eventSource.addEventListener('done', (event) => {
					finish(JSON.parse(event.data))
				})

				eventSource.addEventListener('error', (event) => {
					const message = 'data' in event && event.data ? String(event.data) : 'Upload SSE failed'
					clearTimeout(timeout)
					eventSource.close()
					reject(new Error(message))
				})
			})
		},
		{ jobId: data.jobId, timeoutMs },
	)

	if (done.hasFailures || (done.failedFiles && done.failedFiles.length > 0)) {
		throw new Error(`Upload completed with failed files: ${JSON.stringify(done.failedFiles)}`)
	}

	console.log(`[e2e] Uploaded ${done.uploadedCount ?? done.fileCount ?? 0} files to ${siteName}`)
	return done
}

async function waitForFirehoseProjection(page: Page): Promise<void> {
	await poll(
		async () => {
			const response = await appJson<{ sites?: Array<{ rkey: string }> }>(page, '/api/user/sites')
			return response.ok && Boolean(response.data?.sites?.some((site) => site.rkey === siteName))
		},
		{ label: `firehose projection for ${siteName}`, timeout: timeoutMs, interval: 2000 },
	)
	console.log(`[e2e] Firehose projected ${siteName} into site_cache`)
}

async function mapDomain(page: Page): Promise<void> {
	const response = await appJson<{ success?: boolean }>(page, '/api/domain/wisp/map-site', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ domain, siteRkey: siteName }),
	})

	if (!response.ok || !response.data?.success) {
		throw new Error(`Domain mapping failed (${response.status}): ${response.text}`)
	}

	console.log(`[e2e] Mapped ${domain} -> ${siteName}`)
}

async function fetchHostedSite(): Promise<{ status: number; text: string; tier: string | null }> {
	const response = await fetch(`${hostingUrl}/`, {
		headers: {
			Host: domain,
			Accept: 'text/html',
			'Accept-Encoding': 'identity',
		},
		redirect: 'manual',
	})
	const text = await response.text()
	return {
		status: response.status,
		text,
		tier: response.headers.get('x-cache-tier'),
	}
}

async function fetchHostedDirect(did: string): Promise<{ status: number; text: string; tier: string | null }> {
	const response = await fetch(`${hostingUrl}/${did}/${siteName}/`, {
		headers: {
			Host: 'sites.wisp.place',
			Accept: 'text/html',
			'Accept-Encoding': 'identity',
		},
		redirect: 'manual',
	})
	const text = await response.text()
	return {
		status: response.status,
		text,
		tier: response.headers.get('x-cache-tier'),
	}
}

async function verifyHostingCacheFlow(): Promise<void> {
	let first: { status: number; text: string; tier: string | null } | undefined

	await poll(
		async () => {
			const response = await fetchHostedSite()
			if (response.status === 200 && response.text.includes(marker)) {
				first = response
				return true
			}
			console.log(
				`[e2e] Hosting not ready: status=${response.status} tier=${response.tier} body=${response.text.slice(0, 80)}`,
			)
			return false
		},
		{ label: `hosting response for ${domain}`, timeout: timeoutMs, interval: 2000 },
	)

	const firstResponse = first
	if (!firstResponse) {
		throw new Error('Hosting response missing after readiness poll')
	}

	if (firstResponse.tier !== 'cold') {
		throw new Error(`Expected first hosting read to come from cold/S3, got ${firstResponse.tier || '(missing)'}`)
	}

	const second = await fetchHostedSite()
	if (second.status !== 200 || !second.text.includes(marker)) {
		throw new Error(`Second hosting read failed: status=${second.status} body=${second.text.slice(0, 120)}`)
	}

	if (second.tier !== 'hot') {
		throw new Error(`Expected second hosting read to come from hot/memory, got ${second.tier || '(missing)'}`)
	}

	console.log('[e2e] Hosting served first from cold/S3 and second from hot/memory')
}

async function deleteDomainAndVerify(page: Page): Promise<void> {
	const domainDelete = await appJson(page, `/api/domain/wisp/${encodeURIComponent(domain)}`, {
		method: 'DELETE',
	})
	if (!domainDelete.ok) {
		throw new Error(`Domain delete failed (${domainDelete.status}): ${domainDelete.text}`)
	}

	await poll(
		async () => {
			const response = await appJson(page, `/api/domain/registered?domain=${encodeURIComponent(domain)}`)
			return response.status === 404
		},
		{ label: `main-app domain deletion for ${domain}`, timeout: timeoutMs, interval: 1000 },
	)

	await poll(
		async () => {
			const response = await fetchHostedSite()
			if (response.status === 404 && !response.text.includes(marker)) return true
			console.log(
				`[e2e] Domain cache still serving or not settled: status=${response.status} tier=${response.tier} body=${response.text.slice(0, 80)}`,
			)
			return false
		},
		{ label: `hosting domain cache invalidation for ${domain}`, timeout: timeoutMs, interval: 1000 },
	)

	console.log(`[e2e] Deleted ${domain} and verified hosting domain cache invalidation`)
}

async function primeDirectSiteCache(did: string): Promise<void> {
	await poll(
		async () => {
			const response = await fetchHostedDirect(did)
			if (response.status === 200 && response.text.includes(marker)) return true
			console.log(
				`[e2e] Direct site route not ready: status=${response.status} tier=${response.tier} body=${response.text.slice(0, 80)}`,
			)
			return false
		},
		{ label: `direct hosted site route for ${did}/${siteName}`, timeout: timeoutMs, interval: 1000 },
	)

	const cached = await fetchHostedDirect(did)
	if (cached.status !== 200 || !cached.text.includes(marker)) {
		throw new Error(`Direct site cache prime failed: status=${cached.status} body=${cached.text.slice(0, 120)}`)
	}

	if (cached.tier !== 'hot') {
		throw new Error(`Expected direct route second read to come from hot/memory, got ${cached.tier || '(missing)'}`)
	}

	console.log('[e2e] Primed direct site route into hosting hot cache')
}

async function deleteSiteRecordAndVerify(page: Page, did: string): Promise<void> {
	const siteDelete = await appJson(page, `/api/site/${encodeURIComponent(siteName)}`, {
		method: 'DELETE',
	})
	if (!siteDelete.ok) {
		throw new Error(`Site record delete failed (${siteDelete.status}): ${siteDelete.text}`)
	}

	await poll(
		async () => {
			const response = await appJson<{ sites?: Array<{ rkey: string }> }>(page, '/api/user/sites')
			return response.ok && !response.data?.sites?.some((site) => site.rkey === siteName)
		},
		{ label: `firehose deletion projection for ${siteName}`, timeout: timeoutMs, interval: 2000 },
	)

	await poll(
		async () => {
			const response = await fetchHostedDirect(did)
			if (response.status === 404 && !response.text.includes(marker)) return true
			console.log(
				`[e2e] Site cache still serving or not settled: status=${response.status} tier=${response.tier} body=${response.text.slice(0, 80)}`,
			)
			return false
		},
		{ label: `hosting site storage invalidation for ${did}/${siteName}`, timeout: timeoutMs, interval: 1000 },
	)

	console.log('[e2e] Deleted place.wisp.fs record and verified firehose + hosting cache eviction')
}

async function cleanup(page: Page): Promise<void> {
	if (!cleanupEnabled) return

	console.log('[e2e] Cleaning up test records')

	const domainDelete = await appJson(page, `/api/domain/wisp/${encodeURIComponent(domain)}`, {
		method: 'DELETE',
	})
	if (!domainDelete.ok) {
		console.warn(`[e2e] Domain cleanup failed (${domainDelete.status}): ${domainDelete.text}`)
	}

	const siteDelete = await appJson(page, `/api/site/${encodeURIComponent(siteName)}`, {
		method: 'DELETE',
	})
	if (!siteDelete.ok) {
		console.warn(`[e2e] Site cleanup failed (${siteDelete.status}): ${siteDelete.text}`)
	}
}

async function main(): Promise<void> {
	console.log(`[e2e] domain=${domain} site=${siteName} marker=${marker}`)
	const proxy = startLoopbackProxy()
	let browser: Browser | null = null
	let page: Page | null = null
	let needsCleanup = true

	try {
		await waitForHttpOk(`${appUpstream}/api/health`, 'main app upstream')
		await waitForHttpOk(`${firehoseUrl}/health`, 'firehose health endpoint')
		await waitForHttpOk(`${hostingUrl}/health`, 'hosting health endpoint')

		browser = await chromium.launch({ headless, executablePath: chromiumExecutable })
		const context = await browser.newContext({
			baseURL: appUrl,
			ignoreHTTPSErrors: true,
		})
		page = await context.newPage()

		const did = await completeAtprotoLogin(page)
		await page.goto(`${appUrl}/onboarding`, { waitUntil: 'domcontentloaded' })

		await claimDomain(page)
		await uploadSite(page)
		await waitForFirehoseProjection(page)

		// Let the cache-invalidation update clear settle before the first hosting read.
		await delay(2000)

		await mapDomain(page)
		await verifyHostingCacheFlow()
		await deleteDomainAndVerify(page)
		await primeDirectSiteCache(did)
		await deleteSiteRecordAndVerify(page, did)

		needsCleanup = false
		console.log('[e2e] Harness completed successfully')
	} finally {
		if (page && needsCleanup) {
			await cleanup(page)
		}
		await browser?.close()
		proxy.stop(true)
	}
}

main().catch((error) => {
	console.error('[e2e] Harness failed')
	console.error(error)
	process.exit(1)
})
