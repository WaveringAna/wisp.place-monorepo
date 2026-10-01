/**
 * FIFO storage for websocket frames. Consumed slots are cleared immediately;
 * periodic compaction bounds the backing buffer to pending entries plus a small
 * amount of slack.
 */
export class MessageQueue<T> {
	private readonly items: (T | undefined)[] = []
	private head = 0

	get length(): number {
		return this.items.length - this.head
	}

	push(item: T): void {
		this.items.push(item)
	}

	shift(): T | undefined {
		if (this.head === this.items.length) return undefined
		const item = this.items[this.head]
		this.items[this.head++] = undefined
		if (this.head === this.items.length) {
			this.items.length = 0
			this.head = 0
		} else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
			this.items.splice(0, this.head)
			this.head = 0
		}
		return item
	}
}
