interface UploadPathSource {
	name: string
	webkitRelativePath?: string
}

const sourcePath = (file: UploadPathSource) => file.webkitRelativePath || file.name

/** The folder every file sits in when a single directory was picked or dropped, else null. */
export function uploadRoot(files: readonly UploadPathSource[]): string | null {
	const paths = files.map(sourcePath)
	const firstSeparator = paths[0]?.indexOf('/') ?? -1
	if (firstSeparator < 1) return null
	const root = paths[0]!.slice(0, firstSeparator + 1)
	return paths.every((path) => path.startsWith(root)) ? root.slice(0, -1) : null
}

/** Paths relative to the picked folder, so its contents land at the site root. */
export function rootedUploadPaths(files: readonly UploadPathSource[]): string[] {
	const paths = files.map(sourcePath)
	const root = uploadRoot(files)
	return root === null ? paths : paths.map((path) => path.slice(root.length + 1))
}
