import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { TieredStorage } from '../src/TieredStorage.js'
import { DiskStorageTier } from '../src/tiers/DiskStorageTier.js'

let directory: string
let storage: TieredStorage

describe('TieredStorage owned streaming reads', () => {
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'tiered-storage-stream-fence-'))
		const cold = new DiskStorageTier({ directory })
		await cold.getStats()
		storage = new TieredStorage({ tiers: { cold } })
	})
	afterEach(async () => rm(directory, { recursive: true, force: true }))

	test('holds the read fence until an owned stream is cancelled', async () => {
		await storage.setStream('leased', Readable.from([Buffer.alloc(1024 * 1024)]), { size: 1024 * 1024 })
		const controller = new AbortController()
		const result = await storage.getStream('leased', { signal: controller.signal })
		expect(result).not.toBeNull()
		const fences = (storage as unknown as { keyFences: Map<string, { activeReads: number }> }).keyFences
		expect(fences.get('leased')?.activeReads).toBe(1)
		controller.abort()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(fences.has('leased')).toBe(false)
	})

	test('releases the fence after normal stream completion', async () => {
		await storage.setStream('completed', Readable.from(['done']), { size: 4 })
		const result = await storage.getStream('completed')
		for await (const chunk of result!.stream) expect(chunk).toBeDefined()
		expect((storage as unknown as { keyFences: Map<string, unknown> }).keyFences.has('completed')).toBe(false)
	})

	test('forwards cancellation to a pending tier read and releases its fence', async () => {
		let observedSignal: AbortSignal | undefined
		const pendingStorage = new TieredStorage({
			tiers: {
				cold: {
					getStream: (_key: string, options?: { signal?: AbortSignal }) =>
						new Promise((_, reject) => {
							observedSignal = options?.signal
							options?.signal?.addEventListener('abort', () => reject(new Error('read aborted')), { once: true })
						}),
				} as never,
			},
		})
		const controller = new AbortController()
		const pending = pendingStorage.getStream('pending', { signal: controller.signal })
		controller.abort()
		await expect(pending).rejects.toThrow('read aborted')
		expect(observedSignal).toBe(controller.signal)
		expect((pendingStorage as unknown as { keyFences: Map<string, unknown> }).keyFences.has('pending')).toBe(false)
	})

	test('rejects an already-aborted read without acquiring a fence', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(storage.getStream('leased', { signal: controller.signal })).rejects.toThrow()
		expect((storage as unknown as { keyFences: Map<string, unknown> }).keyFences.has('leased')).toBe(false)
	})
})
