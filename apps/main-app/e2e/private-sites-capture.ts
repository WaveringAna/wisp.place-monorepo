import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { type BrowserContext, chromium, type Page } from 'playwright'

const env = (name: string, fallback: string) => process.env[name] || fallback
const appUrl = env('E2E_APP_URL', 'http://127.0.0.1:8000').replace(/\/$/, '')
const appUpstream = env('E2E_APP_UPSTREAM', 'http://main-app:8000').replace(/\/$/, '')
const hostingUrl = env('E2E_HOSTING_URL', 'http://hosting-service:3001').replace(/\/$/, '')
const hostingBrowserUrl = env('E2E_HOSTING_BROWSER_URL', 'http://127.0.0.1:3001').replace(/\/$/, '')
const pdsBrowserUrl = env('E2E_PDS_BROWSER_URL', 'http://127.0.0.1:3300').replace(/\/$/, '')
const pdsUpstream = env('E2E_PDS_UPSTREAM', 'http://pds:3300').replace(/\/$/, '')
const atprotoPassword = env('E2E_ATPROTO_PASSWORD', 'alice-dev-password')
const timeoutMs = Number.parseInt(env('E2E_TIMEOUT_MS', '180000'), 10)
const artifactsDir = env('E2E_ARTIFACTS_DIR', '/artifacts')
const chromiumExecutable = process.env.E2E_CHROMIUM_EXECUTABLE || undefined

type Auth = { handle: string; did: string; password: string }
type JsonResponse<T = Record<string, unknown>> = { status: number; data: T; text: string }

const alice: Auth = { handle: env('E2E_ATPROTO_HANDLE', 'alice.test'), did: '', password: atprotoPassword }
const bob: Auth = {
	handle: env('E2E_AUDIENCE_HANDLE', 'bob.test'),
	did: '',
	password: env('E2E_AUDIENCE_PASSWORD', 'bob-dev-password'),
}

function proxy(listen: string, upstream: string, preserveHost = false) {
	const listenUrl = new URL(listen)
	const upstreamUrl = new URL(upstream)
	return Bun.serve({
		hostname: listenUrl.hostname,
		port: Number(listenUrl.port || 80),
		async fetch(request) {
			const incoming = new URL(request.url)
			const target = new URL(`${incoming.pathname}${incoming.search}`, upstreamUrl)
			const headers = new Headers(request.headers)
			headers.set('accept-encoding', 'identity')
			if (preserveHost) headers.set('host', incoming.host)
			else headers.delete('host')
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
}

async function waitFor(url: string) {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		try {
			if ((await fetch(url)).ok) return
		} catch {}
		await delay(1000)
	}
	throw new Error(`timed out waiting for ${url}`)
}

async function json<T>(page: Page, path: string, init?: RequestInit): Promise<JsonResponse<T>> {
	return page.evaluate(
		async ({ path, init }) => {
			const response = await fetch(path, { credentials: 'include', ...init } as any)
			const text = await response.text()
			let data: Record<string, unknown> = {}
			try {
				data = text ? JSON.parse(text) : {}
			} catch {}
			return { status: response.status, data, text }
		},
		{ path, init },
	) as Promise<JsonResponse<T>>
}

async function login(page: Page, account: Auth): Promise<string> {
	await page.goto(`${appUrl}/api/auth/login?login_hint=${encodeURIComponent(account.handle)}`, {
		waitUntil: 'commit',
		timeout: timeoutMs,
	})
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		if (page.url().startsWith(appUrl)) {
			const status = (await page
				.evaluate(() => fetch('/api/auth/status', { credentials: 'include' }).then((r) => r.json()))
				.catch(() => null)) as { authenticated?: boolean; did?: string } | null
			if (status?.authenticated && status.did) {
				account.did = status.did
				return status.did
			}
		}
		const identifier = page
			.locator(
				'input[name="identifier"]:not([disabled]):not([readonly]), input[name="handle"]:not([disabled]):not([readonly]), input[autocomplete="username"]:not([disabled]):not([readonly]), input[placeholder*="handle" i]:not([disabled]):not([readonly])',
			)
			.first()
		const password = page
			.locator(
				'input[type="password"]:not([disabled]):not([readonly]), input[autocomplete="current-password"]:not([disabled]):not([readonly])',
			)
			.first()
		if (await identifier.isVisible().catch(() => false)) await identifier.fill(account.handle)
		if (await password.isVisible().catch(() => false)) await password.fill(account.password)
		const button = page.getByRole('button', { name: /next|continue|log in|sign in|authorize|allow|accept/i }).first()
		if ((await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false)))
			await button.click()
		else await page.keyboard.press('Enter').catch(() => undefined)
		await Promise.race([page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined), delay(750)])
	}
	throw new Error(`timed out signing in ${account.handle}`)
}

