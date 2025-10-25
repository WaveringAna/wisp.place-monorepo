import { existsSync, rmSync } from 'fs';
import type { WispFsRecord } from './types';
import { getPdsForDid, downloadAndCacheSite, extractBlobCid, fetchSiteRecord } from './utils';
import { upsertSite } from './db';
import { safeFetch } from './safe-fetch';

const CACHE_DIR = './cache/sites';
const JETSTREAM_URL = 'wss://jetstream2.us-west.bsky.network/subscribe';
const RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_DELAY = 60000; // 1 minute

interface JetstreamCommitEvent {
  did: string;
  time_us: number;
  type: 'com' | 'identity' | 'account';
  kind: 'commit';
  commit: {
    rev: string;
    operation: 'create' | 'update' | 'delete';
    collection: string;
    rkey: string;
    record?: any;
    cid?: string;
  };
}

interface JetstreamIdentityEvent {
  did: string;
  time_us: number;
  type: 'identity';
  kind: 'update';
  identity: {
    did: string;
    handle: string;
    seq: number;
    time: string;
  };
}

interface JetstreamAccountEvent {
  did: string;
  time_us: number;
  type: 'account';
  kind: 'update' | 'delete';
  account: {
    active: boolean;
    did: string;
    seq: number;
    time: string;
  };
}

type JetstreamEvent =
  | JetstreamCommitEvent
  | JetstreamIdentityEvent
  | JetstreamAccountEvent;

export class FirehoseWorker {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: Timer | null = null;
  private isShuttingDown = false;
  private lastEventTime = Date.now();

  constructor(
    private logger?: (msg: string, data?: Record<string, unknown>) => void,
  ) {}

  private log(msg: string, data?: Record<string, unknown>) {
    const log = this.logger || console.log;
    log(`[FirehoseWorker] ${msg}`, data || {});
  }

  start() {
    this.log('Starting firehose worker');
    this.connect();
  }

  stop() {
    this.log('Stopping firehose worker');
    this.isShuttingDown = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect() {
    if (this.isShuttingDown) return;

    const url = new URL(JETSTREAM_URL);
    url.searchParams.set('wantedCollections', 'place.wisp.fs');

    this.log('Connecting to Jetstream', { url: url.toString() });

    try {
      this.ws = new WebSocket(url.toString());

      this.ws.onopen = () => {
        this.log('Connected to Jetstream');
        this.reconnectAttempts = 0;
        this.lastEventTime = Date.now();
      };

      this.ws.onmessage = async (event) => {
        this.lastEventTime = Date.now();

        try {
          const data = JSON.parse(event.data as string) as JetstreamEvent;
          await this.handleEvent(data);
        } catch (err) {
          this.log('Error processing event', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      this.ws.onerror = (error) => {
        this.log('WebSocket error', { error: String(error) });
      };

      this.ws.onclose = () => {
        this.log('WebSocket closed');
        this.ws = null;

        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.log('Failed to create WebSocket', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.isShuttingDown) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY,
    );

    this.log(`Scheduling reconnect attempt ${this.reconnectAttempts}`, {
      delay: `${delay}ms`,
    });

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private async handleEvent(event: JetstreamEvent) {
    if (event.kind !== 'commit') return;

    const commitEvent = event as JetstreamCommitEvent;
    const { commit, did } = commitEvent;

    if (commit.collection !== 'place.wisp.fs') return;

    this.log('Received place.wisp.fs event', {
      did,
      operation: commit.operation,
      rkey: commit.rkey,
    });

    try {
      if (commit.operation === 'create' || commit.operation === 'update') {
        // Pass the CID from the event for verification
        await this.handleCreateOrUpdate(did, commit.rkey, commit.record, commit.cid);
      } else if (commit.operation === 'delete') {
        await this.handleDelete(did, commit.rkey);
      }
    } catch (err) {
      this.log('Error handling event', {
        did,
        operation: commit.operation,
        rkey: commit.rkey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleCreateOrUpdate(did: string, site: string, record: any, eventCid?: string) {
    this.log('Processing create/update', { did, site });

    if (!this.validateRecord(record)) {
      this.log('Invalid record structure, skipping', { did, site });
      return;
    }

    const fsRecord = record as WispFsRecord;

    const pdsEndpoint = await getPdsForDid(did);
    if (!pdsEndpoint) {
      this.log('Could not resolve PDS for DID', { did });
      return;
    }

    this.log('Resolved PDS', { did, pdsEndpoint });

    // Verify record exists on PDS and fetch its CID
    let verifiedCid: string;
    try {
      const result = await fetchSiteRecord(did, site);

      if (!result) {
        this.log('Record not found on PDS, skipping cache', { did, site });
        return;
      }

      verifiedCid = result.cid;

      // Verify event CID matches PDS CID (prevent cache poisoning)
      if (eventCid && eventCid !== verifiedCid) {
        this.log('CID mismatch detected - potential spoofed event', {
          did,
          site,
          eventCid,
          verifiedCid
        });
        return;
      }

      this.log('Record verified on PDS', { did, site, cid: verifiedCid });
    } catch (err) {
      this.log('Failed to verify record on PDS', {
        did,
        site,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Cache the record with verified CID
    await downloadAndCacheSite(did, site, fsRecord, pdsEndpoint, verifiedCid);

    // Upsert site to database
    await upsertSite(did, site, fsRecord.site);

    this.log('Successfully processed create/update', { did, site });
  }

  private async handleDelete(did: string, site: string) {
    this.log('Processing delete', { did, site });

    const pdsEndpoint = await getPdsForDid(did);
    if (!pdsEndpoint) {
      this.log('Could not resolve PDS for DID', { did });
      return;
    }

    // Verify record is actually deleted from PDS
    try {
      const recordUrl = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=place.wisp.fs&rkey=${encodeURIComponent(site)}`;
      const recordRes = await safeFetch(recordUrl);

      if (recordRes.ok) {
        this.log('Record still exists on PDS, not deleting cache', {
          did,
          site,
        });
        return;
      }

      this.log('Verified record is deleted from PDS', {
        did,
        site,
        status: recordRes.status,
      });
    } catch (err) {
      this.log('Error verifying deletion on PDS', {
        did,
        site,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Delete cache
    this.deleteCache(did, site);

    this.log('Successfully processed delete', { did, site });
  }

  private validateRecord(record: any): boolean {
    if (!record || typeof record !== 'object') return false;
    if (record.$type !== 'place.wisp.fs') return false;
    if (!record.root || typeof record.root !== 'object') return false;
    if (!record.site || typeof record.site !== 'string') return false;
    return true;
  }

  private deleteCache(did: string, site: string) {
    const cacheDir = `${CACHE_DIR}/${did}/${site}`;

    if (!existsSync(cacheDir)) {
      this.log('Cache directory does not exist, nothing to delete', {
        did,
        site,
      });
      return;
    }

    try {
      rmSync(cacheDir, { recursive: true, force: true });
      this.log('Cache deleted', { did, site, path: cacheDir });
    } catch (err) {
      this.log('Failed to delete cache', {
        did,
        site,
        path: cacheDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getHealth() {
    const isConnected = this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    const timeSinceLastEvent = Date.now() - this.lastEventTime;

    return {
      connected: isConnected,
      reconnectAttempts: this.reconnectAttempts,
      lastEventTime: this.lastEventTime,
      timeSinceLastEvent,
      healthy: isConnected && timeSinceLastEvent < 300000, // 5 minutes
    };
  }
}
