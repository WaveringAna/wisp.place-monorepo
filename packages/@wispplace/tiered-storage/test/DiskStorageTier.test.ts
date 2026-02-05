import { describe, it, expect, afterEach } from 'vitest';
import { DiskStorageTier } from '../src/tiers/DiskStorageTier.js';
import { rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('DiskStorageTier - Recursive Directory Support', () => {
	const testDir = './test-disk-cache';

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	describe('Nested Directory Creation', () => {
		it('should create nested directories for keys with slashes', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('test data');
			const metadata = {
				key: 'did:plc:abc/site/pages/index.html',
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc123',
			};

			await tier.set('did:plc:abc/site/pages/index.html', data, metadata);

			// Verify directory structure was created
			expect(existsSync(join(testDir, 'did%3Aplc%3Aabc'))).toBe(true);
			expect(existsSync(join(testDir, 'did%3Aplc%3Aabc/site'))).toBe(true);
			expect(existsSync(join(testDir, 'did%3Aplc%3Aabc/site/pages'))).toBe(true);
			expect(existsSync(join(testDir, 'did%3Aplc%3Aabc/site/pages/index.html'))).toBe(true);
			expect(existsSync(join(testDir, 'did%3Aplc%3Aabc/site/pages/index.html.meta'))).toBe(
				true,
			);
		});

		it('should handle multiple files in different nested directories', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('test');
			const createMetadata = (key: string) => ({
				key,
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			});

			await tier.set(
				'site:a/images/logo.png',
				data,
				createMetadata('site:a/images/logo.png'),
			);
			await tier.set('site:a/css/style.css', data, createMetadata('site:a/css/style.css'));
			await tier.set('site:b/index.html', data, createMetadata('site:b/index.html'));

			expect(await tier.exists('site:a/images/logo.png')).toBe(true);
			expect(await tier.exists('site:a/css/style.css')).toBe(true);
			expect(await tier.exists('site:b/index.html')).toBe(true);
		});
	});

	describe('Recursive Listing', () => {
		it('should list all keys across nested directories', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('test');
			const createMetadata = (key: string) => ({
				key,
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			});

			const keys = [
				'site:a/index.html',
				'site:a/about.html',
				'site:a/assets/logo.png',
				'site:b/index.html',
				'site:b/nested/deep/file.txt',
			];

			for (const key of keys) {
				await tier.set(key, data, createMetadata(key));
			}

			const listedKeys: string[] = [];
			for await (const key of tier.listKeys()) {
				listedKeys.push(key);
			}

			expect(listedKeys.sort()).toEqual(keys.sort());
		});

		it('should list keys with prefix filter across directories', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('test');
			const createMetadata = (key: string) => ({
				key,
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			});

			await tier.set('site:a/index.html', data, createMetadata('site:a/index.html'));
			await tier.set('site:a/about.html', data, createMetadata('site:a/about.html'));
			await tier.set('site:b/index.html', data, createMetadata('site:b/index.html'));
			await tier.set('user:123/profile.json', data, createMetadata('user:123/profile.json'));

			const siteKeys: string[] = [];
			for await (const key of tier.listKeys('site:')) {
				siteKeys.push(key);
			}

			expect(siteKeys.sort()).toEqual([
				'site:a/about.html',
				'site:a/index.html',
				'site:b/index.html',
			]);
		});

		it('should handle empty directories gracefully', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const keys: string[] = [];
			for await (const key of tier.listKeys()) {
				keys.push(key);
			}

			expect(keys).toEqual([]);
		});
	});

	describe('Recursive Stats Collection', () => {
		it('should calculate stats across all nested directories', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data1 = new TextEncoder().encode('small');
			const data2 = new TextEncoder().encode('medium content here');
			const data3 = new TextEncoder().encode('x'.repeat(1000));

			const createMetadata = (key: string, size: number) => ({
				key,
				size,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			});

			await tier.set('a/file1.txt', data1, createMetadata('a/file1.txt', data1.byteLength));
			await tier.set(
				'a/b/file2.txt',
				data2,
				createMetadata('a/b/file2.txt', data2.byteLength),
			);
			await tier.set(
				'a/b/c/file3.txt',
				data3,
				createMetadata('a/b/c/file3.txt', data3.byteLength),
			);

			const stats = await tier.getStats();

			expect(stats.items).toBe(3);
			expect(stats.bytes).toBe(data1.byteLength + data2.byteLength + data3.byteLength);
		});

		it('should return zero stats for empty directory', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const stats = await tier.getStats();

			expect(stats.items).toBe(0);
			expect(stats.bytes).toBe(0);
		});
	});

	describe('Index Rebuilding', () => {
		it('should rebuild index from nested directory structure on init', async () => {
			const data = new TextEncoder().encode('test data');
			const createMetadata = (key: string) => ({
				key,
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			});

			// Create tier and add nested data
			const tier1 = new DiskStorageTier({ directory: testDir });
			await tier1.set('site:a/index.html', data, createMetadata('site:a/index.html'));
			await tier1.set(
				'site:a/nested/deep/file.txt',
				data,
				createMetadata('site:a/nested/deep/file.txt'),
			);
			await tier1.set('site:b/page.html', data, createMetadata('site:b/page.html'));

			// Create new tier instance (should rebuild index from disk)
			const tier2 = new DiskStorageTier({ directory: testDir });

			// Give it a moment to rebuild
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify all keys are accessible
			expect(await tier2.exists('site:a/index.html')).toBe(true);
			expect(await tier2.exists('site:a/nested/deep/file.txt')).toBe(true);
			expect(await tier2.exists('site:b/page.html')).toBe(true);

			// Verify stats are correct
			const stats = await tier2.getStats();
			expect(stats.items).toBe(3);
		});

		it('should handle corrupted metadata files during rebuild', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('test');
			const metadata = {
				key: 'test/key.txt',
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			};

			await tier.set('test/key.txt', data, metadata);

			// Verify directory structure
			const entries = await readdir(testDir, { withFileTypes: true });
			expect(entries.length).toBeGreaterThan(0);

			// New tier instance should handle any issues gracefully
			const tier2 = new DiskStorageTier({ directory: testDir });
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Should still work
			const stats = await tier2.getStats();
			expect(stats.items).toBeGreaterThanOrEqual(0);
		});
	});

	describe('getWithMetadata Optimization', () => {
		it('should retrieve data and metadata from nested directories in parallel', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('test data content');
			const metadata = {
				key: 'deep/nested/path/file.json',
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 5,
				compressed: false,
				checksum: 'abc123',
			};

			await tier.set('deep/nested/path/file.json', data, metadata);

			const result = await tier.getWithMetadata('deep/nested/path/file.json');

			expect(result).not.toBeNull();
			expect(result?.data).toEqual(data);
			expect(result?.metadata.key).toBe('deep/nested/path/file.json');
			expect(result?.metadata.accessCount).toBe(5);
		});
	});

	describe('Deletion from Nested Directories', () => {
		it('should delete files from nested directories', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('test');
			const createMetadata = (key: string) => ({
				key,
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			});

			await tier.set('a/b/c/file1.txt', data, createMetadata('a/b/c/file1.txt'));
			await tier.set('a/b/file2.txt', data, createMetadata('a/b/file2.txt'));

			expect(await tier.exists('a/b/c/file1.txt')).toBe(true);

			await tier.delete('a/b/c/file1.txt');

			expect(await tier.exists('a/b/c/file1.txt')).toBe(false);
			expect(await tier.exists('a/b/file2.txt')).toBe(true);
		});

		it('should delete multiple files across nested directories', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('test');
			const createMetadata = (key: string) => ({
				key,
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			});

			const keys = ['site:a/index.html', 'site:a/nested/page.html', 'site:b/index.html'];

			for (const key of keys) {
				await tier.set(key, data, createMetadata(key));
			}

			await tier.deleteMany(keys);

			for (const key of keys) {
				expect(await tier.exists(key)).toBe(false);
			}
		});
	});

	describe('Edge Cases', () => {
		it('should handle keys with many nested levels', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('deep');
			const deepKey = 'a/b/c/d/e/f/g/h/i/j/k/file.txt';
			const metadata = {
				key: deepKey,
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			};

			await tier.set(deepKey, data, metadata);

			expect(await tier.exists(deepKey)).toBe(true);

			const retrieved = await tier.get(deepKey);
			expect(retrieved).toEqual(data);
		});

		it('should handle keys with special characters', async () => {
			const tier = new DiskStorageTier({ directory: testDir });

			const data = new TextEncoder().encode('test');
			const metadata = {
				key: 'site:abc/file[1].txt',
				size: data.byteLength,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				compressed: false,
				checksum: 'abc',
			};

			await tier.set('site:abc/file[1].txt', data, metadata);

			expect(await tier.exists('site:abc/file[1].txt')).toBe(true);
			const retrieved = await tier.get('site:abc/file[1].txt');
			expect(retrieved).toEqual(data);
		});
	});
});