async function screenshot(page: Page, name: string) {
	await page.screenshot({ path: `${artifactsDir}/${name}.png`, fullPage: true })
}

async function upload(page: Page): Promise<{ siteId: string; url: string }> {
	const result = await page.evaluate(async () => {
		const form = new FormData()
		form.append('name', 'agent architecture review')
		form.append(
			'files',
			new File(
				[
					`<!doctype html><html><head><title>agent architecture review</title><link rel="stylesheet" href="/report.css"></head><body><main><p class="eyebrow">private report</p><h1>permissioned data, in practice</h1><p>this is an owner-only report rendered from the private storage origin.</p><details open><summary>the honest tradeoff</summary><p>wisp can read and serve this content; it is access control, not encryption.</p></details></main></body></html>`,
				],
				'index.html',
				{ type: 'text/html' },
			),
		)
		form.append(
			'files',
			new File(
				[
					'body { font-family: system-ui; max-width: 48rem; margin: 12vh auto; padding: 2rem; color: #24202a; } .eyebrow { text-transform: uppercase; letter-spacing: .15em; color: #d34d78; }',
				],
				'report.css',
				{ type: 'text/css' },
			),
		)
		const response = await fetch('/api/user/private-sites/', { method: 'POST', body: form, credentials: 'include' })
		const text = await response.text()
		return {
			status: response.status,
			data: JSON.parse(text) as { siteId: string; url: string; success?: boolean },
			text,
		}
	})
	if (result.status !== 200 || !result.data.success)
		throw new Error(`private upload failed: ${result.status} ${result.text}`)
	return result.data
}

