/**
 * Feeds frames to BunSubscription faster than its consumer handles them, like a
 * relay replaying a backlog to a slow leader. Reports peak memory and proves
 * every sequence number reaches the consumer once, in order. Each frame costs
 * the consumer `workUs` of CPU plus one event-loop turn, as a handler awaiting
 * I/O does.
 *
 *   bun bench/backpressure.ts [frames=100000] [frameBytes=1024] [workUs=50]
 *
 * The relay runs in a child process so its send buffers are not measured.
 */
import { encode } from '@atproto/lex-cbor'
import { MessageQueue } from '../src/queue'
import { BunSubscription } from '../src/subscription'

const [mode, ...rest] = process.argv.slice(2)

if (mode === '--relay') serveRelay(Number(rest[0]), Number(rest[1]))
else await consume(Number(mode ?? 100_000), Number(rest[0] ?? 1024), Number(rest[1] ?? 50))

/** A relay that replays `frames` sequence numbers after the requested cursor as fast as the socket accepts them. */
function serveRelay(frames: number, frameBytes: number): void {
	const header = encode({ op: 1, t: '#frame' })
	const pad = new Uint8Array(frameBytes)
	const frame = (seq: number) => {
		const body = encode({ seq, pad })
		const bytes = new Uint8Array(header.length + body.length)
		bytes.set(header)
		bytes.set(body, header.length)
		return bytes
	}
	type Stream = { next: number; open: boolean }
	const pump = (ws: Bun.ServerWebSocket<Stream>) => {
		while (ws.data.open && ws.data.next <= frames) {
			if (ws.send(frame(ws.data.next++)) === -1) return
		}
	}
	const server = Bun.serve<Stream>({
		port: 0,
		fetch(req, srv) {
			const cursor = Number(new URL(req.url).searchParams.get('cursor') ?? 0)
			return srv.upgrade(req, { data: { next: cursor + 1, open: true } })
				? undefined
				: new Response('no', { status: 400 })
		},
		websocket: {
			open: pump,
			drain: pump,
			close(ws) {
				ws.data.open = false
			},
			message() {},
		},
	})
	console.log(server.port)
}

async function consume(frames: number, frameBytes: number, workUs: number): Promise<void> {
	const relay = Bun.spawn(['bun', import.meta.path, '--relay', String(frames), String(frameBytes)], { stdout: 'pipe' })
	const port = (await new Response(relay.stdout).body!.getReader().read()).value
	const url = `ws://127.0.0.1:${new TextDecoder().decode(port).trim()}`

	Bun.gc(true)
	const baseline = process.memoryUsage()
	let peakRss = baseline.rss
	let peakHeap = baseline.heapUsed
	const sampler = setInterval(() => {
		const usage = process.memoryUsage()
		peakRss = Math.max(peakRss, usage.rss)
		peakHeap = Math.max(peakHeap, usage.heapUsed)
	}, 10)

	// Observe the subscription's frame queue without changing it.
	let peakQueued = 0
	const push = MessageQueue.prototype.push
	MessageQueue.prototype.push = function (this: MessageQueue<unknown>, item: unknown) {
		push.call(this, item)
		peakQueued = Math.max(peakQueued, this.length)
	}

	let last = 0
	let delivered = 0
	let duplicates = 0
	let gaps = 0
	let connects = 0
	const abort = new AbortController()
	const subscription = new BunSubscription<{ seq: number }>({
		service: url,
		method: 'bench.subscribe',
		signal: abort.signal,
		maxReconnectSeconds: 1,
		validate: (body) => body as { seq: number },
		// The consumer's committed cursor: everything up to `last` was handled.
		getParams: () => (last > 0 ? { cursor: last } : {}),
		onConnect: () => connects++,
	})

	const started = performance.now()
	for await (const { seq } of subscription) {
		delivered++
		if (seq <= last) duplicates++
		else if (seq !== last + 1) gaps++
		last = Math.max(last, seq)
		const until = performance.now() + workUs / 1000
		while (performance.now() < until) {}
		// Like a handler awaiting I/O: lets the socket deliver more frames meanwhile.
		await new Promise((resolve) => setImmediate(resolve))
		if (last === frames) break
	}
	const seconds = (performance.now() - started) / 1000
	clearInterval(sampler)
	abort.abort()
	relay.kill()

	const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
	console.log(
		JSON.stringify({
			frames,
			frameBytes,
			workUs,
			delivered,
			lastSeq: last,
			gaps,
			duplicates,
			connects,
			seconds: Number(seconds.toFixed(2)),
			peakQueuedFrames: peakQueued,
			peakRssGrowth: mib(peakRss - baseline.rss),
			peakHeapGrowth: mib(peakHeap - baseline.heapUsed),
		}),
	)
	process.exit(gaps === 0 && last === frames ? 0 : 1)
}
