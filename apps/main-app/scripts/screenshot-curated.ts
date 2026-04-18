#!/usr/bin/env bun

/**
 * Screenshot Curated Sites
 *
 * Reads the filenames already in `apps/main-app/public/screenshots/` (or its
 * light/ subdir if split), infers each domain (filename.webp → filename with
 * `_` → `.`), and re-captures each in both light and dark color schemes.
 * Output: `apps/main-app/public/screenshots/{light,dark}/<domain>.webp` (q82).
 *
 * Usage: bun run apps/main-app/scripts/screenshot-curated.ts
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type BrowserContext, chromium } from 'playwright'

const PUBLIC_SCREENSHOTS_DIR = join(process.cwd(), 'apps/main-app/public/screenshots')
const VIEWPORT_WIDTH = 1920
const VIEWPORT_HEIGHT = 1080
const TIMEOUT = 15_000
const CONCURRENCY = 6
const WEBP_QUALITY = 82

const COLOR_SCHEMES = ['light', 'dark'] as const
type ColorScheme = (typeof COLOR_SCHEMES)[number]

async function collectCuratedDomains(): Promise<string[]> {
	const candidates = [join(PUBLIC_SCREENSHOTS_DIR, 'light'), PUBLIC_SCREENSHOTS_DIR]

	for (const dir of candidates) {
		try {
			const entries = await readdir(dir, { withFileTypes: true })
			const domains = entries
				.filter((e) => e.isFile() && e.name.endsWith('.webp'))
				.map((e) => e.name.replace(/\.webp$/i, '').replace(/_/g, '.'))

			if (domains.length > 0) {
				return Array.from(new Set(domains)).sort()
			}
		} catch {
			// Directory missing — try next.
		}
	}

	return []
}

function sanitize(domain: string): string {
	return domain.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()
}

function cwebpEncode(inputPath: string, outputPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn('cwebp', ['-q', String(WEBP_QUALITY), '-quiet', inputPath, '-o', outputPath])
		proc.on('error', reject)
		proc.on('close', (code) => {
			if (code === 0) resolve()
			else reject(new Error(`cwebp exited with code ${code}`))
		})
	})
}

async function captureOne(
	contexts: Record<ColorScheme, BrowserContext>,
	domain: string,
	scheme: ColorScheme,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const url = `https://${domain}`
	const outDir = join(PUBLIC_SCREENSHOTS_DIR, scheme)
	const baseName = sanitize(domain)
	const pngTmp = join(outDir, `${baseName}.tmp.png`)
	const webpOut = join(outDir, `${baseName}.webp`)

	const page = await contexts[scheme].newPage()
	try {
		await page.goto(url, { waitUntil: 'networkidle', timeout: TIMEOUT })
		await page.waitForTimeout(1200)
		await page.screenshot({ path: pngTmp, fullPage: false, type: 'png' })
		await cwebpEncode(pngTmp, webpOut)
		await rm(pngTmp, { force: true })
		return { ok: true }
	} catch (error) {
		await rm(pngTmp, { force: true }).catch(() => {})
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}
	} finally {
		await page.close()
	}
}

async function main() {
	const domains = await collectCuratedDomains()
	if (domains.length === 0) {
		console.error('No curated screenshots found. Nothing to do.')
		process.exit(1)
	}

	console.log(`Found ${domains.length} curated domains. Capturing light + dark…`)

	for (const scheme of COLOR_SCHEMES) {
		await mkdir(join(PUBLIC_SCREENSHOTS_DIR, scheme), { recursive: true })
	}

	const browser = await chromium.launch({ headless: true })
	const contexts: Record<ColorScheme, BrowserContext> = {
		light: await browser.newContext({
			viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
			colorScheme: 'light',
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WispScreenshotBot/1.0',
		}),
		dark: await browser.newContext({
			viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
			colorScheme: 'dark',
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WispScreenshotBot/1.0',
		}),
	}

	const jobs: Array<{ domain: string; scheme: ColorScheme }> = []
	for (const domain of domains) {
		for (const scheme of COLOR_SCHEMES) {
			jobs.push({ domain, scheme })
		}
	}

	const results = { success: 0, failed: 0, errors: [] as string[] }

	for (let i = 0; i < jobs.length; i += CONCURRENCY) {
		const batch = jobs.slice(i, i + CONCURRENCY)
		const outcomes = await Promise.all(
			batch.map(async ({ domain, scheme }, offset) => {
				const idx = i + offset + 1
				console.log(`  [${idx}/${jobs.length}] ${domain} (${scheme})`)
				return { domain, scheme, result: await captureOne(contexts, domain, scheme) }
			}),
		)

		for (const { domain, scheme, result } of outcomes) {
			if (result.ok) {
				results.success++
			} else {
				results.failed++
				results.errors.push(`${domain} (${scheme}): ${result.error}`)
			}
		}
	}

	await browser.close()

	console.log(`\nDone: ${results.success} ok, ${results.failed} failed`)
	if (results.errors.length > 0) {
		console.log('Failed:')
		for (const e of results.errors) console.log(`  - ${e}`)
	}
}

main().catch((error) => {
	console.error('Fatal:', error)
	process.exit(1)
})
