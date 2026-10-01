import { MessageQueue } from '../src/queue'

const count = Number(process.argv[2] ?? 100_000)
const pending = Number(process.argv[3] ?? 20_000)

function measure(name: string, run: () => void): number {
	const start = performance.now()
	run()
	const elapsed = performance.now() - start
	console.log(`${name}: ${elapsed.toFixed(2)} ms`)
	return elapsed
}

measure('baseline Array#shift', () => {
	const queue: number[] = []
	for (let i = 0; i < pending; i++) queue.push(i)
	for (let i = pending; i < pending + count; i++) {
		queue.push(i)
		queue.shift()
	}
})
measure('MessageQueue cursor', () => {
	const queue = new MessageQueue<number>()
	for (let i = 0; i < pending; i++) queue.push(i)
	for (let i = pending; i < pending + count; i++) {
		queue.push(i)
		queue.shift()
	}
})
