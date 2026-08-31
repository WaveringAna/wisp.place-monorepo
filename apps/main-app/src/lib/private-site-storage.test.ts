import { describe, expect, test } from 'bun:test'
import { resolvePrivateStorageConfiguration } from './private-site-storage'

describe('private durable storage configuration', () => {
	test('allows disk only in explicit test or development modes', () => {
		expect(resolvePrivateStorageConfiguration({ NODE_ENV: 'test' })).toEqual({
			mode: 'disk',
			directory: './cache/private-sites',
		})
		expect(resolvePrivateStorageConfiguration({ NODE_ENV: 'development', PRIVATE_CACHE_DIR: '/tmp/private' })).toEqual({
			mode: 'disk',
			directory: '/tmp/private',
		})
	})

	test('fails closed without durable S3 outside explicit local modes', () => {
		expect(() => resolvePrivateStorageConfiguration({ NODE_ENV: 'production' })).toThrow('private durable S3 storage')
		expect(() => resolvePrivateStorageConfiguration({ NODE_ENV: 'staging' })).toThrow('private durable S3 storage')
		expect(() => resolvePrivateStorageConfiguration({})).toThrow('private durable S3 storage')
	})

	test('requires an explicit shared-bucket opt-in', () => {
		expect(() =>
			resolvePrivateStorageConfiguration({ NODE_ENV: 'production', S3_BUCKET: 'shared-private-bucket' }),
		).toThrow('PRIVATE_ALLOW_SHARED_BUCKET=true')

		expect(
			resolvePrivateStorageConfiguration({
				NODE_ENV: 'production',
				S3_BUCKET: 'shared-private-bucket',
				PRIVATE_ALLOW_SHARED_BUCKET: 'true',
				PRIVATE_S3_PREFIX: 'isolated-prefix/',
			}),
		).toMatchObject({ mode: 's3', region: 'us-east-1', prefix: 'isolated-prefix/' })
	})

	test('uses a separate private S3 bucket without shared-bucket opt-in', () => {
		expect(
			resolvePrivateStorageConfiguration({
				NODE_ENV: 'production',
				S3_BUCKET: 'public-bucket',
				PRIVATE_S3_BUCKET: 'private-bucket',
				PRIVATE_S3_REGION: 'eu-central-1',
			}),
		).toMatchObject({ mode: 's3', bucket: 'private-bucket', region: 'eu-central-1' })
	})
})
