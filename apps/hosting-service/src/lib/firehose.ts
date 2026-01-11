import { existsSync } from 'fs'
import {
	getPdsForDid,
	downloadAndCacheSite,
	fetchSiteRecord
} from './utils'
import { upsertSite, tryAcquireLock, releaseLock } from './db'
import { safeFetch } from '@wisp/safe-fetch'
// import { isRecord, validateRecord } from '@wisp/lexicons/types/place/wisp/fs'
import { isRecord } from '@wisp/lexicons/types/place/wisp/fs'
import { Firehose } from '@atproto/sync'
import { IdResolver } from '@atproto/identity'
import { invalidateSiteCache, markSiteAsBeingCached, unmarkSiteAsBeingCached } from './cache'
import { clearRedirectRulesCache } from './site-cache'

const CACHE_DIR = process.env.CACHE_DIR || './cache/sites'

export class FirehoseWorker {
	private firehose: Firehose | null = null
	private idResolver: IdResolver
	private isShuttingDown = false
	private lastEventTime = Date.now()
	private eventCount = 0
	private cacheCleanupInterval: NodeJS.Timeout | null = null
	private healthCheckInterval: NodeJS.Timeout | null = null
	private processingQueue: Set<Promise<void>> = new Set()
	private readonly maxConcurrency = parseInt(process.env.FIREHOSE_MAX_CONCURRENCY || '5', 10)

	constructor(
		private logger?: (msg: string, data?: Record<string, unknown>) => void
	) {
		this.idResolver = new IdResolver()
		this.startCacheCleanup()
	}

	private log(msg: string, data?: Record<string, unknown>) {
		const log = this.logger || console.log
		log(`[FirehoseWorker] ${msg}`, data || {})
	}

	/**
	 * Queue a task with concurrency limiting
	 * Waits if max concurrent tasks are already running
	 */
	private async queueTask(task: () => Promise<void>): Promise<void> {
		// Wait if we're at max concurrency
		if (this.processingQueue.size >= this.maxConcurrency) {
			this.log(`Queue at max capacity (${this.maxConcurrency}), waiting for slot...`, {
				queueSize: this.processingQueue.size
			})
			await Promise.race(this.processingQueue)
		}

		// Execute task and track in queue
		const promise = task()
			.catch(err => {
				// Errors are already logged in the handlers
			})
			.finally(() => {
				this.processingQueue.delete(promise)
			})

		this.processingQueue.add(promise)

		// Don't await here - we want handleEvent to return quickly
		// The task will process in the background with concurrency limiting
	}

	private startCacheCleanup() {
		// Clear IdResolver cache every hour to prevent unbounded memory growth
		// The IdResolver has an internal cache that never expires and can cause heap exhaustion
		this.cacheCleanupInterval = setInterval(() => {
			if (this.isShuttingDown) return

			this.log('Clearing IdResolver cache to prevent memory leak')

			// Recreate the IdResolver to clear its internal cache
			this.idResolver = new IdResolver()

			this.log('IdResolver cache cleared')
		}, 60 * 60 * 1000) // Every hour

		// Health check: log if no events received for 30 seconds
		this.healthCheckInterval = setInterval(() => {
			if (this.isShuttingDown) return

			const timeSinceLastEvent = Date.now() - this.lastEventTime
			if (timeSinceLastEvent > 30000 && this.eventCount === 0) {
				this.log('Warning: No firehose events received in the last 30 seconds', {
					timeSinceLastEvent,
					eventsReceived: this.eventCount
				})
			} else if (timeSinceLastEvent > 60000) {
				this.log('Firehose status check', {
					timeSinceLastEvent,
					eventsReceived: this.eventCount
				})
			}
		}, 30000) // Every 30 seconds
	}

	start() {
		this.log('Starting firehose worker')
		this.connect()
	}

