/**
 * Example HTTP server serving static sites from tiered storage
 *
 * This demonstrates a real-world use case: serving static websites
 * with automatic caching across hot (memory), warm (disk), and cold (S3) tiers.
 *
 * Run with: bun run serve
 */

import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { lookup } from 'mime-types'
import { DiskStorageTier, MemoryStorageTier, S3StorageTier, TieredStorage } from './src/index.js'

const S3_BUCKET = process.env.S3_BUCKET || 'tiered-storage-example'
const S3_METADATA_BUCKET = process.env.S3_METADATA_BUCKET
const S3_REGION = process.env.S3_REGION || 'us-east-1'
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== 'false'
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY
const PORT = parseInt(process.env.PORT || '3000', 10)

const storage = new TieredStorage({
	tiers: {
		hot: new MemoryStorageTier({
			maxSizeBytes: 50 * 1024 * 1024,
			maxItems: 500,
		}),
		warm: new DiskStorageTier({
			directory: './cache/sites',
			maxSizeBytes: 1024 * 1024 * 1024,
		}),
		cold: new S3StorageTier({
			bucket: S3_BUCKET,
			region: S3_REGION,
			endpoint: S3_ENDPOINT,
			forcePathStyle: S3_FORCE_PATH_STYLE,
			credentials:
				AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
					? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
					: undefined,
			prefix: 'demo-sites/',
		}),
	},
	placementRules: [
		// index.html goes to all tiers for instant serving
		{ pattern: '**/index.html', tiers: ['hot', 'warm', 'cold'] },

		// everything else: warm + cold only
		{ pattern: '**', tiers: ['warm', 'cold'] },
	],
	compression: true,
	defaultTTL: 14 * 24 * 60 * 60 * 1000,
	promotionStrategy: 'lazy',
})

const app = new Hono()

// Site metadata
const siteId = 'did:plc:example123'
const siteName = 'tiered-cache-demo'

/**
 * Load the example site into storage
 */
async function loadExampleSite() {
	console.log('\n📦 Loading example site into tiered storage...\n')

	const files = [
		{ name: 'index.html', mimeType: 'text/html' },
		{ name: 'about.html', mimeType: 'text/html' },
		{ name: 'docs.html', mimeType: 'text/html' },
		{ name: 'style.css', mimeType: 'text/css' },
		{ name: 'script.js', mimeType: 'application/javascript' },
	]

	for (const file of files) {
		const content = await readFile(`./example-site/${file.name}`, 'utf-8')
		const key = `${siteId}/${siteName}/${file.name}`

		await storage.set(key, content, {
			metadata: { mimeType: file.mimeType },
		})

		// Determine which tiers this file went to based on placement rules
		const isIndex = file.name === 'index.html'
		const tierInfo = isIndex ? '🔥 hot + 💾 warm + ☁️  cold' : '💾 warm + ☁️  cold (skipped hot)'
		const sizeKB = (content.length / 1024).toFixed(2)
		console.log(`   ✓ ${file.name.padEnd(15)} ${sizeKB.padStart(6)} KB → ${tierInfo}`)
	}

	console.log('\n✅ Site loaded successfully!\n')
}

/**
 * Serve a file from tiered storage
 */
app.get('/sites/:did/:siteName/:path{.*}', async (c) => {
	const { did, siteName, path } = c.req.param()
	let filePath = path || 'index.html'

	if (filePath === '' || filePath.endsWith('/')) {
		filePath += 'index.html'
	}

	const key = `${did}/${siteName}/${filePath}`

	try {
		const result = await storage.getWithMetadata(key)

		if (!result) {
			return c.text('404 Not Found', 404)
		}

		const mimeType = result.metadata.customMetadata?.mimeType || lookup(filePath) || 'application/octet-stream'

		const headers: Record<string, string> = {
			'Content-Type': mimeType,
			'X-Cache-Tier': result.source, // Which tier served this
			'X-Cache-Size': result.metadata.size.toString(),
			'X-Cache-Compressed': result.metadata.compressed.toString(),
			'X-Cache-Access-Count': result.metadata.accessCount.toString(),
		}

		// Add cache control based on tier
		if (result.source === 'hot') {
			headers['X-Cache-Status'] = 'HIT-MEMORY'
		} else if (result.source === 'warm') {
			headers['X-Cache-Status'] = 'HIT-DISK'
		} else {
			headers['X-Cache-Status'] = 'HIT-S3'
		}

		const emoji = result.source === 'hot' ? '🔥' : result.source === 'warm' ? '💾' : '☁️'
		console.log(
			`${emoji} ${filePath.padEnd(20)} served from ${result.source.padEnd(4)} (${(result.metadata.size / 1024).toFixed(2)} KB, access #${result.metadata.accessCount})`,
		)

		return c.body(result.data as any, 200, headers)
	} catch (error: any) {
		console.error(`❌ Error serving ${filePath}:`, error.message)
		return c.text('500 Internal Server Error', 500)
	}
})

/**
 * Admin endpoint: Cache statistics
 */