async function main() {
	await mkdir(artifactsDir, { recursive: true })
	const proxies = [
		proxy(appUrl, appUpstream),
		proxy(pdsBrowserUrl, pdsUpstream, true),
		proxy(hostingBrowserUrl, hostingUrl, true),
	]
	const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable })
	const contexts: BrowserContext[] = []
	try {
		await waitFor(`${appUpstream}/api/health`)
		await waitFor(`${hostingUrl}/health`)
		const owner = await browser.newContext({
			baseURL: appUrl,
			ignoreHTTPSErrors: true,
			recordVideo: { dir: `${artifactsDir}/video`, size: { width: 1440, height: 1000 } },
		})
		contexts.push(owner)
		const ownerPage = await owner.newPage()
		await login(ownerPage, alice)
		const site = await upload(ownerPage)
		const siteUrl = site.url.replace('http://', `${hostingBrowserUrl.split('://')[0]}://`).replace(/:\d+\//, ':3001/')
		console.log(`[capture] site=${site.siteId} url=${siteUrl}`)

		const ownerOpen = await json<{ success?: boolean; url?: string }>(
			ownerPage,
			`/api/user/private-sites/${site.siteId}/open`,
			{ method: 'POST' },
		)
		if (!ownerOpen.data.url) throw new Error(`owner open failed: ${ownerOpen.status} ${ownerOpen.text}`)
		await ownerPage.goto(ownerOpen.data.url, { waitUntil: 'domcontentloaded' })
		await screenshot(ownerPage, '01-owner-private-site')
		await ownerPage.goto(`${appUrl}/onboarding`, { waitUntil: 'domcontentloaded' })

		const anonymous = await browser.newContext({
			ignoreHTTPSErrors: true,
			recordVideo: { dir: `${artifactsDir}/video`, size: { width: 1440, height: 1000 } },
		})
		contexts.push(anonymous)
		const anonymousPage = await anonymous.newPage()
		const anonymousResponse = await anonymousPage.goto(siteUrl, { waitUntil: 'domcontentloaded' })
		if (anonymousResponse?.status() !== 200 || !(await anonymousPage.getByText('private site').count()))
			throw new Error('anonymous private-site denial was not shown')
		await screenshot(anonymousPage, '02-anonymous-access-denied')

		const share = await json<{ success?: boolean; shareId?: string; url?: string; directUrl?: string }>(
			ownerPage,
			`/api/user/private-sites/${site.siteId}/shares`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ label: 'bob review', audienceDid: await resolveDid(bob.handle) }),
			},
		)
		if (!share.data.shareId || !share.data.directUrl)
			throw new Error(`share creation failed: ${share.status} ${share.text}`)
		await screenshot(ownerPage, '03-share-link-created')

		const audience = await browser.newContext({
			ignoreHTTPSErrors: true,
			recordVideo: { dir: `${artifactsDir}/video`, size: { width: 1440, height: 1000 } },
		})
		contexts.push(audience)
		const audiencePage = await audience.newPage()
		await audiencePage.goto(share.data.directUrl, { waitUntil: 'domcontentloaded' })
		if (!(await audiencePage.getByText('this link is for a specific account').count()))
			throw new Error('audience sign-in gate was not shown')
		await screenshot(audiencePage, '04-audience-restricted-sign-in')

		const bobContext = await browser.newContext({
			baseURL: appUrl,
			ignoreHTTPSErrors: true,
			recordVideo: { dir: `${artifactsDir}/video`, size: { width: 1440, height: 1000 } },
		})
		contexts.push(bobContext)
		const bobPage = await bobContext.newPage()
		await login(bobPage, bob)
		const redeem = await bobContext.request.post(`${appUrl}/private/redeem`, {
			form: {
				siteId: site.siteId,
				token: new URL(share.data.directUrl).searchParams.get('wisp_share') || '',
			},
			headers: { Origin: appUrl },
			maxRedirects: 0,
		})
		const grant = redeem.headers().location
		if (redeem.status() !== 303 || !grant)
			throw new Error(`audience redeem failed: ${redeem.status()} ${await redeem.text()}`)
		await bobPage.goto(grant, { waitUntil: 'domcontentloaded' })
		if (!(await bobPage.getByText('permissioned data, in practice').count()))
			throw new Error(
				`audience account could not open site: ${bobPage.url()} ${await bobPage.locator('body').innerText()}`,
			)
		await screenshot(bobPage, '05-audience-site-open')

		const revoke = await json(ownerPage, `/api/user/private-sites/${site.siteId}/shares/${share.data.shareId}`, {
			method: 'DELETE',
		})
		if (revoke.status !== 200) throw new Error(`share revoke failed: ${revoke.status} ${revoke.text}`)
		await bobPage.reload({ waitUntil: 'domcontentloaded' })
		if ((await bobPage.locator('body').innerText()).includes('permissioned data, in practice'))
			throw new Error('revoked audience session still served private content')
		await screenshot(bobPage, '06-revoked-share-denied')
		console.log('[capture] completed private-site evidence capture')
	} finally {
		for (const context of contexts) await context.close()
		await browser.close()
		for (const server of proxies) server.stop(true)
	}
}

async function resolveDid(handle: string): Promise<string> {
	const response = await fetch(
		`${pdsUpstream}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
	)
	const result = (await response.json()) as { did?: string }
	if (!response.ok || !result.did) throw new Error(`could not resolve ${handle}`)
	return result.did
}

main().catch((error) => {
	console.error('[capture] failed', error)
	process.exit(1)
})
