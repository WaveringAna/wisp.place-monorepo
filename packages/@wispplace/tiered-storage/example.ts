/**
 * Example usage of the tiered-storage library
 *
 * Run with: bun run example
 *
 * Note: This example uses S3 for cold storage. You'll need to configure
 * AWS credentials and an S3 bucket in .env (see .env.example)
 */

import { TieredStorage, MemoryStorageTier, DiskStorageTier, S3StorageTier } from './src/index.js';
import { rm } from 'node:fs/promises';

// Configuration from environment variables
const S3_BUCKET = process.env.S3_BUCKET || 'tiered-storage-example';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== 'false'; // Default true
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

async function basicExample() {
  console.log('\n=== Basic Example ===\n');

  const storage = new TieredStorage({
    tiers: {
      hot: new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 }), // 10MB
      warm: new DiskStorageTier({ directory: './example-cache/basic/warm' }),
      cold: new S3StorageTier({
        bucket: S3_BUCKET,
        region: S3_REGION,
        endpoint: S3_ENDPOINT,
        forcePathStyle: S3_FORCE_PATH_STYLE,
        credentials:
          AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: AWS_ACCESS_KEY_ID,
                secretAccessKey: AWS_SECRET_ACCESS_KEY,
              }
            : undefined,
        prefix: 'example/basic/',
      }),
    },
    compression: true,
    defaultTTL: 60 * 60 * 1000, // 1 hour
  });

  // Store some data
  console.log('Storing user data...');
  await storage.set('user:alice', {
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',
  });

  await storage.set('user:bob', {
    name: 'Bob',
    email: 'bob@example.com',
    role: 'user',
  });

  // Retrieve with metadata
  const result = await storage.getWithMetadata('user:alice');
  if (result) {
    console.log(`Retrieved user:alice from ${result.source} tier:`);
    console.log(result.data);
    console.log('Metadata:', {
      size: result.metadata.size,
      compressed: result.metadata.compressed,
      accessCount: result.metadata.accessCount,
    });
  }

  // Get statistics
  const stats = await storage.getStats();
  console.log('\nStorage Statistics:');
  console.log(`Hot tier: ${stats.hot?.items} items, ${stats.hot?.bytes} bytes`);
  console.log(`Warm tier: ${stats.warm?.items} items, ${stats.warm?.bytes} bytes`);
  console.log(`Cold tier (S3): ${stats.cold.items} items, ${stats.cold.bytes} bytes`);
  console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(2)}%`);

  // List all keys with prefix
  console.log('\nAll user keys:');
  for await (const key of storage.listKeys('user:')) {
    console.log(`  - ${key}`);
  }

  // Invalidate by prefix
  console.log('\nInvalidating all user keys...');
  const deleted = await storage.invalidate('user:');
  console.log(`Deleted ${deleted} keys`);
}

async function staticSiteHostingExample() {
  console.log('\n=== Static Site Hosting Example (wisp.place pattern) ===\n');

  const storage = new TieredStorage({
    tiers: {
      hot: new MemoryStorageTier({
        maxSizeBytes: 50 * 1024 * 1024, // 50MB
        maxItems: 500,
      }),
      warm: new DiskStorageTier({
        directory: './example-cache/sites/warm',
        maxSizeBytes: 1024 * 1024 * 1024, // 1GB
      }),
      cold: new S3StorageTier({
        bucket: S3_BUCKET,
        region: S3_REGION,
        endpoint: S3_ENDPOINT,
        forcePathStyle: S3_FORCE_PATH_STYLE,
        credentials:
          AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: AWS_ACCESS_KEY_ID,
                secretAccessKey: AWS_SECRET_ACCESS_KEY,
              }
            : undefined,
        prefix: 'example/sites/',
      }),
    },
    compression: true,
    defaultTTL: 14 * 24 * 60 * 60 * 1000, // 14 days
    promotionStrategy: 'lazy', // Don't auto-promote large files
  });

  const siteId = 'did:plc:abc123';
  const siteName = 'tiered-cache-demo';

  console.log('Loading real static site from example-site/...\n');

  // Load actual site files
  const { readFile } = await import('node:fs/promises');

  const files = [
    { name: 'index.html', skipTiers: [], mimeType: 'text/html' },
    { name: 'about.html', skipTiers: ['hot'], mimeType: 'text/html' },
    { name: 'docs.html', skipTiers: ['hot'], mimeType: 'text/html' },
    { name: 'style.css', skipTiers: ['hot'], mimeType: 'text/css' },
    { name: 'script.js', skipTiers: ['hot'], mimeType: 'application/javascript' },
  ];

  console.log('Storing site files with selective tier placement:\n');

  for (const file of files) {
    const content = await readFile(`./example-site/${file.name}`, 'utf-8');
    const key = `${siteId}/${siteName}/${file.name}`;

    await storage.set(key, content, {
      skipTiers: file.skipTiers as ('hot' | 'warm')[],
      metadata: { mimeType: file.mimeType },
    });

    const tierInfo =
      file.skipTiers.length === 0
        ? 'hot + warm + cold (S3)'
        : `warm + cold (S3) - skipped ${file.skipTiers.join(', ')}`;
    const sizeKB = (content.length / 1024).toFixed(2);
    console.log(`✓ ${file.name} (${sizeKB} KB) → ${tierInfo}`);
  }

  // Check where each file is served from
  console.log('\nServing files (checking which tier):');
  for (const file of files) {
    const result = await storage.getWithMetadata(`${siteId}/${siteName}/${file.name}`);
    if (result) {
      const sizeKB = (result.metadata.size / 1024).toFixed(2);
      console.log(`  ${file.name}: served from ${result.source} (${sizeKB} KB)`);
    }
  }

  // Show hot tier only has index.html
  console.log('\nHot tier contents (should only contain index.html):');
  const stats = await storage.getStats();
  console.log(`  Items: ${stats.hot?.items}`);
  console.log(`  Size: ${((stats.hot?.bytes ?? 0) / 1024).toFixed(2)} KB`);
  console.log(`  Files: index.html only`);

  console.log('\nWarm tier contents (all site files):');
  console.log(`  Items: ${stats.warm?.items}`);
  console.log(`  Size: ${((stats.warm?.bytes ?? 0) / 1024).toFixed(2)} KB`);
  console.log(`  Files: all ${files.length} files`);

  // Demonstrate accessing a page
  console.log('\nSimulating page request for about.html:');
  const aboutPage = await storage.getWithMetadata(`${siteId}/${siteName}/about.html`);
  if (aboutPage) {
    console.log(`  Source: ${aboutPage.source} tier`);
    console.log(`  Access count: ${aboutPage.metadata.accessCount}`);
    console.log(`  Preview: ${aboutPage.data.toString().slice(0, 100)}...`);
  }

  // Invalidate entire site
  console.log(`\nInvalidating entire site: ${siteId}/${siteName}/`);
  const deleted = await storage.invalidate(`${siteId}/${siteName}/`);
  console.log(`Deleted ${deleted} files from all tiers`);
}

async function bootstrapExample() {
  console.log('\n=== Bootstrap Example ===\n');

  const hot = new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 });
  const warm = new DiskStorageTier({ directory: './example-cache/bootstrap/warm' });
  const cold = new S3StorageTier({
    bucket: S3_BUCKET,
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: S3_FORCE_PATH_STYLE,
    credentials:
      AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
    prefix: 'example/bootstrap/',
  });

  const storage = new TieredStorage({
    tiers: { hot, warm, cold },
  });

  // Populate with some data
  console.log('Populating storage with test data...');
  for (let i = 0; i < 10; i++) {
    await storage.set(`item:${i}`, {
      id: i,
      name: `Item ${i}`,
      description: `This is item number ${i}`,
    });
  }

  // Access some items to build up access counts
  console.log('Accessing some items to simulate usage patterns...');
  await storage.get('item:0'); // Most accessed
  await storage.get('item:0');
  await storage.get('item:0');
  await storage.get('item:1'); // Second most accessed
  await storage.get('item:1');
  await storage.get('item:2'); // Third most accessed

  // Clear hot tier to simulate server restart
  console.log('\nSimulating server restart (clearing hot tier)...');
  await hot.clear();

  let hotStats = await hot.getStats();
  console.log(`Hot tier after clear: ${hotStats.items} items`);

  // Bootstrap hot from warm (loads most accessed items)
  console.log('\nBootstrapping hot tier from warm (loading top 3 items)...');
  const loaded = await storage.bootstrapHot(3);
  console.log(`Loaded ${loaded} items into hot tier`);

  hotStats = await hot.getStats();
  console.log(`Hot tier after bootstrap: ${hotStats.items} items`);

  // Verify the right items were loaded
  console.log('\nVerifying loaded items are served from hot:');
  for (let i = 0; i < 3; i++) {
    const result = await storage.getWithMetadata(`item:${i}`);
    console.log(`  item:${i}: ${result?.source}`);
  }

  // Cleanup this example's data
  console.log('\nCleaning up bootstrap example data...');
  await storage.invalidate('item:');
}

async function streamingExample() {
  console.log('\n=== Streaming Example ===\n');

  const { createReadStream, statSync } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');

  const storage = new TieredStorage({
    tiers: {
      hot: new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 }), // 10MB
      warm: new DiskStorageTier({ directory: './example-cache/streaming/warm' }),
      cold: new S3StorageTier({
        bucket: S3_BUCKET,
        region: S3_REGION,
        endpoint: S3_ENDPOINT,
        forcePathStyle: S3_FORCE_PATH_STYLE,
        credentials:
          AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: AWS_ACCESS_KEY_ID,
                secretAccessKey: AWS_SECRET_ACCESS_KEY,
              }
            : undefined,
        prefix: 'example/streaming/',
      }),
    },
    compression: true, // Streams will be compressed automatically
    defaultTTL: 60 * 60 * 1000, // 1 hour
  });

  // Stream a file to storage
  const filePath = './example-site/index.html';
  const fileStats = statSync(filePath);

  console.log(`Streaming ${filePath} (${fileStats.size} bytes) with compression...`);

  const readStream = createReadStream(filePath);
  const result = await storage.setStream('streaming/index.html', readStream, {
    size: fileStats.size,
    mimeType: 'text/html',
  });

  console.log(`✓ Stored with key: ${result.key}`);
  console.log(`  Original size: ${result.metadata.size} bytes`);
  console.log(`  Compressed: ${result.metadata.compressed}`);
  console.log(`  Checksum (original data): ${result.metadata.checksum.slice(0, 16)}...`);
  console.log(`  Written to tiers: ${result.tiersWritten.join(', ')}`);

  // Stream the file back (automatically decompressed)
  console.log('\nStreaming back the file (with automatic decompression)...');

  const streamResult = await storage.getStream('streaming/index.html');
  if (streamResult) {
    console.log(`✓ Streaming from: ${streamResult.source} tier`);
    console.log(`  Metadata size: ${streamResult.metadata.size} bytes`);
    console.log(`  Compressed in storage: ${streamResult.metadata.compressed}`);

    // Collect stream data to verify content
    const chunks: Buffer[] = [];
    for await (const chunk of streamResult.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks);

    console.log(`  Retrieved size: ${content.length} bytes`);
    console.log(`  Content preview: ${content.toString('utf-8').slice(0, 100)}...`);

    // Verify the content matches the original
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(filePath);
    if (content.equals(original)) {
      console.log('  ✓ Content matches original file!');
    } else {
      console.log('  ✗ Content does NOT match original file');
    }
  }

  // Example: Stream to a writable destination (like an HTTP response)
  console.log('\nStreaming to destination (simulated HTTP response)...');
  const streamResult2 = await storage.getStream('streaming/index.html');
  if (streamResult2) {
    // In a real server, you would do: streamResult2.stream.pipe(res);
    // Here we just demonstrate the pattern
    const { Writable } = await import('node:stream');
    let totalBytes = 0;
    const mockResponse = new Writable({
      write(chunk, _encoding, callback) {
        totalBytes += chunk.length;
        callback();
      },
    });

    await pipeline(streamResult2.stream, mockResponse);
    console.log(`✓ Streamed ${totalBytes} bytes to destination`);
  }

  // Cleanup
  console.log('\nCleaning up streaming example data...');
  await storage.invalidate('streaming/');
}

async function promotionStrategyExample() {
  console.log('\n=== Promotion Strategy Example ===\n');

  // Lazy promotion (default)
  console.log('Testing LAZY promotion:');
  const lazyStorage = new TieredStorage({
    tiers: {
      hot: new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 }),
      warm: new DiskStorageTier({ directory: './example-cache/promo-lazy/warm' }),
      cold: new S3StorageTier({
        bucket: S3_BUCKET,
        region: S3_REGION,
        endpoint: S3_ENDPOINT,
        forcePathStyle: S3_FORCE_PATH_STYLE,
        credentials:
          AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: AWS_ACCESS_KEY_ID,
                secretAccessKey: AWS_SECRET_ACCESS_KEY,
              }
            : undefined,
        prefix: 'example/promo-lazy/',
      }),
    },
    promotionStrategy: 'lazy',
  });

  // Write data and clear hot
  await lazyStorage.set('test:lazy', { value: 'lazy test' });
  await lazyStorage.clearTier('hot');

  // Read from cold (should NOT auto-promote to hot)
  const lazyResult = await lazyStorage.getWithMetadata('test:lazy');
  console.log(`  First read served from: ${lazyResult?.source}`);

  const lazyResult2 = await lazyStorage.getWithMetadata('test:lazy');
  console.log(`  Second read served from: ${lazyResult2?.source} (lazy = no auto-promotion)`);

  // Eager promotion
  console.log('\nTesting EAGER promotion:');
  const eagerStorage = new TieredStorage({
    tiers: {
      hot: new MemoryStorageTier({ maxSizeBytes: 10 * 1024 * 1024 }),
      warm: new DiskStorageTier({ directory: './example-cache/promo-eager/warm' }),
      cold: new S3StorageTier({
        bucket: S3_BUCKET,
        region: S3_REGION,
        endpoint: S3_ENDPOINT,
        forcePathStyle: S3_FORCE_PATH_STYLE,
        credentials:
          AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
            ? {
                accessKeyId: AWS_ACCESS_KEY_ID,
                secretAccessKey: AWS_SECRET_ACCESS_KEY,
              }
            : undefined,
        prefix: 'example/promo-eager/',
      }),
    },
    promotionStrategy: 'eager',
  });

  // Write data and clear hot
  await eagerStorage.set('test:eager', { value: 'eager test' });
  await eagerStorage.clearTier('hot');

  // Read from cold (SHOULD auto-promote to hot)
  const eagerResult = await eagerStorage.getWithMetadata('test:eager');
  console.log(`  First read served from: ${eagerResult?.source}`);

  const eagerResult2 = await eagerStorage.getWithMetadata('test:eager');
  console.log(`  Second read served from: ${eagerResult2?.source} (eager = promoted to hot)`);

  // Cleanup
  await lazyStorage.invalidate('test:');
  await eagerStorage.invalidate('test:');
}

async function cleanup() {
  console.log('\n=== Cleanup ===\n');
  console.log('Removing example cache directories...');
  await rm('./example-cache', { recursive: true, force: true });
  console.log('✓ Local cache directories removed');
  console.log('\nNote: S3 objects with prefix "example/" remain in bucket');
  console.log('      (remove manually if needed)');
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   Tiered Storage Library - Usage Examples     ║');
  console.log('║   Cold Tier: S3 (or S3-compatible storage)    ║');
  console.log('╚════════════════════════════════════════════════╝');

  // Check for S3 configuration
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    console.log('\n⚠️  Warning: AWS credentials not configured');
    console.log('   Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env');
    console.log('   (See .env.example for configuration options)\n');
  }

  console.log('\nConfiguration:');
  console.log(`  S3 Bucket: ${S3_BUCKET}`);
  console.log(`  S3 Region: ${S3_REGION}`);
  console.log(`  S3 Endpoint: ${S3_ENDPOINT || '(default AWS S3)'}`);
  console.log(`  Force Path Style: ${S3_FORCE_PATH_STYLE}`);
  console.log(`  Credentials: ${AWS_ACCESS_KEY_ID ? '✓ Configured' : '✗ Not configured (using IAM role)'}`);

  try {
    // Test S3 connection first
    console.log('\nTesting S3 connection...');
    const testStorage = new S3StorageTier({
      bucket: S3_BUCKET,
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      forcePathStyle: S3_FORCE_PATH_STYLE,
      credentials:
        AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: AWS_ACCESS_KEY_ID,
              secretAccessKey: AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
      prefix: 'test/',
    });

    try {
      await testStorage.set('connection-test', new TextEncoder().encode('test'), {
        key: 'connection-test',
        size: 4,
        createdAt: new Date(),
        lastAccessed: new Date(),
        accessCount: 0,
        compressed: false,
        checksum: 'test',
      });
      console.log('✓ S3 connection successful!\n');
      await testStorage.delete('connection-test');
    } catch (error: any) {
      console.error('✗ S3 connection failed:', error.message);
      console.error('\nPossible issues:');
      console.error('  1. Check that the bucket exists on your S3 service');
      console.error('  2. Verify credentials have read/write permissions');
      console.error('  3. Confirm the endpoint URL is correct');
      console.error('  4. Try setting S3_REGION to a different value (e.g., "us-east-1" or "auto")');
      console.error('\nSkipping examples due to S3 connection error.\n');
      return;
    }

    await basicExample();
    await staticSiteHostingExample();
    await streamingExample();
    await bootstrapExample();
    await promotionStrategyExample();
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.name === 'NoSuchBucket') {
      console.error(`\n   The S3 bucket "${S3_BUCKET}" does not exist.`);
      console.error('   Create it first or set S3_BUCKET in .env to an existing bucket.\n');
    }
  } finally {
    await cleanup();
  }

  console.log('\n✅ All examples completed successfully!');
  console.log('\nTry modifying this file to experiment with different patterns.');
}

main().catch(console.error);
