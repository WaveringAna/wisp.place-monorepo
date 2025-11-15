import { existsSync, rmSync } from 'fs'
import {
	getPdsForDid,
	downloadAndCacheSite,
	extractBlobCid,
	fetchSiteRecord
} from './utils'
import { upsertSite, tryAcquireLock, releaseLock } from './db'
import { safeFetch } from './safe-fetch'
import { isRecord, validateRecord } from '../lexicon/types/place/wisp/fs'
import { Firehose } from '@atproto/sync'
import { IdResolver } from '@atproto/identity'
import { invalidateSiteCache, markSiteAsBeingCached, unmarkSiteAsBeingCached } from './cache'

const CACHE_DIR = './cache/sites'

export class FirehoseWorker {
	private firehose: Firehose | null = null
	private idResolver: IdResolver
	private isShuttingDown = false
	private lastEventTime = Date.now()

	constructor(
		private logger?: (msg: string, data?: Record<string, unknown>) => void
	) {
		this.idResolver = new IdResolver()
	}

	private log(msg: string, data?: Record<string, unknown>) {
		const log = this.logger || console.log
		log(`[FirehoseWorker] ${msg}`, data || {})
	}

	start() {
		this.log('Starting firehose worker')
		this.connect()
	}

	stop() {
		this.log('Stopping firehose worker')
		this.isShuttingDown = true

		if (this.firehose) {
			this.firehose.destroy()
			this.firehose = null
		}
	}

	private connect() {
		if (this.isShuttingDown) return

		this.log('Connecting to AT Protocol firehose')

		this.firehose = new Firehose({
			idResolver: this.idResolver,
			service: 'wss://bsky.network',
			filterCollections: ['place.wisp.fs'],
			handleEvent: async (evt: any) => {
				this.lastEventTime = Date.now()

				// Watch for write events
				if (evt.event === 'create' || evt.event === 'update') {
					const record = evt.record

					// If the write is a valid place.wisp.fs record
					if (
						evt.collection === 'place.wisp.fs' &&
						isRecord(record) &&
						validateRecord(record).success
					) {
						this.log('Received place.wisp.fs event', {
							did: evt.did,
							event: evt.event,
							rkey: evt.rkey
						})

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
					}
				} else if (
					evt.event === 'delete' &&
					evt.collection === 'place.wisp.fs'
				) {
					this.log('Received delete event', {
						did: evt.did,
						rkey: evt.rkey
					})

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

		this.firehose.start()
		this.log('Firehose started')
	}

	private async handleCreateOrUpdate(
		did: string,
		site: string,
		record: any,
		eventCid?: string
	) {
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
		invalidateSiteCache(did, site)

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

		// Invalidate in-memory caches
		invalidateSiteCache(did, site)

		// Delete disk cache
		this.deleteCache(did, site)

		this.log('Successfully processed delete', { did, site })
	}

	private deleteCache(did: string, site: string) {
		const cacheDir = `${CACHE_DIR}/${did}/${site}`

		if (!existsSync(cacheDir)) {
			this.log('Cache directory does not exist, nothing to delete', {
				did,
				site
			})
			return
		}

		try {
			rmSync(cacheDir, { recursive: true, force: true })
			this.log('Cache deleted', { did, site, path: cacheDir })
		} catch (err) {
			this.log('Failed to delete cache', {
				did,
				site,
				path: cacheDir,
				error: err instanceof Error ? err.message : String(err)
			})
		}
	}

	getHealth() {
		const isConnected = this.firehose !== null
		const timeSinceLastEvent = Date.now() - this.lastEventTime

		return {
			connected: isConnected,
			lastEventTime: this.lastEventTime,
			timeSinceLastEvent,
			healthy: isConnected && timeSinceLastEvent < 300000 // 5 minutes
		}
	}
}
