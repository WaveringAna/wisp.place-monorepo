// Run from the repository root: bun cli-rs/crates/wispplace-core/tests/fixtures/generate-blobs.ts
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { computeCID } from '../../../../../packages/@wispplace/atproto-utils/src/blob'
import { compressFile } from '../../../../../packages/@wispplace/atproto-utils/src/compression'
import {
	type FileUploadResult,
	processUploadedFiles,
	updateFileBlobs,
} from '../../../../../packages/@wispplace/fs-utils/src/tree'

const random = Buffer.alloc(1024 * 1024)
let seed = 123456789
for (let i = 0; i < random.length; i++) {
	seed ^= seed << 13
	seed ^= seed >>> 17
	seed ^= seed << 5
	random[i] = seed & 255
}
const root = dirname(import.meta.path)
// Resolve the CLI's dependency versions without introducing a fixture package.
const { lookup, charsets } = createRequire(join(root, '../../../../../cli/package.json'))('mime-types') as {
	lookup(extension: string): string | false
	charsets: { lookup(mime: string): string | false }
}
const fixtures: [string, Buffer][] = [
	['empty', Buffer.alloc(0)],
	['text', Buffer.from('hello, wisp!\n')],
	['random', random],
]
// Only the CIDs are kept; blob.rs rebuilds the same inputs.
const metadata = fixtures.map(([name, input]) => ({
	name,
	cid: computeCID(input),
	gzipCid: computeCID(compressFile(input)),
}))
writeFileSync(join(root, 'blobs.json'), JSON.stringify(metadata, null, 2))

const paths = ['a/b/index.html', 'index.html', 'a/other.html']
const blob = {
	$type: 'blob',
	ref: { $link: computeCID(Buffer.from('hello')) },
	mimeType: 'application/octet-stream',
	size: 5,
}
const uploaded = paths.map((name) => ({ name, content: Buffer.alloc(0), mimeType: 'text/html', size: 0 }))
const results = paths.map(() => ({
	hash: '',
	blobRef: blob as unknown as FileUploadResult['blobRef'],
	encoding: 'gzip' as const,
	mimeType: 'text/html',
	base64: false,
}))
const { directory } = processUploadedFiles(uploaded, { skipNormalization: true })
writeFileSync(
	join(root, 'tree.json'),
	JSON.stringify(updateFileBlobs(directory, results, paths, '', new Set(paths), { skipNormalization: true }), null, 2),
)
const extensions = [
	'html',
	'css',
	'js',
	'JS',
	'mjs',
	'cjs',
	'json',
	'map',
	'xml',
	'svg',
	'txt',
	'csv',
	'md',
	'wasm',
	'ico',
	'jpg',
	'jpeg',
	'png',
	'webp',
	'avif',
	'woff',
	'woff2',
	'ttf',
	'otf',
	'wav',
	'aiff',
	'pdf',
	'webmanifest',
]
writeFileSync(
	join(root, 'mime.json'),
	JSON.stringify(
		extensions.map((extension) => {
			const mime = lookup(extension) || 'application/octet-stream'
			return { extension, mime, text: charsets.lookup(mime) === 'UTF-8' }
		}),
		null,
		2,
	),
)
