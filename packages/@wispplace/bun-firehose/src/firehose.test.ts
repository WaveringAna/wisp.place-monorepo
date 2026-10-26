import { describe, expect, test } from 'bun:test'
import type { IdResolver } from '@atproto/identity'
import { encode } from '@atproto/lex-cbor'
import { CID } from 'multiformats/cid'
import { BunFirehose, type CommitEvt, type Event } from './firehose'

// A signed two-record repository CAR, generated with Repo.formatInitCommit and Secp256k1Keypair.
const fixture = {
	did: 'did:key:zQ3shnQxWd3WH45whNUzJCAQkSTAf1wtGSZQ1SEYEMKgNu4d9',
	commit: 'bafyreib5qusmitlmqh4dkopj4jackiug4dj5djawygy63trkgoym7f76um',
	rev: '3mygpn6tcjk2d',
	cid: 'bafyreicafg4sqyuy3q5xzu6ibxugc3ydjjzkx7d4vpjf7e3nm3ixkzxuoi',
	car: 'OqJlcm9vdHOB2CpYJQABcRIgPYUkxE1sgfg1OeniQCUihuDT0aQWwbHtziozsM+X/qNndmVyc2lvbgFcAXESIEApuShimNw7fNPIDehhbwNKcqv8fKvSX5NtZtF1ZvRyo2UkdHlwZXNwbGFjZS53aXNwLnNldHRpbmdzaWNsZWFuVXJsc/VwZGlyZWN0b3J5TGlzdGluZ/WfAQFxEiBbhArn9cwwnThWp7WIbs+V8Di0YQw/df9HbDw2HjhABqJhZYGkYWtXcGxhY2Uud2lzcC5zZXR0aW5ncy9vbmVhcABhdNgqWCUAAXESIEQo16zEy7OJDZ88IcU5cRwvMLZXD/rQJDI7jAMHjU45YXbYKlglAAFxEiBAKbkoYpjcO3zTyA3oYW8DSnKr/Hyr0l+TbWbRdWb0cmFs9ncBcRIgRCjXrMTLs4kNnzwhxTlxHC8wtlcP+tAkMjuMAweNTjmiYWWBpGFrV3BsYWNlLndpc3Auc2V0dGluZ3MvdHdvYXAAYXT2YXbYKlglAAFxEiBAKbkoYpjcO3zTyA3oYW8DSnKr/Hyr0l+TbWbRdWb0cmFs9vkBAXESID2FJMRNbIH4NTnp4kAlIobg09GkFsGx7c4qM7DPl/6jpmNkaWR4OWRpZDprZXk6elEzc2huUXhXZDNXSDQ1d2hOVXpKQ0FRa1NUQWYxd3RHU1pRMVNFWUVNS2dOdTRkOWNyZXZtM215Z3BuNnRjamsyZGNzaWdYQEqrwrArlTdbEUQr13INDCMMIx1+gE9++HhK7jp9dFfdSp1Wg/eWKbc/TXwBQBQXVllMNYkHsYe9kax1TvBlR3dkZGF0YdgqWCUAAXESIFuECuf1zDCdOFantYhuz5XwOLRhDD91/0dsPDYeOEAGZHByZXb2Z3ZlcnNpb24D',
}
function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
function frame(type: string, body: object) {
	const header = encode({ op: 1, t: type })
	const data = encode(body)
	return new Uint8Array([...header, ...data])
}
function commit(seq: number, poison: false | 'cbor' | 'car' | 'proof' = false) {
	return frame('#commit', {
		seq,
		repo: fixture.did,
		commit: CID.parse(fixture.commit),
		rev: fixture.rev,
		rebase: false,
		tooBig: false,
		since: null,
		blobs: [],
		time: new Date(0).toISOString(),
		blocks: poison === 'car' ? new Uint8Array() : new Uint8Array(Buffer.from(fixture.car, 'base64')),
		ops: ['one', 'two'].map((rkey) => ({
			action: 'create',
			path: `place.wisp.settings/${poison === 'proof' ? 'absent' : rkey}`,
			cid: CID.parse(fixture.cid),
		})),
	})
}
function relay(poison: false | 'cbor' | 'car' | 'proof' = false) {
	const cursors: Array<string | null> = []
	const server = Bun.serve<{ cursor: number }>({
		port: 0,
		fetch(req, srv) {
			const cursor = new URL(req.url).searchParams.get('cursor')
			cursors.push(cursor)
			return srv.upgrade(req, { data: { cursor: Number(cursor ?? 0) } }) ? undefined : new Response('no')
		},
		websocket: {
			open(ws) {
				if (ws.data.cursor < 10)
					ws.send(frame('#identity', { seq: 10, did: fixture.did, time: new Date(0).toISOString() }))
				if (ws.data.cursor < 11) ws.send(poison === 'cbor' ? new Uint8Array([0xff]) : commit(11, poison))
				if (ws.data.cursor < 12)
					ws.send(frame('#identity', { seq: 12, did: fixture.did, time: new Date(0).toISOString() }))
			},
			message() {},
		},
	})
	return { cursors, url: `ws://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}
function resolver(resolveAtprotoKey: () => Promise<string>) {
	return { did: { resolveAtprotoKey } } as unknown as IdResolver
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('BunFirehose pre-dispatch ownership', () => {
	test('a transient DID failure blocks the next frame and replays from the safe cursor', async () => {
		const server = relay()
		const failed = deferred()
		const recovered = deferred()
		const seen: number[] = []
		let attempts = 0
		let cursor = 9
		const firehose = new BunFirehose({
			service: server.url,
			getCursor: () => cursor,
			idResolver: resolver(async () => {
				if (++attempts === 1) throw new Error('DID unavailable')
				return fixture.did
			}),
			onError: () => failed.resolve(),
			handleEvent: (event) => {
				seen.push(event.seq)
				cursor = event.seq
				if (event.seq === 12) recovered.resolve()
			},
		})
		const running = firehose.start()
		try {
			await failed.promise
			await pause(50)
			expect(seen).toEqual([10])
			expect(cursor).toBe(10)
			await Promise.race([
				recovered.promise,
				pause(4000).then(() => {
					throw new Error('replay timed out')
				}),
			])
			expect(server.cursors.slice(0, 2)).toEqual(['9', '10'])
			expect(seen.filter((seq) => seq === 11)).toHaveLength(2)
			expect(seen[seen.length - 1]).toBe(12)
		} finally {
			await firehose.destroy()
			await running
			server.stop()
		}
	}, 8000)

	test('malformed poison frames block all later delivery instead of being skipped', async () => {
		const server = relay('cbor')
		const failed = deferred()
		const replayedFailure = deferred()
		const seen: number[] = []
		const errors: Error[] = []
		const firehose = new BunFirehose({
			service: server.url,
			getCursor: () => 9,
			idResolver: resolver(async () => fixture.did),
			onError: (error) => {
				errors.push(error)
				failed.resolve()
				if (errors.length === 2) replayedFailure.resolve()
			},
			handleEvent: (event) => {
				seen.push(event.seq)
			},
		})
		const running = firehose.start()
		try {
			await Promise.race([failed.promise, pause(500).then(() => {})])
			expect(errors.length).toBeGreaterThan(0)
			expect(seen).toEqual([10])
			await replayedFailure.promise
			expect(server.cursors).toEqual(['9', '9'])
			expect(seen).toEqual([10, 10])
		} finally {
			await firehose.destroy()
			await running
			server.stop()
		}
	})

	test('destroy joins an in-flight DID lookup and never dispatches its result', async () => {
		const server = relay()
		const entered = deferred()
		const release = deferred()
		const seen: number[] = []
		const firehose = new BunFirehose({
			service: server.url,
			getCursor: () => 9,
			idResolver: resolver(async () => {
				entered.resolve()
				await release.promise
				return fixture.did
			}),
			onError: () => {},
			handleEvent: (event) => {
				seen.push(event.seq)
			},
		})
		const running = firehose.start()
		try {
			await entered.promise
			let drained = false
			const drain = Promise.resolve(firehose.destroy()).then(() => {
				drained = true
			})
			await pause(25)
			expect(drained).toBe(false)
			release.resolve()
			await drain
			expect(seen).toEqual([10])
		} finally {
			release.resolve()
			await firehose.destroy()
			await running
			server.stop()
		}
	})
	test.each([
		'car',
		'proof',
	] as const)('a %s failure passes the ops on unverified, after a key refresh, and later frames still arrive', async (poison) => {
		const server = relay(poison)
		const done = deferred()
		const events: Event[] = []
		const errors: Error[] = []
		const refreshes: boolean[] = []
		const firehose = new BunFirehose({
			service: server.url,
			getCursor: () => 9,
			idResolver: {
				did: {
					resolveAtprotoKey: async (_did: string, forceRefresh: boolean) => {
						refreshes.push(forceRefresh)
						return fixture.did
					},
				},
			} as unknown as IdResolver,
			onError: (error) => errors.push(error),
			handleEvent: (event) => {
				events.push(event)
				if (event.seq === 12) done.resolve()
			},
		})
		const running = firehose.start()
		try {
			await Promise.race([
				done.promise,
				pause(4000).then(() => {
					throw new Error('later frame never arrived')
				}),
			])
			expect(errors).toEqual([])
			expect(refreshes).toEqual([false, true])
			expect(server.cursors).toEqual(['9'])
			const unverified = events.filter((event) => event.seq === 11) as CommitEvt[]
			const rkeys = poison === 'proof' ? ['absent', 'absent'] : ['one', 'two']
			expect(unverified.map((event) => [event.collection, event.rkey, event.event, event.unverified])).toEqual(
				rkeys.map((rkey) => ['place.wisp.settings', rkey, 'create', true]),
			)
			expect(unverified.every((event) => event.record === undefined)).toBe(true)
		} finally {
			await firehose.destroy()
			await running
			server.stop()
		}
	})

	test('failure without a safe cursor stops rather than reconnecting at the live head', async () => {
		const server = relay()
		const seen: number[] = []
		const firehose = new BunFirehose({
			service: server.url,
			idResolver: resolver(async () => {
				throw new Error('DID unavailable')
			}),
			onError: () => {},
			handleEvent: (event) => {
				seen.push(event.seq)
			},
		})
		try {
			await firehose.start()
			expect(seen).toEqual([10])
			expect(server.cursors).toEqual([null])
		} finally {
			await firehose.destroy()
			server.stop()
		}
	})

	test('destroy joins an in-flight handler without admitting another operation', async () => {
		const server = relay()
		const entered = deferred()
		const release = deferred()
		const seen: number[] = []
		const firehose = new BunFirehose({
			service: server.url,
			getCursor: () => 9,
			idResolver: resolver(async () => fixture.did),
			onError: () => {},
			handleEvent: async (event) => {
				seen.push(event.seq)
				if (event.seq === 11) {
					entered.resolve()
					await release.promise
				}
			},
		})
		const running = firehose.start()
		try {
			await entered.promise
			let drained = false
			const drain = firehose.destroy().then(() => {
				drained = true
			})
			await pause(25)
			expect(drained).toBe(false)
			release.resolve()
			await drain
			expect(seen).toEqual([10, 11])
		} finally {
			release.resolve()
			await firehose.destroy()
			await running
			server.stop()
		}
	})
})
