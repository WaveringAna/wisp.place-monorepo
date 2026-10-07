/**
 * Counts the full-bucket storage-stat scans (S3 ListObjectsV2 requests) one
 * firehose worker makes. The worker runs against a fake S3 and, as `standby`,
 * against a fake leadership supervisor that never grants authority; as
 * `single`, it runs without leader election, so it is the active worker.
 *
 *   bun scripts/storage-stats-scans.ts [standby|single] [holdMs=3000]
 *
 * A refresh scans once when started and then hourly, so the scans in the
 * first seconds are the scans per hour. Needs no database, Redis or relay.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type WorkerRole = 'standby' | 'single'

export interface StorageStatsScanCount {
	role: WorkerRole
	holdMs: number
	listObjectsRequests: number
	health: { readiness?: string; storage?: Record<string, unknown> }
}

const EMPTY_LISTING =
	'<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
	'<Name>bench</Name><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>'

/** Answers on stdin's behalf like a supervisor which stays in standby until the worker exits. */
const STANDBY_SUPERVISOR = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ version: 1, type: 'state', state: 'standby', pid: process.pid }) + '\\n')
for await (const _ of process.stdin) {}
`

function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() })
	const port = probe.port
	probe.stop(true)
	if (port === undefined) throw new Error('no free port')
	return port
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const ok = await fetch(url).then(
			() => true,
			() => false,
		)
		if (ok) return
		await Bun.sleep(50)
	}
	throw new Error('firehose worker health endpoint did not come up')
}

export async function countStorageStatsScans(role: WorkerRole, holdMs = 3_000): Promise<StorageStatsScanCount> {
	let listObjectsRequests = 0
	const s3 = Bun.serve({
		port: 0,
		fetch(req) {
			if (new URL(req.url).searchParams.get('list-type') === '2') {
				listObjectsRequests++
				return new Response(EMPTY_LISTING, { headers: { 'content-type': 'application/xml' } })
			}
			return new Response(null, { status: 200 })
		},
	})
	const dir = await mkdtemp(join(tmpdir(), 'firehose-storage-scans-'))
	const supervisorPath = join(dir, 'standby-supervisor')
	await writeFile(supervisorPath, STANDBY_SUPERVISOR)
	await chmod(supervisorPath, 0o755)

	const healthPort = freePort()
	const worker = Bun.spawn(['bun', join(import.meta.dir, '../src/index.ts')], {
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			NODE_ENV: 'test',
			HEALTH_PORT: String(healthPort),
			S3_BUCKET: 'bench',
			S3_ENDPOINT: `http://127.0.0.1:${s3.port}`,
			AWS_ACCESS_KEY_ID: 'bench',
			AWS_SECRET_ACCESS_KEY: 'bench',
			// Nothing listens here: an active worker just keeps reconnecting.
			FIREHOSE_SERVICE: 'ws://127.0.0.1:9',
			LEADERSHIP_SUPERVISOR_ENABLED: role === 'standby' ? 'true' : 'false',
			FIREHOSE_SUPERVISOR_PATH: supervisorPath,
		},
		stdout: 'ignore',
		stderr: 'ignore',
	})
	try {
		const healthUrl = `http://127.0.0.1:${healthPort}/health`
		await waitForHealth(healthUrl, 15_000)
		await Bun.sleep(holdMs)
		const health = (await (await fetch(healthUrl)).json()) as StorageStatsScanCount['health']
		return { role, holdMs, listObjectsRequests, health }
	} finally {
		worker.kill('SIGKILL')
		await worker.exited
		s3.stop(true)
		await rm(dir, { recursive: true, force: true })
	}
}

if (import.meta.main) {
	const role = (process.argv[2] ?? 'standby') as WorkerRole
	if (role !== 'standby' && role !== 'single') throw new Error('role must be standby or single')
	const result = await countStorageStatsScans(role, Number(process.argv[3] ?? 3_000))
	console.log(
		JSON.stringify({ ...result, health: { readiness: result.health.readiness, storage: result.health.storage } }),
	)
}
