/**
 * Main app logger using @wispplace/observability
 *
 * Note: This file is kept for backward compatibility.
 * New code should import createLogger from @wispplace/observability directly.
 */
import { createLogger } from '@wispplace/observability'

export const logger = createLogger('main-app')
