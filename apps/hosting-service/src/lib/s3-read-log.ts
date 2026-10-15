import { createHash } from 'node:crypto'
import { createLogger } from '@wispplace/observability'
import type { S3Request } from '@wispplace/tiered-storage'

/**
 * One log line per S3 GetObject, so repeat cold reads of the same object on an
 * edge can be counted. Keys are shared CAS bodies (`cas/<hash>`) or pre-rewritten
 * HTML under `<did>/<rkey>/.rewritten/<path>`; logs never carry site file
 * paths, so the line names the key by a short hash and its kind only.
 */
export type S3ReadLine = {
	keyHash: string
	keyKind: 'cas' | 'rewritten' | 'other'
	outcome: S3Request['outcome']
	durationMs: number
}

const logger = createLogger('hosting-service')

function keyKind(key: string): S3ReadLine['keyKind'] {
	if (key.includes('/.rewritten/')) return 'rewritten'
	return /(^|\/)cas\//.test(key) ? 'cas' : 'other'
}

export function s3ReadLine(request: S3Request): S3ReadLine | null {
	if (request.operation !== 'GetObject' || request.key === undefined) return null
	return {
		keyHash: createHash('sha256').update(request.key).digest('hex').slice(0, 16),
		keyKind: keyKind(request.key),
		outcome: request.outcome,
		durationMs: Math.round(request.durationMs),
	}
}

export function logS3Read(request: S3Request): void {
	const line = s3ReadLine(request)
	if (line) logger.info('[S3] GetObject', line)
}
