import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SiteMetadata {
	recordCid: string
	fileCids: Record<string, string> // path -> blob CID
	lastSync: number // Unix timestamp
}

const METADATA_FILE = '.wisp-metadata.json'

export function getMetadataPath(siteDir: string): string {
	return join(siteDir, METADATA_FILE)
}

export function loadMetadata(siteDir: string): SiteMetadata | null {
	const path = getMetadataPath(siteDir)
	if (!existsSync(path)) {
		return null
	}
	try {
		const content = readFileSync(path, 'utf-8')
		return JSON.parse(content) as SiteMetadata
	} catch {
		return null
	}
}

export function saveMetadata(siteDir: string, metadata: SiteMetadata): void {
	const path = getMetadataPath(siteDir)
	writeFileSync(path, JSON.stringify(metadata, null, 2))
}
