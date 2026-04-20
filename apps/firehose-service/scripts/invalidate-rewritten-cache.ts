#!/usr/bin/env bun
/**
 * Per-site rewrite-cache reset: invalidate `<did>/<rkey>/.rewritten/*` in S3
 * and enqueue a `rewrite-miss` revalidate event so the worker regenerates
 * the pre-rewritten HTML from source.
 *
 * Why: earlier versions of the HTML rewriter used `node-html-parser`, which
 * parsed + re-serialised each cached `index.html` and corrupted content with
 * unbalanced or HTML-looking text (Markdown-in-HTML, custom elements, etc).
 * The current rewriter uses Bun's streaming `HTMLRewriter` and is byte-safe —
 * but the old corrupted copies remain cached under `<did>/<rkey>/.rewritten/…`.
 *
 * Usage:
 *   bun apps/firehose-service/scripts/invalidate-rewritten-cache.ts <did> <rkey>
 *
 *   # Batch from stdin (one `did/rkey` pair per line):
 *   cat sites.txt | bun apps/firehose-service/scripts/invalidate-rewritten-cache.ts --stdin
 */

import { S3StorageTier } from '@wispplace/tiered-storage'
import Redis from 'ioredis'
import { config } from '../src/config'

const REASON = 'rewrite-miss:manual'
const BATCH_SIZE = 1000
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const positional = args.filter((a) => !a.startsWith('--'))
const fromStdin = flags.has('--stdin')

if (!config.s3Bucket) {
	console.error('[invalidate] S3_BUCKET not set')
	process.exit(1)
}
if (!config.redisUrl) {
	console.error('[invalidate] REDIS_URL not set')
	process.exit(1)
}

const tier = new S3StorageTier({
	bucket: config.s3Bucket,
	region: config.s3Region,
	endpoint: config.s3Endpoint,
	credentials:
		config.awsAccessKeyId && config.awsSecretAccessKey
			? { accessKeyId: config.awsAccessKeyId, secretAccessKey: config.awsSecretAccessKey }
			: undefined,
	prefix: config.s3Prefix,
	forcePathStyle: config.s3ForcePathStyle,
})

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 })
redis.on('error', (err) => console.error('[invalidate] redis error:', err.message))

const log = (msg: string) => process.stderr.write(`[invalidate] ${msg}\n`)

async function resetSite(did: string, rkey: string): Promise<void> {
	const prefix = `${did}/${rkey}/.rewritten/`
	let batch: string[] = []
	let deleted = 0

	for await (const key of tier.listKeys(prefix)) {
		batch.push(key)
		if (batch.length >= BATCH_SIZE) {
			await tier.deleteMany(batch)
			deleted += batch.length
			batch = []
		}
	}
	if (batch.length) {
		await tier.deleteMany(batch)
		deleted += batch.length
	}

	await redis.del(`revalidate:site:rewrite-miss:${did}:${rkey}`)
	const id = await redis.xadd(
		config.revalidateStream,
		'*',
		'did',
		did,
		'rkey',
		rkey,
		'reason',
		REASON,
		'ts',
		Date.now().toString(),
	)

	log(`${did}/${rkey}: deleted ${deleted} objects, enqueued ${id}`)
	process.stdout.write(`${did}/${rkey}\n`)
}

function parsePair(input: string): [string, string] | null {
	const trimmed = input.trim()
	if (!trimmed) return null
	const slash = trimmed.indexOf('/')
	if (slash === -1) return null
	const did = trimmed.slice(0, slash)
	const rkey = trimmed.slice(slash + 1)
	if (!did || !rkey) return null
	return [did, rkey]
}

log(`Bucket: ${config.s3Bucket}  stream: ${config.revalidateStream}  reason: ${REASON}`)

let sites = 0
try {
	if (fromStdin) {
		const reader = Bun.stdin.stream().getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
				const line = buffer.slice(0, nl)
				buffer = buffer.slice(nl + 1)
				const pair = parsePair(line)
				if (!pair) continue
				await resetSite(pair[0], pair[1])
				sites++
			}
		}
		const pair = parsePair(buffer)
		if (pair) {
			await resetSite(pair[0], pair[1])
			sites++
		}
	} else {
		if (positional.length < 2) {
			console.error('Usage: invalidate-rewritten-cache.ts <did> <rkey>')
			console.error('   or: ... --stdin  (read `did/rkey` pairs from stdin)')
			process.exit(1)
		}
		const [did, rkey] = positional
		await resetSite(did, rkey)
		sites++
	}
	log(`Done. Reset ${sites} site(s).`)
} finally {
	await redis.quit()
}
