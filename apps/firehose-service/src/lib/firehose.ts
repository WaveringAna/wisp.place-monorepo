/**
 * Firehose worker - watches AT Protocol firehose for site changes
 * Uses BunFirehose for Bun runtime, @atproto/sync for Node.js
 */

import { IdResolver } from '@atproto/identity';
import { Firehose } from '@atproto/sync';
import { isBun, BunFirehose, type Event, type CommitEvt } from '@wispplace/bun-firehose';
import type { Record as WispFsRecord } from '@wispplace/lexicons/types/place/wisp/fs';
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings';
import { createLogger } from '@wispplace/observability';
import { config } from '../config';
import {
  handleSiteCreateOrUpdate,
  handleSiteDelete,
  handleSettingsUpdate,
  handleSettingsDelete,
  fetchSiteRecord,
} from './cache-writer';

const idResolver = new IdResolver();
const logger = createLogger('firehose-service');

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

    logger.debug(`Event ${evt.event} for ${collection}:${did}/${rkey}`, { cid: cid?.toString() || 'unknown' });

    // Handle place.wisp.fs events
    if (collection === 'place.wisp.fs') {
      logger.info(`[place.wisp.fs] Received ${commitEvt.event} event`, { did, rkey, cid: cid?.toString() || 'unknown' });
      processWithConcurrencyLimit(async () => {
        try {
          logger.debug(`[place.wisp.fs] Processing ${commitEvt.event} event`, { did, rkey });
          if (commitEvt.event === 'delete') {
            await handleSiteDelete(did, rkey);
          } else {
            // For create/update, we need to verify the record from PDS
            // The firehose record might be incomplete
            const verified = await fetchSiteRecord(did, rkey);
            if (verified) {
              await handleSiteCreateOrUpdate(did, rkey, verified.record, verified.cid);
            } else {
              logger.warn(`[place.wisp.fs] Skipping ${commitEvt.event} event - verification failed`, { did, rkey });
            }
          }
          logger.debug(`[place.wisp.fs] Completed ${commitEvt.event} event`, { did, rkey });
        } catch (err) {
          logger.error(`[place.wisp.fs] Error handling event`, err, { did, rkey, event: commitEvt.event });
        }
      }).catch(err => {
        logger.error(`[place.wisp.fs] Error processing event`, err, { did, rkey, event: commitEvt.event });
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
          logger.error(`[place.wisp.settings] Error handling event`, err, { did, rkey, event: commitEvt.event });
        }
      }).catch(err => {
        logger.error(`[place.wisp.settings] Error processing event`, err, { did, rkey, event: commitEvt.event });
      });
    }
  } catch (err) {
    logger.error('Unexpected error in handleEvent', err);
  }
}

function handleError(err: Error): void {
  logger.error('Firehose connection error', err);
}

let firehoseHandle: { destroy: () => void } | null = null;

/**
 * Start the firehose worker
 */
export function startFirehose(): void {
  logger.info(`Starting firehose (runtime: ${isBun ? 'Bun' : 'Node.js'})`);
  logger.info(`Service: ${config.firehoseService}`);
  logger.info(`Max concurrency: ${config.firehoseMaxConcurrency}`);

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
    logger.info('Hourly status check');
  }, 60 * 60 * 1000);

  // Log status periodically
  setInterval(() => {
    const health = getFirehoseHealth();
    if (health.timeSinceLastEvent > 30000) {
      logger.warn(`No events for ${Math.round(health.timeSinceLastEvent / 1000)}s`);
    }
  }, 30000);
}

/**
 * Stop the firehose worker
 */
export function stopFirehose(): void {
  logger.info('Stopping firehose');
  isConnected = false;
  firehoseHandle?.destroy();
  firehoseHandle = null;
}
