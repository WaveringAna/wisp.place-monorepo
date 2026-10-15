/**
 * Local transport throughput: one Bun.serve process streams Jetstream-sized JSON
 * text frames as fast as backpressure allows, and this process reads them with
 * JetstreamSocket and with Bun's built-in WebSocket in turn.
 *
 *   bun bench/jetstream-socket-throughput.ts [messages=2000000] [rounds=3]
 */

import { JetstreamSocket, type JetstreamSocketLike } from '../src/lib/jetstream-socket'

const SAMPLE = JSON.stringify({
	did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
	time_us: 1_760_000_000_000_000,
	kind: 'commit',
	commit: {
		rev: '3lq6x5f2abcde',
		operation: 'create',
		collection: 'app.bsky.feed.like',
		rkey: '3lq6x5f2abcde',
		record: {
			$type: 'app.bsky.feed.like',
			createdAt: '2025-10-09T12:00:00.000Z',
			subject: {
				cid: 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
				uri: 'at://did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/app.bsky.feed.post/3lq6x5f2abcdf',
			},
		},
		cid: 'bafyreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
	},
})

async function serve(messages: number): Promise<void> {
	const pump = (ws: Bun.ServerWebSocket<{ sent: number }>) => {
		while (ws.data.sent < messages) {
			ws.data.sent++
			if (ws.send(SAMPLE) === -1) return
		}
		ws.close(1000)
	}
	const server = Bun.serve<{ sent: number }>({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request, { data: { sent: 0 } })) return undefined
			return new Response('websocket only', { status: 400 })
		},
		websocket: { open: pump, drain: pump, message() {} },
	})
	console.log(server.port)
}

async function measure(
	url: string,
	open: (url: string) => JetstreamSocketLike | WebSocket,
): Promise<{ messages: number; seconds: number }> {
	const started = performance.now()
	let messages = 0
	await new Promise<void>((resolve, reject) => {
		const socket = open(url)
		socket.onmessage = (message: { data: unknown }) => {
			if (typeof message.data !== 'string') reject(new Error('expected text'))
			messages++
		}
		socket.onerror = () => reject(new Error('socket error'))
		socket.onclose = () => resolve()
	})
	return { messages, seconds: (performance.now() - started) / 1_000 }
}

if (process.argv[2] === '--serve') {
	await serve(Number(process.argv[3]))
} else {
	const messages = Number(process.argv[2] ?? 2_000_000)
	const rounds = Number(process.argv[3] ?? 3)
	const child = Bun.spawn([process.execPath, import.meta.path, '--serve', String(messages)], { stdout: 'pipe' })
	const reader = child.stdout.getReader()
	const port = new TextDecoder().decode((await reader.read()).value).trim()
	const url = `ws://127.0.0.1:${port}/subscribe`
	const transports = {
		JetstreamSocket: (target: string) => new JetstreamSocket(target),
		'Bun WebSocket': (target: string) => new WebSocket(target),
	}
	console.log(`${messages} messages of ${Buffer.byteLength(SAMPLE)} bytes per round`)
	for (let round = 1; round <= rounds; round++) {
		for (const [name, open] of Object.entries(transports)) {
			const result = await measure(url, open)
			const rate = Math.round(result.messages / result.seconds)
			console.log(
				`round ${round} ${name.padEnd(15)} ${rate.toLocaleString()} msg/s (${result.messages} in ${result.seconds.toFixed(2)} s)`,
			)
		}
	}
	child.kill()
}
