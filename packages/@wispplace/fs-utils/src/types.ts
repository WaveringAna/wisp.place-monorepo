import type { Directory, Entry, File, Subfs } from '@wispplace/lexicons/types/place/wisp/fs'
import type {
	Subfs as NestedSubfs,
	Directory as SubfsDirectory,
	Entry as SubfsEntry,
	File as SubfsFile,
} from '@wispplace/lexicons/types/place/wisp/subfs'
import type { $Typed } from '@wispplace/lexicons/util'

type FsNode = $Typed<File> | $Typed<Directory> | $Typed<Subfs>

function isKnownNode(node: Entry['node']): node is FsNode {
	return 'type' in node
}

function toTypedSubfsDirectory(directory: Directory): $Typed<SubfsDirectory, 'place.wisp.subfs#directory'> {
	return {
		...toSubfsDirectory(directory),
		$type: 'place.wisp.subfs#directory',
	}
}

export function toSubfsDirectory(directory: Directory): SubfsDirectory {
	return {
		...(directory.$type && { $type: 'place.wisp.subfs#directory' as const }),
		type: 'directory',
		entries: directory.entries.map(toSubfsEntry),
	}
}

function toSubfsEntry(entry: Entry): SubfsEntry {
	return {
		...(entry.$type && { $type: 'place.wisp.subfs#entry' as const }),
		name: entry.name,
		node: toSubfsNode(entry.node),
	}
}

function toSubfsNode(node: Entry['node']): SubfsEntry['node'] {
	if (!isKnownNode(node)) {
		return node
	}

	if (node.type === 'directory') {
		return toTypedSubfsDirectory(node)
	}

	if (node.type === 'file') {
		const file: $Typed<SubfsFile, 'place.wisp.subfs#file'> = {
			$type: 'place.wisp.subfs#file',
			type: 'file',
			blob: node.blob,
			encoding: node.encoding,
			mimeType: node.mimeType,
			base64: node.base64,
		}
		return file
	}

	const subfs: $Typed<NestedSubfs, 'place.wisp.subfs#subfs'> = {
		$type: 'place.wisp.subfs#subfs',
		type: 'subfs',
		subject: node.subject,
	}
	return subfs
}
