import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { computeCID } from '@wispplace/atproto-utils'
import { casKey } from '@wispplace/fs-utils'
import { S3StorageTier, type StorageMetadata } from '@wispplace/tiered-storage'
import { type MigrationPorts, migrateSite } from './cas-migration'

// The fakes in cas-migration.test.ts cannot show that a real S3-compatible backend honours CopyObject
// with replaced metadata and a source ETag fence. This runs against one (MinIO in the devnet):
//   WISP_TEST_S3_BUCKET=wisp-dev WISP_TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
//   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin bun test src/lib/cas-migration.s3.test.ts
const bucket = process.env.WISP_TEST_S3_BUCKET
const suite = bucket ? describe : describe.skip

const DID = 'did:plc:s3test'
const RKEY = 'site'
const body = new TextEncoder().encode('body { color: blue }')
const cid = computeCID(body)

suite('CAS migration against a real S3 backend', () => {
	const prefix = `cas-migration-test-${Math.random().toString(36).slice(2, 10)}/`
	let tier: S3StorageTier

	beforeAll(() => {
		tier = new S3StorageTier({
			bucket: bucket as string,
			region: process.env.S3_REGION || 'us-east-1',
			endpoint: process.env.WISP_TEST_S3_ENDPOINT,
			prefix,
			forcePathStyle: true,
		})
	})

	afterAll(async () => {
		await tier.clear()
	})

	const legacyMetadata = (key: string, checksum: string): StorageMetadata => ({
		key,
		size: body.byteLength,
		createdAt: new Date('2024-01-01T00:00:00Z'),
		lastAccessed: new Date('2024-01-01T00:00:00Z'),
		accessCount: 0,
		compressed: false,
		checksum,
		customMetadata: {
			sourceCid: cid,
			sourceDid: DID,
			mimeType: 'text/css',
			base64: 'false',
			uncompressedSize: `${body.byteLength}`,
		},
	})

	test('copies the body to its CAS key with its own metadata and leaves the original', async () => {
		const legacyKey = `${DID}/${RKEY}/style.css`
		await tier.set(legacyKey, body, legacyMetadata(legacyKey, 'checksum-1'))
		const registered: string[] = []
		const ports: MigrationPorts = {
			getMetadata: (key) => tier.getMetadata(key),
			readObject: (key) => tier.get(key),
			copyObject: (from, to, metadata, expected) => tier.copyObject(from, to, metadata, expected),
			registerObject: async (key) => {
				registered.push(key)
			},
			commitMapping: async () => 'committed',
			deleteObject: (key) => tier.delete(key),
			listLegacyKeys: async () => [],
		}

		const report = await migrateSite({ did: DID, rkey: RKEY, fileCids: { 'style.css': cid } }, ports, { dryRun: false })

		const key = casKey({ cid, path: 'style.css', mimeType: 'text/css' })
		expect(report).toMatchObject({ status: 'migrated', copied: 1 })
		const copied = await tier.getWithMetadata(key)
		expect(copied?.data).toEqual(body)
		expect(copied?.metadata.key).toBe(key)
		expect(copied?.metadata.customMetadata).toEqual({
			sourceCid: cid,
			mimeType: 'text/css',
			base64: 'false',
			uncompressedSize: `${body.byteLength}`,
		})
		expect((await tier.get(legacyKey))?.byteLength).toBe(body.byteLength)
		expect(registered).toEqual([key])
	})

	test('refuses to copy a source that was overwritten after it was classified', async () => {
		const legacyKey = `${DID}/${RKEY}/other.css`
		await tier.set(legacyKey, body, legacyMetadata(legacyKey, 'checksum-2'))

		const copied = await tier.copyObject(
			legacyKey,
			'cas/never',
			legacyMetadata('cas/never', 'checksum-2'),
			'checksum-from-before',
		)

		expect(copied).toBe(false)
		expect(await tier.getMetadata('cas/never')).toBeNull()
	})

	test('reports a missing source as not copied', async () => {
		expect(await tier.copyObject('no/such/key', 'cas/none', legacyMetadata('cas/none', 'x'), 'x')).toBe(false)
	})
})
