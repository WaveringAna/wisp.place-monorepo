/**
 * Runtime detection utilities for cross-platform compatibility
 */

declare const Bun: unknown;

export const isBun = typeof Bun !== 'undefined';
export const isNode = typeof process !== 'undefined' && !isBun;

/**
 * Get the current runtime name for logging
 */
export function getRuntimeName(): string {
  if (isBun) return 'Bun';
  if (isNode) return 'Node.js';
  return 'Unknown';
}
