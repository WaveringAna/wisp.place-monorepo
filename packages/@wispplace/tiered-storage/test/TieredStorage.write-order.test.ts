import { describe, expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import { TieredStorage } from '../src/TieredStorage.js'
import { MemoryStorageTier } from '../src/tiers/MemoryStorageTier.js'

describe('TieredStorage write correctness', () => {
	test('commits cold before upper tiers and leaves upper tiers untouched when cold fails', async () => {
		const calls: string[] = []
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		const hotSet = hot.set.bind(hot)
		hot.set = async (...args) => {
			calls.push('hot')
			return await hotSet(...args)
		}
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		cold.set = async () => {
			calls.push('cold')
			throw new Error('cold unavailable')
		}

		await expect(new TieredStorage({ tiers: { hot, cold } }).set('key', 'value')).rejects.toThrow('cold unavailable')
		expect(calls).toEqual(['cold'])
		expect(await hot.exists('key')).toBe(false)
	})

	test('keeps the cold commit and best-effort clears upper copies after an upper-tier failure', async () => {
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		const warmSet = warm.set.bind(warm)
		warm.set = async (...args) => {
			await warmSet(...args)
			throw new Error('warm cache unavailable')
		}
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		const storage = new TieredStorage({ tiers: { hot, warm, cold } })

		await expect(storage.set('key', 'value')).rejects.toThrow('warm cache unavailable')
		expect(await cold.exists('key')).toBe(true)
		expect(await hot.exists('key')).toBe(false)
		expect(await warm.exists('key')).toBe(false)
	})

	test('streams to cold, commits metadata, then replays cold into upper tiers', async () => {
		const calls: string[] = []
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		const coldSetStream = cold.setStream!.bind(cold)
		const coldGetStream = cold.getStream!.bind(cold)
		cold.setStream = async (...args) => {
			calls.push('cold:start')
			await coldSetStream(...args)
			calls.push('cold:commit')
		}
		cold.getStream = async (...args) => {
			calls.push('cold:replay')
			return await coldGetStream(...args)
		}
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		const warmSetStream = warm.setStream!.bind(warm)
		warm.setStream = async (...args) => {
			calls.push('warm')
			expect(args[2].checksum).not.toBe('')
			await warmSetStream(...args)
		}

		await new TieredStorage({ tiers: { warm, cold } }).setStream('key', Readable.from([Buffer.from('replay me')]), {
			size: 9,
		})
		expect(calls).toEqual(['cold:start', 'cold:commit', 'cold:replay', 'warm'])
		const warmData = await warm.get('key')
		expect(warmData).not.toBeNull()
		expect(new TextDecoder().decode(warmData ?? undefined)).toBe('replay me')
	})

	test('does not expose an upper streaming copy when cold streaming fails', async () => {
		let upperStarted = false
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		cold.setStream = async () => {
			throw new Error('cold stream failed')
		}
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		warm.setStream = async () => {
			upperStarted = true
		}

		await expect(
			new TieredStorage({ tiers: { warm, cold } }).setStream('key', Readable.from([Buffer.alloc(1)]), { size: 1 }),
		).rejects.toThrow('cold stream failed')
		expect(upperStarted).toBe(false)
		expect(await warm.exists('key')).toBe(false)
	})

	test('backpressures a slow streaming branch instead of reading the whole source', async () => {
		let produced = 0
		let consumedBytes = 0
		let maximumLead = 0
		async function* chunks() {
			for (let index = 0; index < 100; index++) {
				produced++
				yield Buffer.alloc(16 * 1024, index)
			}
		}
		const warm = new MemoryStorageTier({ maxSizeBytes: 4 * 1024 * 1024 })
		warm.setStream = async (_key, stream) => {
			for await (const _chunk of stream) {
				consumedBytes += _chunk.length
				maximumLead = Math.max(maximumLead, produced * 16 * 1024 - consumedBytes)
				await new Promise((resolve) => setTimeout(resolve, 1))
			}
		}
		const cold = new MemoryStorageTier({ maxSizeBytes: 4 * 1024 * 1024 })

		await new TieredStorage({ tiers: { warm, cold } }).setStream('key', Readable.from(chunks()), {
			size: 100 * 16 * 1024,
		})
		expect(consumedBytes).toBe(100 * 16 * 1024)
		// Pipeline and each branch have bounded high-water marks, not source-sized queues.
		expect(maximumLead).toBeLessThan(512 * 1024)
	})

	test('preserves an undefined streaming branch rejection', async () => {
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		warm.setStream = async () => {
			throw undefined
		}
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })

		await expect(
			new TieredStorage({ tiers: { warm, cold } }).setStream('key', Readable.from([Buffer.alloc(1)]), { size: 1 }),
		).rejects.toBeUndefined()
	})

	test('destroys the source and waits for all streaming branches when one branch fails', async () => {
		const failure = new Error('warm writer failed')
		const source = Readable.from([Buffer.alloc(16 * 1024), Buffer.alloc(16 * 1024)])
		let slowBranchFinished = false
		const hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		hot.setStream = async (_key, stream) => {
			try {
				for await (const _chunk of stream) {
				}
			} finally {
				slowBranchFinished = true
			}
		}
		const warm = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
		warm.setStream = async (_key, stream) => {
			for await (const _chunk of stream) throw failure
		}
		const cold = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })

		await expect(
			new TieredStorage({ tiers: { hot, warm, cold } }).setStream('key', source, {
				size: 32 * 1024,
				onlyTiers: ['hot', 'warm', 'cold'],
			}),
		).rejects.toBe(failure)
		expect(source.destroyed).toBe(true)
		expect(slowBranchFinished).toBe(true)
		expect(await cold.exists('key')).toBe(true)
		expect(await hot.exists('key')).toBe(false)
		expect(await warm.exists('key')).toBe(false)
	})
})
