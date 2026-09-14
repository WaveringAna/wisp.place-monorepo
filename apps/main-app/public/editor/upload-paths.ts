interface UploadPathSource {
	name: string
	webkitRelativePath?: string
}

export function rootedUploadPaths(files: readonly UploadPathSource[]): string[] {
	const paths = files.map((file) => file.webkitRelativePath || file.name)
	const firstSeparator = paths[0]?.indexOf('/') ?? -1
	if (firstSeparator < 1) return paths

	const root = paths[0]!.slice(0, firstSeparator + 1)
	return paths.every((path) => path.startsWith(root)) ? paths.map((path) => path.slice(root.length)) : paths
}
