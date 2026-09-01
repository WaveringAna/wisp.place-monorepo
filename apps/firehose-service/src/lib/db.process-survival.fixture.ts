/**
 * Process-survival fixture for the site-write lock session lifecycle.
 *
 * Runs the real postgres.js driver against a scripted fake PostgreSQL server
 * through the real SiteWriteLockPool/withReservedSiteWriteLock wrapper. The
 * parent test spawns this file with Bun and asserts a clean exit; before the
 * postgres.js patch, a proxy-style session kill made the next wrapper query
 * throw inside a `setImmediate` write callback and took down the process.
 *
 * Usage: bun db.process-survival.fixture.ts <happy|haproxy-kill|abort>
 */
import net from 'node:net'
import postgres from 'postgres'
import {
	LOCK_POOL_RETIRE_TIMEOUT_SECONDS,
	SiteWriteLockPool,
	type SiteWriteLockPoolClient,
	withReservedSiteWriteLock,
} from './db'

process.on('uncaughtException', (error) => {
	process.stdout.write(`UNCAUGHT ${String(error)}\n`)
	process.exit(3)
})
process.on('unhandledRejection', (reason) => {
	process.stdout.write(`UNHANDLED ${String(reason)}\n`)
	process.exit(4)
})

const scenario = process.argv[2] ?? 'happy'
if (!['happy', 'haproxy-kill', 'abort'].includes(scenario)) {
	process.stdout.write(`UNKNOWN-SCENARIO ${scenario}\n`)
	process.exit(5)
}

const i32 = (n: number) => {
	const b = Buffer.alloc(4)
	b.writeInt32BE(n)
	return b
}
const msg = (type: string, payload: Buffer = Buffer.alloc(0)) =>
	Buffer.concat([Buffer.from(type), i32(payload.length + 4), payload])
const startup = Buffer.concat([
	msg('R', i32(0)),
	msg('K', Buffer.concat([i32(1234), i32(5678)])),
	msg('S', Buffer.concat([Buffer.from('server_version\0'), Buffer.from('16.0\0')])),
	msg('Z', Buffer.from('I')),
])
const dataRowTrue = msg('D', Buffer.concat([i16(1), i32(1), Buffer.from('t')]))
function i16(n: number) {
	const b = Buffer.alloc(2)
	b.writeInt16BE(n)
	return b
}
const queryPlain = Buffer.concat([
	msg('1'),
	msg('2'),
	msg('n'),
	msg('C', Buffer.from('SELECT 0\0')),
	msg('Z', Buffer.from('I')),
])
const queryTrue = Buffer.concat([
	msg('1'),
	msg('2'),
	msg('n'),
	dataRowTrue,
	msg('C', Buffer.from('SELECT 0\0')),
	msg('Z', Buffer.from('I')),
])

let mainSocket: net.Socket | null = null
const server = net.createServer((socket) => {
	let first = true
	let queries = 0
	socket.on('error', () => {})
	socket.on('data', (data) => {
		const text = data.toString('latin1')
		if (first) {
			first = false
			if ((data as Buffer).readInt32BE(4) === 80877102) {
				// CancelRequest: acknowledge and close the cancel connection.
				socket.end()
				return
			}
			mainSocket = socket
			socket.write(startup)
			return
		}
		queries++
		if (queries === 1) {
			socket.write(queryPlain) // fetch_types
			return
		}
		if (scenario === 'abort' && text.includes('pg_advisory_lock')) {
			// Hold the lock query; the cancel request closes its connection above.
			return
		}
		if (scenario === 'haproxy-kill' && text.includes('pg_advisory_lock')) {
			// Grant the lock, then idle-kill the session like the 60s proxy.
			socket.write(queryTrue)
			setTimeout(() => {
				try {
					socket.destroy()
				} catch {}
			}, 15)
			return
		}
		if (text.includes('SELECT 1')) {
			socket.write(queryTrue)
			return
		}
		socket.write(queryTrue)
	})
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as net.AddressInfo).port

const createFakeServerClient = (): SiteWriteLockPoolClient =>
	postgres(`postgres://u:p@127.0.0.1:${port}/d`, {
		max: 1,
		idle_timeout: 0,
		max_lifetime: null,
		connect_timeout: 2,
	}) as unknown as SiteWriteLockPoolClient

const pool = new SiteWriteLockPool({ size: 1, createClient: () => createFakeServerClient() })
const heartbeat = { intervalMs: 10, timeoutMs: 300 }

try {
	if (scenario === 'abort') {
		const controller = new AbortController()
		const processing = (async () => {
			const conn = await pool.reserve(controller.signal)
			return await withReservedSiteWriteLock(
				conn,
				'did:plc:fixture',
				'site',
				async () => 'never',
				controller.signal,
				heartbeat,
			)
		})()
		setTimeout(() => controller.abort(new Error('fixture abort')), 20)
		await processing.then(
			() => process.stdout.write('UNEXPECTED-SUCCESS\n'),
			(error) => process.stdout.write(`ACQUISITION-ERROR ${String(error).slice(0, 60)}\n`),
		)
	} else {
		const conn = await pool.reserve()
		const outcome = await withReservedSiteWriteLock(
			conn,
			'did:plc:fixture',
			'site',
			async (signal) => {
				if (scenario === 'haproxy-kill') {
					return await new Promise<string>((resolve, reject) => {
						if (signal.aborted) reject(new Error('fenced'))
						else signal.addEventListener('abort', () => reject(new Error('fenced')), { once: true })
						setTimeout(() => resolve('download-finished'), 4000)
					})
				}
				await new Promise((resolve) => setTimeout(resolve, 40))
				return 'written'
			},
			undefined,
			heartbeat,
		).then(
			(value) => `CALLBACK-OK ${value}`,
			(error) => `CALLBACK-ERROR ${String(error).slice(0, 80)}`,
		)
		process.stdout.write(`${outcome}\n`)
		if (scenario === 'haproxy-kill') process.stdout.write('LOST-DETECTED\n')
	}
} catch (error) {
	process.stdout.write(`FIXTURE-ERROR ${String(error).slice(0, 80)}\n`)
} finally {
	await pool.end({ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS + 1 })
}

const leftover = mainSocket as net.Socket | null
if (leftover) {
	try {
		leftover.destroy()
	} catch {}
}
await new Promise<void>((resolve) => server.close(() => resolve()))
process.stdout.write('SURVIVED\n')
process.exit(0)
