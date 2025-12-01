import ignore, { type Ignore } from 'ignore'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

interface IgnoreConfig {
    version: string
    description: string
    patterns: string[]
}

/**
 * Load default ignore patterns from the .wispignore.json file in the monorepo root
 */
function loadDefaultPatterns(): string[] {
    try {
        // Path to the default ignore patterns JSON file (monorepo root, 3 levels up from this file)
        const defaultJsonPath = join(__dirname, '../../../../.wispignore.json')

        if (!existsSync(defaultJsonPath)) {
            console.warn('⚠️  Default .wispignore.json not found, using hardcoded patterns')
            return getHardcodedPatterns()
        }

        const contents = readFileSync(defaultJsonPath, 'utf-8')
        const config: IgnoreConfig = JSON.parse(contents)
        return config.patterns
    } catch (error) {
        console.error('Failed to load default ignore patterns:', error)
        return getHardcodedPatterns()
    }
}

/**
 * Hardcoded fallback patterns (same as in .wispignore.json)
 */
function getHardcodedPatterns(): string[] {
    return [
        '.git',
        '.git/**',
        '.github',
        '.github/**',
        '.gitlab',
        '.gitlab/**',
        '.DS_Store',
        '.wisp.metadata.json',
        '.env',
        '.env.*',
        'node_modules',
        'node_modules/**',
        'Thumbs.db',
        'desktop.ini',
        '._*',
        '.Spotlight-V100',
        '.Spotlight-V100/**',
        '.Trashes',
        '.Trashes/**',
        '.fseventsd',
        '.fseventsd/**',
        '.cache',
        '.cache/**',
        '.temp',
        '.temp/**',
        '.tmp',
        '.tmp/**',
        '__pycache__',
        '__pycache__/**',
        '*.pyc',
        '.venv',
        '.venv/**',
        'venv',
        'venv/**',
        'env',
        'env/**',
        '*.swp',
        '*.swo',
        '*~',
        '.tangled',
        '.tangled/**',
    ]
}

/**
 * Load custom ignore patterns from a .wispignore file
 * @param wispignoreContent - Content of the .wispignore file (one pattern per line)
 */
function loadWispignorePatterns(wispignoreContent: string): string[] {
    return wispignoreContent
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')) // Skip empty lines and comments
}

/**
 * Create an ignore matcher
 * @param customPatterns - Optional custom patterns from a .wispignore file
 */
export function createIgnoreMatcher(customPatterns?: string[]): Ignore {
    const ig = ignore()

    // Add default patterns
    const defaultPatterns = loadDefaultPatterns()
    ig.add(defaultPatterns)

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