	async stop() {
		this.log('Stopping firehose worker')
		this.isShuttingDown = true

		if (this.cacheCleanupInterval) {
			clearInterval(this.cacheCleanupInterval)
			this.cacheCleanupInterval = null
		}

		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval)
			this.healthCheckInterval = null
		}

		if (this.firehose) {
			this.firehose.destroy()
			this.firehose = null
		}

		// Wait for all queued tasks to complete
		if (this.processingQueue.size > 0) {
			this.log(`Waiting for ${this.processingQueue.size} queued tasks to complete...`)
			await Promise.all(this.processingQueue)
			this.log('All queued tasks completed')
		}
	}

	private connect() {
		if (this.isShuttingDown) return

		this.log('Connecting to AT Protocol firehose')

		this.firehose = new Firehose({
			idResolver: this.idResolver,
			service: 'wss://bsky.network',
			filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
			handleEvent: async (evt: any) => {
				this.lastEventTime = Date.now()
				this.eventCount++

				if (this.eventCount === 1) {
					this.log('First firehose event received - connection established', {
						eventType: evt.event,
						collection: evt.collection
					})
				}

				// Watch for write events
				if (evt.event === 'create' || evt.event === 'update') {
					const record = evt.record

					// If the write is a valid place.wisp.fs record
					if (
						evt.collection === 'place.wisp.fs' &&
						isRecord(record)
						// && validateRecord(record).success
					) {
						this.log('Received place.wisp.fs event', {
							did: evt.did,
							event: evt.event,
							rkey: evt.rkey
						})

						await this.queueTask(async () => {
							try {
								await this.handleCreateOrUpdate(
									evt.did,
									evt.rkey,
									record,
									evt.cid?.toString()
								)
							} catch (err) {
								console.error('Full error details:', err);
								this.log('Error handling event', {
									did: evt.did,
									event: evt.event,
									rkey: evt.rkey,
									error:
										err instanceof Error
											? err.message
											: String(err)
								})
							}
						})
					}
					// Handle settings changes
					else if (evt.collection === 'place.wisp.settings') {
						this.log('Received place.wisp.settings event', {
							did: evt.did,
							event: evt.event,
							rkey: evt.rkey
						})

						await this.queueTask(async () => {
							try {
								await this.handleSettingsChange(evt.did, evt.rkey)
							} catch (err) {
								this.log('Error handling settings change', {
									did: evt.did,
									event: evt.event,
									rkey: evt.rkey,
									error:
										err instanceof Error
											? err.message
											: String(err)
								})
							}
						})
					}
				} else if (
					evt.event === 'delete' &&
					evt.collection === 'place.wisp.fs'
				) {
					this.log('Received delete event', {
						did: evt.did,
						rkey: evt.rkey
					})

					await this.queueTask(async () => {
						try {
							await this.handleDelete(evt.did, evt.rkey)
						} catch (err) {
							this.log('Error handling delete', {
								did: evt.did,
								rkey: evt.rkey,
								error:
									err instanceof Error ? err.message : String(err)
							})
						}
					})
				} else if (
					evt.event === 'delete' &&
					evt.collection === 'place.wisp.settings'
				) {
					this.log('Received settings delete event', {
						did: evt.did,
						rkey: evt.rkey
					})

					await this.queueTask(async () => {
						try {
							await this.handleSettingsChange(evt.did, evt.rkey)
						} catch (err) {
							this.log('Error handling settings delete', {
								did: evt.did,
								rkey: evt.rkey,
								error:
									err instanceof Error ? err.message : String(err)
							})
						}
					})
				}
			},
			onError: (err: any) => {
				this.log('Firehose error', {
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
					fullError: err
				})
				console.error('Full firehose error:', err)
			}
		})

		this.firehose.start().catch((err: unknown) => {
			this.log('Fatal firehose error', {
				error: err instanceof Error ? err.message : String(err)
			})
			console.error('Fatal firehose error:', err)
		})
		this.log('Firehose starting')
	}

	private async handleCreateOrUpdate(
		did: string,
		site: string,
		record: any,
		eventCid?: string
	) {
		console.log(`[Firehose] Processing create/update from firehose - ${did}:${site}`)
		this.log('Processing create/update', { did, site })

		// Record is already validated in handleEvent
		const fsRecord = record

		const pdsEndpoint = await getPdsForDid(did)
		if (!pdsEndpoint) {
			this.log('Could not resolve PDS for DID', { did })
			return
		}

		this.log('Resolved PDS', { did, pdsEndpoint })

		// Verify record exists on PDS and fetch its CID
		this.log('Verifying record on PDS', { did, site })
		let verifiedCid: string
		try {
			const result = await fetchSiteRecord(did, site)

			if (!result) {
				this.log('Record not found on PDS, skipping cache', {
					did,
					site
				})
				return
			}

			verifiedCid = result.cid

			// Verify event CID matches PDS CID (prevent cache poisoning)
			if (eventCid && eventCid !== verifiedCid) {
				this.log('CID mismatch detected - potential spoofed event', {
					did,
					site,
					eventCid,
					verifiedCid
				})
				return
			}

			this.log('Record verified on PDS', { did, site, cid: verifiedCid })
		} catch (err) {
			this.log('Failed to verify record on PDS', {
				did,
				site,
				error: err instanceof Error ? err.message : String(err)
			})
			return
		}

		// Invalidate in-memory caches before updating
		await invalidateSiteCache(did, site)

		// Mark site as being cached to prevent serving stale content during update
		markSiteAsBeingCached(did, site)

		try {
			// Cache the record with verified CID (uses atomic swap internally)
			// All instances cache locally for edge serving
			await downloadAndCacheSite(
				did,
				site,
				fsRecord,
				pdsEndpoint,
				verifiedCid
			)

			// Clear redirect rules cache since the site was updated
			clearRedirectRulesCache(did, site)

			// Acquire distributed lock only for database write to prevent duplicate writes
			// Note: upsertSite will check cache-only mode internally and skip if needed
			const lockKey = `db:upsert:${did}:${site}`
			const lockAcquired = await tryAcquireLock(lockKey)

			if (!lockAcquired) {
				this.log('Another instance is writing to DB, skipping upsert', {
					did,
					site
				})
				this.log('Successfully processed create/update (cached locally)', {
					did,
					site
				})
				return
			}

			try {
				// Upsert site to database (only one instance does this)
				// In cache-only mode, this will be a no-op
				await upsertSite(did, site, fsRecord.site)
				this.log(
					'Successfully processed create/update (cached + DB updated)',
					{ did, site }
				)
			} finally {
				// Always release lock, even if DB write fails
				await releaseLock(lockKey)
			}
		} finally {
			// Always unmark, even if caching fails
			unmarkSiteAsBeingCached(did, site)
		}
	}

	private async handleDelete(did: string, site: string) {
		this.log('Processing delete', { did, site })

		// All instances should delete their local cache (no lock needed)
		const pdsEndpoint = await getPdsForDid(did)
		if (!pdsEndpoint) {
			this.log('Could not resolve PDS for DID', { did })
			return
		}

		// Verify record is actually deleted from PDS
		try {
			const recordUrl = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.fs&rkey=${encodeURIComponent(site)}`
			const recordRes = await safeFetch(recordUrl)

			if (recordRes.ok) {
				this.log('Record still exists on PDS, not deleting cache', {
					did,
					site
				})
				return
			}

			this.log('Verified record is deleted from PDS', {
				did,
				site,
				status: recordRes.status
			})
		} catch (err) {
			this.log('Error verifying deletion on PDS', {
				did,
				site,
				error: err instanceof Error ? err.message : String(err)
			})
		}

		// Invalidate all caches (tiered storage invalidation is handled by invalidateSiteCache)
		await invalidateSiteCache(did, site)

		this.log('Successfully processed delete', { did, site })
	}

	private async handleSettingsChange(did: string, rkey: string) {
		this.log('Processing settings change', { did, rkey })

		// Invalidate in-memory caches (includes metadata which stores settings)
		await invalidateSiteCache(did, rkey)

		// Check if site is already cached
		const cacheDir = `${CACHE_DIR}/${did}/${rkey}`
		const isCached = existsSync(cacheDir)

		if (!isCached) {
			this.log('Site not cached yet, checking if fs record exists', { did, rkey })

			// If site exists on PDS, cache it (which will include the new settings)
			try {
				const siteRecord = await fetchSiteRecord(did, rkey)

				if (siteRecord) {
					this.log('Site record found, triggering full cache with settings', { did, rkey })
					const pdsEndpoint = await getPdsForDid(did)

					if (pdsEndpoint) {
						// Mark as being cached
						markSiteAsBeingCached(did, rkey)

						try {
							await downloadAndCacheSite(did, rkey, siteRecord.record, pdsEndpoint, siteRecord.cid)
							this.log('Successfully cached site with new settings', { did, rkey })
						} finally {
							unmarkSiteAsBeingCached(did, rkey)
						}
					} else {
						this.log('Could not resolve PDS for DID', { did })
					}
				} else {
					this.log('No fs record found for site, skipping cache', { did, rkey })
				}
			} catch (err) {
				this.log('Failed to cache site after settings change', {
					did,
					rkey,
					error: err instanceof Error ? err.message : String(err)
				})
			}

			this.log('Successfully processed settings change (new cache)', { did, rkey })
			return
		}

		// Site is already cached, just update the settings in metadata
		try {
			const { fetchSiteSettings, updateCacheMetadataSettings } = await import('./utils')
			const settings = await fetchSiteSettings(did, rkey)
			await updateCacheMetadataSettings(did, rkey, settings)
			this.log('Updated cached settings', { did, rkey, hasSettings: !!settings })
		} catch (err) {
			this.log('Failed to update cached settings', {
				did,
				rkey,
				error: err instanceof Error ? err.message : String(err)
			})
		}

		this.log('Successfully processed settings change', { did, rkey })
	}

	getHealth() {
		const isConnected = this.firehose !== null
		const timeSinceLastEvent = Date.now() - this.lastEventTime

		return {
			connected: isConnected,
			lastEventTime: this.lastEventTime,
			timeSinceLastEvent,
			queueSize: this.processingQueue.size,
			maxConcurrency: this.maxConcurrency,
			healthy: isConnected && timeSinceLastEvent < 300000 // 5 minutes
		}
	}
}
