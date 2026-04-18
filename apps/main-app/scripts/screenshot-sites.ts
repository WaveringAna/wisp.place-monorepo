#!/usr/bin/env bun

/**
 * Screenshot Sites Script
 *
 * Takes screenshots of all sites in the database.
 * Usage: bun run scripts/screenshot-sites.ts
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type BrowserContext, chromium, type Page } from 'playwright'
import { db } from '../src/lib/db'

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots')
const VIEWPORT_WIDTH = 1920
const VIEWPORT_HEIGHT = 1080
const TIMEOUT = 10000 // 10 seconds
const MAX_RETRIES = 1
const CONCURRENCY = 10 // Number of parallel screenshots

const COLOR_SCHEMES = ['light', 'dark'] as const
type ColorScheme = (typeof COLOR_SCHEMES)[number]

interface Site {
	did: string
	rkey: string
}

/**
 * Get all sites from the database
 */
async function getAllSites(): Promise<Site[]> {
	const rows = await db`
		SELECT did, rkey
		FROM sites
		ORDER BY created_at DESC
	`

	return rows as Site[]
}

/**
 * Determine the URL to screenshot for a site
 * Priority: custom domain (verified) → wisp domain → fallback to sites.wisp.place
 */
async function getSiteUrl(site: Site): Promise<string> {
	// Check for custom domain mapped to this site
	const customDomains = await db`
		SELECT domain FROM custom_domains
		WHERE did = ${site.did} AND rkey = ${site.rkey} AND verified = true
		LIMIT 1
	`
	if (customDomains.length > 0) {
		return `https://${customDomains[0].domain}`
	}

	// Check for wisp domain mapped to this site
	const wispDomains = await db`
		SELECT domain FROM domains
		WHERE did = ${site.did} AND rkey = ${site.rkey}
		LIMIT 1
	`
	if (wispDomains.length > 0) {
		return `https://${wispDomains[0].domain}`
	}

	// Fallback to direct serving URL
	return `https://sites.wisp.place/${site.did}/${site.rkey}`
}

/**
 * Sanitize filename to remove invalid characters
 */
function sanitizeFilename(str: string): string {
	return str.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()
}

/**
 * Take a screenshot of a site with retry logic
 */
async function screenshotSite(
	page: Page,
	site: Site,
	scheme: ColorScheme,
	retries: number = MAX_RETRIES,
): Promise<{ success: boolean; error?: string }> {
	const url = await getSiteUrl(site)
	// Use the URL as filename (remove https:// and sanitize)
	const urlForFilename = url.replace(/^https?:\/\//, '')
	const filename = `${sanitizeFilename(urlForFilename)}.png`
	const filepath = join(SCREENSHOTS_DIR, scheme, filename)

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			// Navigate to the site
			await page.goto(url, {
				waitUntil: 'networkidle',
				timeout: TIMEOUT,
			})

			// Wait a bit for any dynamic content
			await page.waitForTimeout(1000)

			// Take screenshot
			await page.screenshot({
				path: filepath,
				fullPage: false, // Just viewport, not full scrollable page
				type: 'png',
			})

			return { success: true }
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)

			if (attempt < retries) {
				continue
			}

			return { success: false, error: errorMsg }
		}
	}

	return { success: false, error: 'Unknown error' }
}

/**
 * Main function
 */
async function main() {
	console.log('🚀 Starting site screenshot process...\n')

	// Create screenshots directory (with light/dark subdirs) if it doesn't exist
	for (const scheme of COLOR_SCHEMES) {
		await mkdir(join(SCREENSHOTS_DIR, scheme), { recursive: true })
	}
	console.log(`📁 Screenshots will be saved to: ${SCREENSHOTS_DIR}/{light,dark}\n`)

	// Get all sites
	console.log('📊 Fetching sites from database...')
	const sites = await getAllSites()
	console.log(`   Found ${sites.length} sites\n`)

	if (sites.length === 0) {
		console.log('No sites to screenshot. Exiting.')
		return
	}

	// Launch browser
	console.log('🌐 Launching browser...\n')
	const browser = await chromium.launch({
		headless: true,
	})

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

	// Track results
	const results = {
		success: 0,
		failed: 0,
		errors: [] as { site: string; error: string }[],
	}

	// Process sites in parallel batches
	console.log(`📸 Screenshotting ${sites.length} sites × 2 schemes with concurrency ${CONCURRENCY}...\n`)

	for (let i = 0; i < sites.length; i += CONCURRENCY) {
		const batch = sites.slice(i, i + CONCURRENCY)
		const batchNum = Math.floor(i / CONCURRENCY) + 1
		const totalBatches = Math.ceil(sites.length / CONCURRENCY)

		console.log(`[Batch ${batchNum}/${totalBatches}] Processing ${batch.length} sites...`)

		// Create a page for each site × scheme in the batch
		const batchResults = await Promise.all(
			batch.flatMap((site, idx) =>
				COLOR_SCHEMES.map(async (scheme) => {
					const page = await contexts[scheme].newPage()
					const globalIdx = i + idx + 1
					console.log(`  [${globalIdx}/${sites.length}] ${site.did}/${site.rkey} (${scheme})`)

					const result = await screenshotSite(page, site, scheme)
					await page.close()

					return { site, scheme, result }
				}),
			),
		)

		// Aggregate results
		for (const { site, scheme, result } of batchResults) {
			if (result.success) {
				results.success++
			} else {
				results.failed++
				results.errors.push({
					site: `${site.did}/${site.rkey} (${scheme})`,
					error: result.error || 'Unknown error',
				})
			}
		}

		console.log(
			`  Batch complete: ${batchResults.filter((r) => r.result.success).length}/${batchResults.length} successful\n`,
		)
	}

	// Cleanup
	await browser.close()

	// Print summary
	console.log('╔════════════════════════════════════════════════════════════════╗')
	console.log('║                    SCREENSHOT SUMMARY                          ║')
	console.log('╚════════════════════════════════════════════════════════════════╝\n')
	console.log(`Total sites: ${sites.length}`)
	console.log(`✅ Successful: ${results.success}`)
	console.log(`❌ Failed: ${results.failed}`)

	if (results.errors.length > 0) {
		console.log('\nFailed sites:')
		for (const err of results.errors) {
			console.log(`  - ${err.site}: ${err.error}`)
		}
	}

	console.log(`\n📁 Screenshots saved to: ${SCREENSHOTS_DIR}\n`)
}

// Run the script
main().catch((error) => {
	console.error('Fatal error:', error)
	process.exit(1)
})
