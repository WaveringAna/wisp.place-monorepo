/**
 * Firehose worker - watches AT Protocol firehose for site changes
 * Uses BunFirehose for Bun runtime, @atproto/sync for Node.js
 */

import { IdResolver } from '@atproto/identity';
import { Firehose } from '@atproto/sync';
import { isBun, BunFirehose, type Event, type CommitEvt } from '@wispplace/bun-firehose';
import type { Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs';
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings';
import { config } from '../config';
import {
  handleSiteCreateOrUpdate,
  handleSiteDelete,
  handleSettingsUpdate,
  handleSettingsDelete,
  fetchSiteRecord,
} from './cache-writer';

const idResolver = new IdResolver();

// Track firehose health
let lastEventTime = Date.now();
let isConnected = false;
let eventQueue: Array<() => Promise<void>> = [];
let activeHandlers = 0;

export function getFirehoseHealth() {
  return {
    connected: isConnected,
    lastEventTime,
    timeSinceLastEvent: Date.now() - lastEventTime,
    queueSize: eventQueue.length,
    activeHandlers,
    healthy: isConnected && (Date.now() - lastEventTime < 60000),
  };
}

/**
 * Process a firehose event with concurrency limiting
 */
async function processWithConcurrencyLimit(handler: () => Promise<void>): Promise<void> {
  // If at max concurrency, queue and wait
  while (activeHandlers >= config.firehoseMaxConcurrency) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  activeHandlers++;
  try {
    await handler();
  } finally {
    activeHandlers--;
  }
}

/**
 * Handle a firehose event
 */
async function handleEvent(evt: Event | CommitEvt): Promise<void> {
  try {
    lastEventTime = Date.now();

    if (!('event' in evt)) return;

    // Only handle commit events
    if (evt.event !== 'create' && evt.event !== 'update' && evt.event !== 'delete') {
      return;
    }

    const commitEvt = evt as CommitEvt;
    const { did, collection, rkey, record, cid } = commitEvt;

    console.log(`[Firehose] Debug: Event ${evt.event} for ${collection}:${did}/${rkey}, CID: ${cid?.toString() || 'unknown'}`);

    // Handle place.wisp.fs events
    if (collection === 'place.wisp.fs') {
      console.log(`[Firehose] Received ${commitEvt.event} event for ${did}/${rkey}, CID: ${cid?.toString() || 'unknown'}`);
      processWithConcurrencyLimit(async () => {
        try {
          console.log(`[Firehose] Inside handler for ${commitEvt.event} event for ${did}/${rkey}`);
          if (commitEvt.event === 'delete') {
            await handleSiteDelete(did, rkey);
          } else {
            // For create/update, we need to verify the record from PDS
            // The firehose record might be incomplete
            const verified = await fetchSiteRecord(did, rkey);
            if (verified) {
              await handleSiteCreateOrUpdate(did, rkey, verified.record, verified.cid);
            } else {
              console.log(`[Firehose] Skipping ${commitEvt.event} event for ${did}/${rkey} - verification failed`);
            }
          }
          console.log(`[Firehose] Completed handler for ${commitEvt.event} event for ${did}/${rkey}`);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error('[Firehose] Error handling place.wisp.fs event:', { did, rkey, event: commitEvt.event, error: error.message, stack: error.stack });
        }
      }).catch(err => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[Firehose] Error processing place.wisp.fs event:', { did, rkey, event: commitEvt.event, error: error.message, stack: error.stack });
      });
    }

    // Handle place.wisp.settings events
    if (collection === 'place.wisp.settings') {
      processWithConcurrencyLimit(async () => {
        try {
          if (commitEvt.event === 'delete') {
            await handleSettingsDelete(did, rkey);
          } else if (record) {
            const cidStr = cid?.toString() || '';
            await handleSettingsUpdate(did, rkey, record as WispSettings, cidStr);
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error('[Firehose] Error handling place.wisp.settings event:', { did, rkey, event: commitEvt.event, error: error.message, stack: error.stack });
        }
      }).catch(err => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[Firehose] Error processing place.wisp.settings event:', { did, rkey, event: commitEvt.event, error: error.message, stack: error.stack });
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[Firehose] Unexpected error in handleEvent:', { error: error.message, stack: error.stack });
  }
}

function handleError(err: Error): void {
  console.error('[Firehose] Error:', err);
  console.error('[Firehose] Stack:', err.stack);
}

let firehoseHandle: { destroy: () => void } | null = null;

/**
 * Start the firehose worker
 */
export function startFirehose(): void {
  console.log(`[Firehose] Starting (runtime: ${isBun ? 'Bun' : 'Node.js'})`);
  console.log(`[Firehose] Service: ${config.firehoseService}`);
  console.log(`[Firehose] Max concurrency: ${config.firehoseMaxConcurrency}`);

  isConnected = true;

  if (isBun) {
    // Use BunFirehose for Bun runtime
    const bunFirehose = new BunFirehose({
      idResolver,
      service: config.firehoseService,
      filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
      handleEvent,
      onError: handleError,
    });
    bunFirehose.start();
    firehoseHandle = { destroy: () => bunFirehose.destroy() };
  } else {
    // Use @atproto/sync Firehose for Node.js
    const nodeFirehose = new Firehose({
      idResolver,
      service: config.firehoseService,
      filterCollections: ['place.wisp.fs', 'place.wisp.settings'],
      handleEvent: handleEvent as any,
      onError: handleError,
    });
    nodeFirehose.start();
    firehoseHandle = { destroy: () => nodeFirehose.destroy() };
  }

  // Log cache info hourly
  setInterval(() => {
    console.log('[Firehose] Hourly status check');
  }, 60 * 60 * 1000);

  // Log status periodically
  setInterval(() => {
    const health = getFirehoseHealth();
    if (health.timeSinceLastEvent > 30000) {
      console.log(`[Firehose] No events for ${Math.round(health.timeSinceLastEvent / 1000)}s`);
    }
  }, 30000);
}

/**
 * Stop the firehose worker
 */
export function stopFirehose(): void {
  console.log('[Firehose] Stopping');
  isConnected = false;
  firehoseHandle?.destroy();
  firehoseHandle = null;
}