app.get('/admin/stats', async (c) => {
	const stats = await storage.getStats()

	const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Tiered Storage Statistics</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f172a;
            color: #f1f5f9;
            padding: 2rem;
            line-height: 1.6;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 {
            font-size: 2rem;
            margin-bottom: 0.5rem;
            background: linear-gradient(135deg, #3b82f6, #8b5cf6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .subtitle { color: #94a3b8; margin-bottom: 2rem; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
        .card {
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 0.5rem;
            padding: 1.5rem;
        }
        .tier-hot { border-left: 4px solid #ef4444; }
        .tier-warm { border-left: 4px solid #f59e0b; }
        .tier-cold { border-left: 4px solid #3b82f6; }
        .card-title {
            font-size: 1.2rem;
            font-weight: 600;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        .stat { margin-bottom: 0.75rem; }
        .stat-label { color: #94a3b8; font-size: 0.9rem; }
        .stat-value { color: #f1f5f9; font-size: 1.5rem; font-weight: 700; }
        .overall { background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(139, 92, 246, 0.1)); }
        .refresh {
            display: inline-block;
            background: #3b82f6;
            color: white;
            padding: 0.75rem 1.5rem;
            border-radius: 0.5rem;
            text-decoration: none;
            font-weight: 600;
            margin-top: 1rem;
        }
        .refresh:hover { background: #2563eb; }
        code {
            background: #334155;
            padding: 0.2rem 0.5rem;
            border-radius: 0.25rem;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 Tiered Storage Statistics</h1>
        <p class="subtitle">Real-time cache performance metrics • Auto-refresh every 5 seconds</p>

        <div class="grid">
            <div class="card tier-hot">
                <div class="card-title">🔥 Hot Tier (Memory)</div>
                <div class="stat">
                    <div class="stat-label">Items</div>
                    <div class="stat-value">${stats.hot?.items || 0}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Size</div>
                    <div class="stat-value">${((stats.hot?.bytes || 0) / 1024).toFixed(2)} KB</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Hits / Misses</div>
                    <div class="stat-value">${stats.hot?.hits || 0} / ${stats.hot?.misses || 0}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Evictions</div>
                    <div class="stat-value">${stats.hot?.evictions || 0}</div>
                </div>
            </div>

            <div class="card tier-warm">
                <div class="card-title">💾 Warm Tier (Disk)</div>
                <div class="stat">
                    <div class="stat-label">Items</div>
                    <div class="stat-value">${stats.warm?.items || 0}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Size</div>
                    <div class="stat-value">${((stats.warm?.bytes || 0) / 1024).toFixed(2)} KB</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Hits / Misses</div>
                    <div class="stat-value">${stats.warm?.hits || 0} / ${stats.warm?.misses || 0}</div>
                </div>
            </div>

            <div class="card tier-cold">
                <div class="card-title">☁️ Cold Tier (S3)</div>
                <div class="stat">
                    <div class="stat-label">Items</div>
                    <div class="stat-value">${stats.cold.items}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Size</div>
                    <div class="stat-value">${(stats.cold.bytes / 1024).toFixed(2)} KB</div>
                </div>
            </div>
        </div>

        <div class="card overall">
            <div class="card-title">📈 Overall Performance</div>
            <div class="grid" style="grid-template-columns: repeat(3, 1fr);">
                <div class="stat">
                    <div class="stat-label">Total Hits</div>
                    <div class="stat-value">${stats.totalHits}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Total Misses</div>
                    <div class="stat-value">${stats.totalMisses}</div>
                </div>
                <div class="stat">
                    <div class="stat-label">Hit Rate</div>
                    <div class="stat-value">${(stats.hitRate * 100).toFixed(1)}%</div>
                </div>
            </div>
        </div>

        <div style="margin-top: 2rem; padding: 1rem; background: #1e293b; border-radius: 0.5rem; border: 1px solid #334155;">
            <p style="margin-bottom: 0.5rem;"><strong>Try it out:</strong></p>
            <p>Visit <code>http://localhost:${PORT}/sites/${siteId}/${siteName}/</code> to see the site</p>
            <p>Watch the stats update as you browse different pages!</p>
        </div>
    </div>

    <script>
        // Auto-refresh stats every 5 seconds
        setTimeout(() => window.location.reload(), 5000);
    </script>
</body>
</html>
  `

	return c.html(html)
})

/**
 * Admin endpoint: Invalidate cache
 */
app.post('/admin/invalidate/:did/:siteName', async (c) => {
	const { did, siteName } = c.req.param()
	const prefix = `${did}/${siteName}/`
	const deleted = await storage.invalidate(prefix)

	console.log(`🗑️  Invalidated ${deleted} files for ${did}/${siteName}`)

	return c.json({ success: true, deleted, prefix })
})

/**
 * Admin endpoint: Bootstrap hot cache
 */
app.post('/admin/bootstrap/hot', async (c) => {
	const limit = parseInt(c.req.query('limit') || '100', 10)
	const loaded = await storage.bootstrapHot(limit)

	console.log(`🔥 Bootstrapped ${loaded} items into hot tier`)

	return c.json({ success: true, loaded, limit })
})

/**
 * Root redirect
 */
app.get('/', (c) => {
	return c.redirect(`/sites/${siteId}/${siteName}/`)
})

/**
 * Health check
 */
app.get('/health', (c) => c.json({ status: 'ok' }))

/**
 * Test S3 connection
 */
async function testS3Connection() {
	console.log('\n🔍 Testing S3 connection...\n')

	try {
		// Try to get stats (which lists objects)
		const stats = await storage.getStats()
		console.log(`✅ S3 connection successful!`)
		console.log(`   Found ${stats.cold.items} items (${(stats.cold.bytes / 1024).toFixed(2)} KB)\n`)
		return true
	} catch (error: any) {
		console.error('❌ S3 connection failed:', error.message)
		console.error('\nDebug Info:')
		console.error(`   Bucket: ${S3_BUCKET}`)
		console.error(`   Region: ${S3_REGION}`)
		console.error(`   Endpoint: ${S3_ENDPOINT || '(default AWS S3)'}`)
		console.error(`   Access Key: ${AWS_ACCESS_KEY_ID?.substring(0, 8)}...`)
		console.error(`   Force Path Style: ${S3_FORCE_PATH_STYLE}`)
		console.error('\nCommon issues:')
		console.error('   • Check that bucket exists')
		console.error('   • Verify credentials are correct')
		console.error('   • Ensure endpoint URL is correct')
		console.error('   • Check firewall/network access')
		console.error('   • For S3-compatible services, verify region name\n')
		return false
	}
}

/**
 * Periodic cache clearing - demonstrates tier bootstrapping
 */
function startCacheClearInterval() {
	const CLEAR_INTERVAL_MS = 60 * 1000 // 1 minute

	setInterval(async () => {
		console.log(`\n${'═'.repeat(60)}`)
		console.log('🧹 CACHE CLEAR - Clearing hot and warm tiers...')
		console.log('   (Cold tier on S3 remains intact)')
		console.log(`${'═'.repeat(60)}\n`)

		try {
			// Clear hot tier (memory)
			if ((storage as any).config.tiers.hot) {
				await (storage as any).config.tiers.hot.clear()
				console.log('✓ Hot tier (memory) cleared')
			}

			// Clear warm tier (disk)
			if ((storage as any).config.tiers.warm) {
				await (storage as any).config.tiers.warm.clear()
				console.log('✓ Warm tier (disk) cleared')
			}

			console.log('\n💡 Next request will bootstrap from S3 (cold tier)\n')
			console.log(`${'─'.repeat(60)}\n`)
		} catch (error: any) {
			console.error('❌ Error clearing cache:', error.message)
		}
	}, CLEAR_INTERVAL_MS)

	console.log(`⏰ Cache clear interval started (every ${CLEAR_INTERVAL_MS / 1000}s)\n`)
}

/**
 * Main startup
 */
async function main() {
	console.log('╔════════════════════════════════════════════════╗')
	console.log('║  Tiered Storage Demo Server                   ║')
	console.log('╚════════════════════════════════════════════════╝\n')

	console.log('Configuration:')
	console.log(`  S3 Bucket: ${S3_BUCKET}`)
	console.log(`  S3 Region: ${S3_REGION}`)
	console.log(`  S3 Endpoint: ${S3_ENDPOINT || '(default AWS S3)'}`)
	console.log(`  Force Path Style: ${S3_FORCE_PATH_STYLE}`)
	console.log(`  Port: ${PORT}`)

	try {
		// Test S3 connection first
		const s3Connected = await testS3Connection()
		if (!s3Connected) {
			process.exit(1)
		}

		// Load the example site
		await loadExampleSite()

		// Start periodic cache clearing
		startCacheClearInterval()

		// Start the server
		console.log('🚀 Starting server...\n')

		const _server = Bun.serve({
			port: PORT,
			fetch: app.fetch,
		})

		console.log('╔════════════════════════════════════════════════╗')
		console.log('║  Server Running!                               ║')
		console.log('╚════════════════════════════════════════════════╝\n')
		console.log(`📍 Demo Site:  http://localhost:${PORT}/sites/${siteId}/${siteName}/`)
		console.log(`📊 Statistics: http://localhost:${PORT}/admin/stats`)
		console.log(`💚 Health:     http://localhost:${PORT}/health`)
		console.log('\n🎯 Try browsing the site and watch which tier serves each file!\n')
		console.log('💡 Caches clear every 60 seconds - watch files get re-fetched from S3!\n')
		if (S3_METADATA_BUCKET) {
			console.log(`✨ Metadata bucket: ${S3_METADATA_BUCKET} (fast updates enabled!)\n`)
		} else {
			console.log('⚠️  No metadata bucket - using legacy mode (slower updates)\n')
		}
		console.log('Press Ctrl+C to stop\n')
		console.log('─'.repeat(60))
		console.log('Request Log:\n')
	} catch (error: any) {
		console.error('\n❌ Failed to start server:', error.message)
		if (error.message.includes('Forbidden')) {
			console.error('\nS3 connection issue. Check:')
			console.error('  1. Bucket exists on S3 service')
			console.error('  2. Credentials are correct')
			console.error('  3. Permissions allow read/write')
		}
		process.exit(1)
	}
}

main().catch(console.error)
