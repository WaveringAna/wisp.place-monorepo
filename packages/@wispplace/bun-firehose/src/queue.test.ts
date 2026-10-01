import { describe, expect, test } from 'bun:test'
import { encode } from '@atproto/lex-cbor'
import { MessageQueue } from './queue'
import { decodeFrame } from './subscription'

describe('MessageQueue', () => {
	test('preserves fifo ordering across compaction', () => {
		const queue = new MessageQueue<number>()
		for (let i = 0; i < 3_000; i++) queue.push(i)
		for (let i = 0; i < 1_500; i++) expect(queue.shift()).toBe(i)
		for (let i = 3_000; i < 4_000; i++) queue.push(i)
		for (let i = 1_500; i < 4_000; i++) expect(queue.shift()).toBe(i)
		expect(queue.length).toBe(0)
		expect(queue.shift()).toBeUndefined()
	})

	test('reports only pending frames', () => {
		const queue = new MessageQueue<string>()
		queue.push('a')
		queue.push('b')
		expect(queue.length).toBe(2)
		expect(queue.shift()).toBe('a')
		expect(queue.length).toBe(1)
		expect(queue.shift()).toBe('b')
		expect(queue.length).toBe(0)
	})
})

describe('decodeFrame', () => {
	test('requires both a header and a body', () => {
		expect(() => decodeFrame(new Uint8Array())).toThrow()
		expect(() => decodeFrame(encode({ op: 1 }))).toThrow('Invalid frame: missing header or body')
	})

	test('decodes header and body without dropping trailing valid values', () => {
		const header = encode({ op: 1, t: '#commit' })
		const body = encode({ seq: 42 })
		const trailing = encode('extra')
		const bytes = new Uint8Array(header.length + body.length + trailing.length)
		bytes.set(header)
		bytes.set(body, header.length)
		bytes.set(trailing, header.length + body.length)
		expect(decodeFrame(bytes)).toEqual({ header: { op: 1, t: '#commit' }, body: { seq: 42 } })
	})

	test('rejects malformed trailing cbor', () => {
		const header = encode({ op: 1 })
		const body = encode({ seq: 42 })
		const bytes = new Uint8Array(header.length + body.length + 1)
		bytes.set(header)
		bytes.set(body, header.length)
		bytes[bytes.length - 1] = 0xff
		expect(() => decodeFrame(bytes)).toThrow()
	})
})
