import { DEFAULT_IGNORE_PATTERNS } from '@wispplace/constants'
import ignore, { type Ignore } from 'ignore'

/**
 * Load custom ignore patterns from a .wispignore file
 * @param wispignoreContent - Content of the .wispignore file (one pattern per line)
 */
function loadWispignorePatterns(wispignoreContent: string): string[] {
	return wispignoreContent
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#')) // Skip empty lines and comments
}

/**
 * Create an ignore matcher
 * @param customPatterns - Optional custom patterns from a .wispignore file
 */
export function createIgnoreMatcher(customPatterns?: string[]): Ignore {
	const ig = ignore()

	ig.add(DEFAULT_IGNORE_PATTERNS)

	// Add custom patterns if provided
	if (customPatterns && customPatterns.length > 0) {
		ig.add(customPatterns)
		console.log(`Loaded ${customPatterns.length} custom patterns from .wispignore`)
	}

	return ig
}

/**
 * Check if a file path should be ignored
 * @param matcher - The ignore matcher
 * @param filePath - The file path to check (relative to site root)
 */
export function shouldIgnore(matcher: Ignore, filePath: string): boolean {
	return matcher.ignores(filePath)
}

/**
 * Parse .wispignore content and return patterns
 */
export function parseWispignore(content: string): string[] {
	return loadWispignorePatterns(content)
}
