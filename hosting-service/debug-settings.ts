#!/usr/bin/env tsx
/**
 * Debug script to check cached settings for a site
 * Usage: tsx debug-settings.ts <did> <rkey>
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

const CACHE_DIR = './cache';

async function debugSettings(did: string, rkey: string) {
  const metadataPath = `${CACHE_DIR}/${did}/${rkey}/.metadata.json`;

  console.log('Checking metadata at:', metadataPath);
  console.log('Exists:', existsSync(metadataPath));

  if (!existsSync(metadataPath)) {
    console.log('\n❌ Metadata file does not exist - site may not be cached yet');
    return;
  }

  const content = await readFile(metadataPath, 'utf-8');
  const metadata = JSON.parse(content);

  console.log('\n=== Cached Metadata ===');
  console.log('CID:', metadata.cid);
  console.log('Cached at:', metadata.cachedAt);
  console.log('\n=== Settings ===');
  if (metadata.settings) {
    console.log(JSON.stringify(metadata.settings, null, 2));
  } else {
    console.log('❌ No settings found in metadata');
    console.log('This means:');
    console.log('  1. No place.wisp.settings record exists on the PDS');
    console.log('  2. Or the firehose hasn\'t picked up the settings yet');
    console.log('\nTo fix:');
    console.log('  1. Create a place.wisp.settings record with the same rkey');
    console.log('  2. Wait for firehose to pick it up (a few seconds)');
    console.log('  3. Or manually re-cache the site');
  }
}

const [did, rkey] = process.argv.slice(2);
if (!did || !rkey) {
  console.log('Usage: tsx debug-settings.ts <did> <rkey>');
  console.log('Example: tsx debug-settings.ts did:plc:abc123 my-site');
  process.exit(1);
}

debugSettings(did, rkey).catch(console.error);
