/**
 * Main app logger using @wisp/observability
 *
 * Note: This file is kept for backward compatibility.
 * New code should import createLogger from @wisp/observability directly.
 */
import { createLogger } from '@wisp/observability'

export const logger = createLogger('main-app')
