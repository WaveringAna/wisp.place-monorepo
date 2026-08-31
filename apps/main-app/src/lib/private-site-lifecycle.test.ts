import { beforeEach, describe, expect, test } from 'bun:test'
import {
	cleanupClaimedPrivateSites,
	cleanupFailedStaging,
	PRIVATE_SITE_STAGING_LEASE_MS,
	PRIVATE_SITE_STORAGE_WRITE_TIMEOUT_MS,
	persistStagedPrivateSite,
	StagedPrivateSiteLeaseLostError,
	StagedPrivateSiteNotPublishedError,
} from './private-site-lifecycle'

const events: string[] = []
const failures: string[] = []

beforeEach(() => {
	events.length = 0
	failures.length = 0
})

const cleanupOperations = (options: { mark?: boolean; storageError?: boolean; finalize?: boolean } = {}) => ({
	markDeleting: async () => {
		events.push('mark-deleting')
		return options.mark ?? true
	},
	removeStorage: async () => {
		events.push('remove-storage')
		if (options.storageError) throw new Error('storage failure')
		return 2
	},
	finalizeDeletion: async () => {
		events.push('delete-metadata')
		return options.finalize ?? true
	},
})
const report = (phase: string, error: unknown) =>
	failures.push(`${phase}:${error instanceof Error ? error.message : 'unknown'}`)

describe('private-site durable lifecycle primitives', () => {
	test('publishes only after every storage object finishes', async () => {
		const site = await persistStagedPrivateSite({
			files: ['index.html', 'app.js'],
			renewLease: async () => true,
			writeFile: async (file) => {
				events.push(`write:${file}`)
			},
			markReady: async () => {
				events.push('mark-ready')
				return { state: 'ready' }
			},
			cleanup: cleanupOperations(),
			reportCleanupFailure: report,
		})

		expect(site).toEqual({ state: 'ready' })
		expect(events).toEqual(['write:index.html', 'write:app.js', 'mark-ready'])
	})

	test('marks deleting before removing a partial upload after every write boundary', async () => {
		let writes = 0
		await expect(
			persistStagedPrivateSite({
				files: ['index.html', 'app.js'],
				renewLease: async () => true,
				writeFile: async (file) => {
					events.push(`write:${file}`)
					writes++
					if (writes === 2) throw new Error('second object failed')
				},
				markReady: async () => ({ state: 'ready' }),
				cleanup: cleanupOperations(),
				reportCleanupFailure: report,
			}),
		).rejects.toThrow('second object failed')

		expect(events).toEqual(['write:index.html', 'write:app.js', 'mark-deleting', 'remove-storage', 'delete-metadata'])
	})

	test('retains a deleting row if storage cleanup fails', async () => {
		const result = await cleanupFailedStaging(cleanupOperations({ storageError: true }), report)
		expect(result).toEqual({ claimed: true, storageRemoved: false, finalized: false })
		expect(events).toEqual(['mark-deleting', 'remove-storage'])
		expect(failures).toEqual(['removeStorage:storage failure'])
	})

	test('does not remove storage when ready transition has an ambiguous error', async () => {
		await expect(
			persistStagedPrivateSite({
				files: ['index.html'],
				renewLease: async () => true,
				writeFile: async () => {
					events.push('write:index.html')
				},
				markReady: async () => {
					events.push('mark-ready')
					throw new Error('connection lost after commit')
				},
				cleanup: cleanupOperations(),
				reportCleanupFailure: report,
			}),
		).rejects.toThrow('connection lost after commit')
		expect(events).toEqual(['write:index.html', 'mark-ready'])
	})

	test('cleans an explicit unpublishable staging row only after claiming deleting', async () => {
		await expect(
			persistStagedPrivateSite({
				files: ['index.html'],
				renewLease: async () => true,
				writeFile: async () => {
					events.push('write:index.html')
				},
				markReady: async () => {
					events.push('mark-ready')
					return null
				},
				cleanup: cleanupOperations(),
				reportCleanupFailure: report,
			}),
		).rejects.toBeInstanceOf(StagedPrivateSiteNotPublishedError)
		expect(events).toEqual(['write:index.html', 'mark-ready', 'mark-deleting', 'remove-storage', 'delete-metadata'])
	})

	test('stops before a late write when a paused uploader loses its staging lease to the reaper', async () => {
		let leaseOwned = true
		const storageKeys = new Set<string>()
		let renewals = 0

		await expect(
			persistStagedPrivateSite({
				files: ['first.html', 'late.html'],
				renewLease: async () => {
					renewals++
					events.push(`renew:${renewals}`)
					if (renewals === 2) {
						// Model a pause after the first durable write. The reaper claims
						// the expired staging row and clears its prefix before a second
						// write can start.
						events.push('reaper:claimed-and-cleared')
						leaseOwned = false
						storageKeys.clear()
					}
					return leaseOwned
				},
				writeFile: async (file) => {
					events.push(`write:${file}`)
					storageKeys.add(file)
				},
				markReady: async () => ({ state: 'ready' }),
				cleanup: {
					markDeleting: async () => false,
					removeStorage: async () => 0,
					finalizeDeletion: async () => false,
				},
				reportCleanupFailure: report,
			}),
		).rejects.toBeInstanceOf(StagedPrivateSiteLeaseLostError)

		expect(events).toEqual(['renew:1', 'write:first.html', 'renew:2', 'reaper:claimed-and-cleared'])
		expect(storageKeys.size).toBe(0)
		expect(storageKeys.has('late.html')).toBe(false)
	})

	test('keeps each S3 write deadline below the staging lease', () => {
		expect(PRIVATE_SITE_STORAGE_WRITE_TIMEOUT_MS).toBeLessThan(PRIVATE_SITE_STAGING_LEASE_MS)
	})

	test('processes reaper claims in deletion-barrier order and leaves failed work retryable', async () => {
		const result = await cleanupClaimedPrivateSites(
			[{ siteId: 'bright-brook-fox-1234' }],
			{
				removeStorage: async (siteId) => {
					events.push(`remove:${siteId}`)
					return 3
				},
				finalizeDeletion: async (siteId) => {
					events.push(`finalize:${siteId}`)
					return true
				},
			},
			(siteId) => failures.push(siteId),
		)
		expect(result).toEqual({ sites: 1, files: 3 })
		expect(events).toEqual(['remove:bright-brook-fox-1234', 'finalize:bright-brook-fox-1234'])
	})
})
