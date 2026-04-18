#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type BrowserContext, chromium, type Page } from 'playwright'
import { db } from '../src/lib/db'

const SITE_IMAGES_DIR = join(process.cwd(), 'site-images')
const VIEWPORT_WIDTH = 1920
const VIEWPORT_HEIGHT = 1080
const TIMEOUT = 10_000
const MAX_RETRIES = 1
const CONCURRENCY = 10

const COLOR_SCHEMES = ['light', 'dark'] as const
type ColorScheme = (typeof COLOR_SCHEMES)[number]

interface DomainBackedSite {
	did: string
	rkey: string
	url: string
	domain: string
	domainType: 'custom' | 'wisp'
}

interface ScreenshotResult {
	success: boolean
	error?: string
}

interface DomainBackedSiteRow {
	did: string
	rkey: string
	domain: string
	domain_type: DomainBackedSite['domainType']
}

async function getDomainBackedSites(): Promise<DomainBackedSite[]> {
	const rows = await db`
		SELECT
			s.did,
			s.rkey,
			COALESCE(cd.domain, d.domain) AS domain,
			CASE
				WHEN cd.domain IS NOT NULL THEN 'custom'
				ELSE 'wisp'
			END AS domain_type
		FROM sites s
		LEFT JOIN LATERAL (
			SELECT domain
			FROM custom_domains
			WHERE did = s.did
				AND rkey = s.rkey
				AND verified = true
			ORDER BY created_at ASC
			LIMIT 1
		) cd ON true
		LEFT JOIN LATERAL (
			SELECT domain
			FROM domains
			WHERE did = s.did
				AND rkey = s.rkey
			ORDER BY created_at ASC
			LIMIT 1
		) d ON cd.domain IS NULL
		WHERE cd.domain IS NOT NULL OR d.domain IS NOT NULL
		ORDER BY s.created_at DESC
	`

	return (rows as DomainBackedSiteRow[]).map((row) => ({
		did: row.did as string,
		rkey: row.rkey as string,
		domain: row.domain as string,
		domainType: row.domain_type as DomainBackedSite['domainType'],
		url: `https://${row.domain}`,
	}))
}

function sanitizeFilename(value: string): string {
	return value.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()
}

async function screenshotSite(
	page: Page,
	site: DomainBackedSite,
	scheme: ColorScheme,
	retries: number = MAX_RETRIES,
): Promise<ScreenshotResult> {
	const filename = `${sanitizeFilename(site.domain)}.png`
	const filepath = join(SITE_IMAGES_DIR, scheme, filename)

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await page.goto(site.url, {
				waitUntil: 'networkidle',
				timeout: TIMEOUT,
			})

			await page.waitForTimeout(1000)

			await page.screenshot({
				path: filepath,
				fullPage: false,
				type: 'png',
			})

			return { success: true }
		} catch (error) {
			if (attempt < retries) {
				continue
			}

			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	}

	return { success: false, error: 'Unknown error' }
}

async function main() {
	console.log('Starting site image poller')
	for (const scheme of COLOR_SCHEMES) {
		await mkdir(join(SITE_IMAGES_DIR, scheme), { recursive: true })
	}
	console.log(`Saving screenshots to ${SITE_IMAGES_DIR}/{light,dark}`)

	const sites = await getDomainBackedSites()
	console.log(`Found ${sites.length} sites with custom domains or wisp subdomains`)

	if (sites.length === 0) {
		return
	}

	const browser = await chromium.launch({
		headless: true,
	})

	const contexts: Record<ColorScheme, BrowserContext> = {
		light: await browser.newContext({
			viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
			colorScheme: 'light',
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WispSiteImageBot/1.0',
		}),
		dark: await browser.newContext({
			viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
			colorScheme: 'dark',
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WispSiteImageBot/1.0',
		}),
	}

	const results = {
		success: 0,
		failed: 0,
		errors: [] as Array<{ site: string; error: string }>,
	}

	for (let i = 0; i < sites.length; i += CONCURRENCY) {
		const batch = sites.slice(i, i + CONCURRENCY)
		const batchNum = Math.floor(i / CONCURRENCY) + 1
		const totalBatches = Math.ceil(sites.length / CONCURRENCY)

		console.log(`Batch ${batchNum}/${totalBatches}: ${batch.length} sites × 2 schemes`)

		const batchResults = await Promise.all(
			batch.flatMap((site, index) =>
				COLOR_SCHEMES.map(async (scheme) => {
					const page = await contexts[scheme].newPage()
					const globalIndex = i + index + 1
					console.log(`  [${globalIndex}/${sites.length}] ${site.url} (${site.domainType}, ${scheme})`)

					const result = await screenshotSite(page, site, scheme)
					await page.close()

					return { site, scheme, result }
				}),
			),
		)

		for (const { site, scheme, result } of batchResults) {
			if (result.success) {
				results.success++
				continue
			}

			results.failed++
			results.errors.push({
				site: `${site.did}/${site.rkey} (${site.domain}, ${scheme})`,
				error: result.error || 'Unknown error',
			})
		}
	}

	await browser.close()

	console.log(`Successful: ${results.success}`)
	console.log(`Failed: ${results.failed}`)

	if (results.errors.length > 0) {
		console.log('Failed sites:')
		for (const { site, error } of results.errors) {
			console.log(`  - ${site}: ${error}`)
		}
	}
}

main().catch((error) => {
	console.error('Fatal error:', error)
	process.exit(1)
})
