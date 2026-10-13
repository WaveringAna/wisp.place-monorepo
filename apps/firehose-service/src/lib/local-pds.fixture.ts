/**
 * Hermetic stand-ins for the cache-writer tests: a loopback PDS served by
 * Bun.serve and cold storage backed by a real in-memory tier. Production code
 * reaches both through its normal safe-fetch and tiered-storage paths.
 */
import { MemoryStorageTier } from '@wispplace/tiered-storage'
import { createColdStorage, createSiteObjectStore, type SiteObjectStore } from './storage'

export interface BlobRequest {
	did: string | null
	cid: string | null
	pds: string
}

export interface LocalPds {
	readonly url: string
	stop(): Promise<void>
}

/** Serve one PDS on 127.0.0.1; every request URL is handed to `respond`. */
export function startLocalPds(respond: (url: URL, origin: string) => Response | Promise<Response>): LocalPds {
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: (request, self) => respond(new URL(request.url), self.url.origin),
	})
	return { url: server.url.origin, stop: () => server.stop(true) }
}

/** The answer a PDS gives for a record it does not have. */
export function recordNotFound(): Response {
	return Response.json({ error: 'RecordNotFound', message: 'Could not locate record' }, { status: 400 })
}

/**
 * safe-fetch admits loopback hosts only behind its development gate, which it
 * reads per request. Returns the restore function for afterAll.
 */
export function allowLoopbackFetch(): () => void {
	const names = ['NODE_ENV', 'WISP_ALLOW_LOCALHOST_FETCH'] as const
	const previous = names.map((name) => [name, process.env[name]] as const)
	process.env.NODE_ENV = 'development'
	process.env.WISP_ALLOW_LOCALHOST_FETCH = '1'
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
	}
}

/** The firehose's own cold-only storage over a fresh in-memory tier. */
export function createMemorySiteObjectStore(): SiteObjectStore {
	const tier = new MemoryStorageTier({ maxSizeBytes: 64 * 1024 * 1024 })
	const storage = createColdStorage(tier)
	return createSiteObjectStore(
		() => tier,
		() => storage,
	)
}
