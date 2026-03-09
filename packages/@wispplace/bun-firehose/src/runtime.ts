/**
 * Runtime detection utilities for cross-platform compatibility
 */
declare const Bun: unknown
declare const Deno: unknown

export const isBun = typeof Bun !== 'undefined'
export const isDeno = typeof Deno !== 'undefined'
export const isNode = typeof process !== 'undefined' && !isBun && !isDeno

/**
 * Get the current runtime name for logging
 */
export function getRuntimeName(): string {
	if (isBun) return 'Bun'
	if (isDeno) return 'Deno'
	if (isNode) return 'Node.js'
	return 'Unknown'
}
